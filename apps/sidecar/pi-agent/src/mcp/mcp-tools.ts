/**
 * MCP 网关工具（代理模式）：一个 `mcp` 工具覆盖全部服务器的工具面。
 * 没有任何启用服务器时 buildTools 不注入本工具（避免模型白调一次才拿到
 * 空清单）；服务器启停/增删后由协议层重建活会话工具表。有启用服务器时
 * 工具表保持字节级稳定（提示词前缀缓存的前提）。
 *
 * 动作：
 * - search  按关键词在工具索引里找工具（不连接，断连可用），带权重排名
 * - describe 看单个工具的完整 schema（调用前确认参数）
 * - call    执行：懒连接 → 白名单校验 → 审批（完全访问档放行 / 审批级别放行 /
 *           approveTools glob 豁免 / 本机清单豁免）→ 调用 → 输出防护
 * - status  各服务器连接状态
 *
 * 工具全名约定 `<server>__<tool>`：search 结果即返回全名，describe/call 接受全名。
 * 解析不是朴素 split（名字里可含下划线），而是对已知服务器集合做最长前缀匹配。
 *
 * 审批回路与 Question 同构（question-tools.ts）：execute 内挂起 Promise →
 * sendEventChunk 推 data-toolApproval chunk（复用前端既有审批卡）→ protocol 的
 * tool_confirm 结算（先 run 内审批、回退本模块挂起表）→ 放行或拦截。
 */
import { lit, map, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sendEventChunk } from "../protocol/stream";
import {
  beginInteraction,
  sessionForThread,
  settleInteraction,
} from "../sessions/pending-interactions";
import {
  activeMcpServers,
  loadMcpServers,
  loadMcpServersSync,
  type McpServerDef,
} from "./mcp-config";
import {
  getValidServerMeta,
  getValidTools,
  type McpServerMeta,
  type McpToolMeta,
} from "./mcp-cache";
import { shouldUseTask } from "./mcp-tasks";
import { getMcpTask } from "./mcp-task-store";
import type { ApprovalLevel } from "../types";
import { mcpManager } from "./mcp-manager";
import {
  boundMcpResult,
  guardMcpText,
  splitMcpContent,
  splitResourceContents,
  type McpCallResult,
} from "./mcp-output-guard";
import { getAutomationPolicy } from "../automation/policy";
import { loadWriteRoots, rememberMcpTool } from "../permissions/write-roots";
import {
  autoReviewDenyReason,
  runAutoReview,
  type ReviewSessionFacts,
} from "../permissions/auto-review";
import { logAt, logErr } from "../log";

/** search 返回条数上限（与 grep 的 MAX_MATCH_ENTRIES 同哲学：有界） */
const SEARCH_LIMIT_DEFAULT = 12;
const SEARCH_LIMIT_MAX = 40;
/** resources/prompts 列表上限（网关结果直接进模型上下文） */
const CAPABILITY_LIMIT_DEFAULT = 20;
const CAPABILITY_LIMIT_MAX = 100;

// ---------------------------------------------------------------------------
// 全名解析与审批 glob
// ---------------------------------------------------------------------------

/** 工具全名 <server>__<tool> */
export function mcpToolFullName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

/**
 * 全名 → (server, tool)。名字可含下划线，朴素 split 有歧义；对已知服务器集合
 * 做最长前缀匹配（server 名本身经 NAME_RE 约束，不会包含 "__"）。
 */
export function parseMcpToolFullName(
  fullName: string,
  serverNames: readonly string[],
): { server: string; tool: string } | null {
  const candidates = serverNames
    .filter((s) => fullName.startsWith(`${s}__`))
    .sort((a, b) => b.length - a.length);
  const server = candidates[0];
  if (!server) return null;
  const tool = fullName.slice(server.length + 2);
  if (!tool) return null;
  return { server, tool };
}

/** approveTools 的 glob → 正则（只支持 * 与 ?，大小写不敏感） */
export function globToRegExpLoose(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** 服务器 approveTools 是否放行该工具（同时匹配全名与裸名，大小写不敏感） */
export function isToolApprovedBy(def: McpServerDef, toolName: string): boolean {
  if (!def.approveTools?.length) return false;
  const bare = toolName.startsWith(`${def.name}__`)
    ? toolName.slice(def.name.length + 2)
    : toolName;
  const candidates = bare === toolName ? [toolName, mcpToolFullName(def.name, toolName)] : [toolName, bare];
  return def.approveTools.some((glob) => {
    const re = globToRegExpLoose(glob);
    return candidates.some((c) => re.test(c));
  });
}

// ---------------------------------------------------------------------------
// 搜索排名（字段加权：名 12 / 服务器 8 / 描述 5；完整>前缀>包含）
// ---------------------------------------------------------------------------

export type ToolIndexEntry = { server: string; def: McpServerDef; tool: McpToolMeta };

const FIELD_WEIGHTS: Array<{ get: (t: ToolIndexEntry) => string; weight: number }> = [
  { get: (t) => t.tool.name, weight: 12 },
  { get: (t) => t.server, weight: 8 },
  { get: (t) => t.tool.description ?? "", weight: 5 },
];

export function scoreToolEntry(entry: ToolIndexEntry, query: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  let score = 0;
  let matched = false;
  for (const { get, weight } of FIELD_WEIGHTS) {
    const value = get(entry).toLowerCase();
    if (!value) continue;
    if (value === q) {
      score += weight * 10;
      matched = true;
    } else if (value.startsWith(q)) {
      score += weight * 6;
      matched = true;
    } else if (value.includes(q)) {
      score += weight * 3;
      matched = true;
    }
  }
  if (!matched) return null;
  // 全名命中加分（server__tool 整体包含查询）
  if (mcpToolFullName(entry.server, entry.tool.name).toLowerCase().includes(q)) score += 4;
  return score;
}

/** 汇集启用服务器的工具索引（已连接用池内实时清单，未连接用元数据缓存）。
 *  allowedServers 非空时索引只收白名单内的服务器——子代理的作用域网关靠它收窄。 */
async function buildToolIndex(
  cwd: string | undefined,
  allowedServers?: readonly string[],
): Promise<ToolIndexEntry[]> {
  const allowed = allowedServers?.length ? new Set(allowedServers) : undefined;
  const defs = await activeMcpServers(cwd);
  const index: ToolIndexEntry[] = [];
  for (const def of defs) {
    if (allowed && !allowed.has(def.name)) continue;
    const tools = mcpManager.getLiveTools(def) ?? getValidTools(def) ?? [];
    for (const tool of tools) {
      index.push({ server: def.name, def, tool });
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// 审批挂起（模块级表，照抄 question-tools 形态）
// ---------------------------------------------------------------------------

type PendingMcpApproval = {
  threadId: string;
  resolve: (decision: { approved: boolean; remember: boolean }) => void;
};
const pendingMcpApprovals = new Map<string, PendingMcpApproval>();

/**
 * protocol tool_confirm 的回退结算：返回是否存在。
 *
 * remember 只在批准时有意义，且落盘失败**不能让这次调用失败**——用户批准的是
 * 「执行」，记住只是附带的账（与 modes.ts 逐工具审批同一处理）。
 */
export function resolveMcpApproval(
  approvalId: string,
  approved: boolean,
  remember = false,
): boolean {
  const pending = pendingMcpApprovals.get(approvalId);
  if (!pending) return false;
  pendingMcpApprovals.delete(approvalId);
  settleInteraction(approvalId, approved ? "approved" : "denied");
  pending.resolve({ approved, remember: approved && remember });
  return true;
}

/** 用户 Stop / 新 prompt 的兜底清理：按拒绝结算，防 execute 永久挂起 */
export function cancelPendingMcpApprovals(threadId: string): void {
  for (const [id, entry] of [...pendingMcpApprovals]) {
    if (entry.threadId !== threadId) continue;
    pendingMcpApprovals.delete(id);
    settleInteraction(id, "cancelled");
    entry.resolve({ approved: false, remember: false });
  }
}

/** 测试钩子：挂起表规模 */
export const pendingMcpApprovalCount = () => pendingMcpApprovals.size;

/** 测试钩子：指定审批是否仍在挂起 */
export const hasPendingMcpApproval = (approvalId: string) =>
  pendingMcpApprovals.has(approvalId);

// ---------------------------------------------------------------------------
// 网关工具
// ---------------------------------------------------------------------------

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export async function findServerDef(
  cwd: string | undefined,
  serverName: string,
): Promise<McpServerDef | null> {
  const defs = await activeMcpServers(cwd);
  return defs.find((d) => d.name === serverName) ?? null;
}

/**
 * 网关的作用域选项。allowedServers 非空即"白名单网关"——只暴露列出的服务器，
 * 其余一律拒绝。主代理侧不传（等价于无限制，保持既有行为）。
 */
export type McpToolScope = {
  /** 白名单服务器名；空/缺省 = 不限制 */
  allowedServers?: readonly string[];
  /** 白名单里当前并不存在的服务器名——出现在拒绝文案里，帮模型自我纠正 */
  allowedNames?: readonly string[];
};

export function buildMcpTool(
  cwd: string,
  threadId: string,
  scope?: McpToolScope,
  /**
   * 当前会话的审批档位。传闭包而非取值：档位可在会话中途改（`set_mode`），
   * 闭包在 execute 运行时才解引用 `run`，天然读到最新值——一份快照会漂移，
   * 而漂移的方向恰恰是权限被静默放宽。
   *
   * 缺省视为 `ask`（逐次审批）：宁可多问，不默认放行。
   */
  getApprovalLevel?: () => ApprovalLevel,
  /**
   * AI 审查档（review）所需的会话事实（闭包，运行期才解引用 run）：档位与模型
   * 都可在会话中途改，传值会漂。缺省 = 审查拿不到模型 → 落到审批卡。
   */
  getReviewFacts?: () => ReviewSessionFacts,
): AgentTool {
  // 会话装配预连：eager 服务器后台握手（fire-and-forget，不阻塞装配；
  // 失败由连接池落退避/日志/审计，lazy 服务器维持首调才连）
  void activeMcpServers(cwd)
    .then((defs) => mcpManager.prewarm(defs))
    .catch(() => {});
  const scoped = scope?.allowedServers?.length ? scope.allowedServers : undefined;
  return {
    name: "mcp",
    label: "MCP",
    description: [
      "Use tools and context from configured MCP servers (external integrations: databases, browsers, SaaS APIs). " +
        'Workflow: mcp({ action: "search", query: "..." }) to discover tools (returns full names like `server__tool`), ' +
        'mcp({ action: "describe", tool: "server__tool" }) to check parameters, ' +
        'then mcp({ action: "call", tool: "server__tool", args: "{...}" }) to execute. ' +
        "args is a JSON object serialized as a string. " +
        'mcp({ action: "resources", server: "..." }) lists resource URIs, and mcp({ action: "resource_read", server: "...", uri: "..." }) reads one. ' +
        'mcp({ action: "prompts", server: "..." }) lists server prompts, and mcp({ action: "prompt_get", server: "...", prompt: "...", args: "{...}" }) renders one. ' +
        'mcp({ action: "status" }) lists configured servers and their connection state.',
      scoped
        ? `Scope: you may ONLY use these servers: ${scoped.join(", ")}. Calls to any other server are rejected before they run — search, resources, prompts and status are filtered to this list too.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    parameters: obj({
      action: union([
        lit("search"),
        lit("describe"),
        lit("call"),
        lit("status"),
        lit("resources"),
        lit("resource_read"),
        lit("prompts"),
        lit("prompt_get"),
        lit("task_status"),
        lit("task_result"),
        lit("task_cancel"),
      ]),
      taskId: opt(
        str({
          description:
            "task_status/task_result/task_cancel: taskId from a pending task call result",
        }),
      ),
      query: opt(
        str({
          description:
            "search/resources/prompts: keywords to filter results (name, server, description or URI)",
        }),
      ),
      tool: opt(
        str({
          description: "describe/call: full tool name `server__tool` from search results",
        }),
      ),
      server: opt(
        str({
          description:
            "resources/resource_read/prompts/prompt_get: MCP server name; omit to list across all servers",
        }),
      ),
      uri: opt(
        str({
          description: "resource_read: resource URI from mcp({ action: \"resources\" })",
        }),
      ),
      prompt: opt(
        str({
          description: "prompt_get: prompt name from mcp({ action: \"prompts\" })",
        }),
      ),
      args: opt(
        str({
          description:
            'call/prompt_get: JSON object string, e.g. "{\\"text\\": \\"hi\\"}" or "{\\"topic\\": \\"MCP\\"}"',
        }),
      ),
      limit: opt(
        num({
          description: `search/resources/prompts: max results (default ${SEARCH_LIMIT_DEFAULT}/${CAPABILITY_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}/${CAPABILITY_LIMIT_MAX})`,
        }),
      ),
    }),
    execute: async (toolCallId, raw, signal) => {
      const params = raw as {
        action?: string;
        query?: string;
        tool?: string;
        server?: string;
        uri?: string;
        prompt?: string;
        args?: string;
        limit?: number;
      };
      switch (params.action) {
        case "search":
          return executeSearch(cwd, params, scope?.allowedServers);
        case "describe":
          return executeDescribe(cwd, params, scope?.allowedServers);
        case "call":
          return executeCall(
            cwd,
            threadId,
            toolCallId,
            params,
            signal,
            scope,
            getApprovalLevel,
            getReviewFacts,
          );
        case "status":
          return executeStatus(cwd, scope?.allowedServers);
        case "resources":
          return executeResources(cwd, params, scope?.allowedServers);
        case "resource_read":
          return executeResourceRead(
            cwd,
            threadId,
            params,
            signal,
            scope?.allowedServers,
          );
        case "prompts":
          return executePrompts(cwd, params, scope?.allowedServers);
        case "prompt_get":
          return executePromptGet(
            cwd,
            threadId,
            params,
            signal,
            scope?.allowedServers,
          );
        case "task_status":
          return executeTaskQuery(cwd, threadId, params, signal, "status");
        case "task_result":
          return executeTaskQuery(cwd, threadId, params, signal, "result");
        case "task_cancel":
          return executeTaskQuery(cwd, threadId, params, signal, "cancel");
        default:
          return textResult(`unknown action: ${String(params.action)}`);
      }
    },
  };
}

async function executeSearch(
  cwd: string,
  params: { query?: string; limit?: number },
  allowedServers?: readonly string[],
) {
  const query = String(params.query ?? "").trim();
  if (!query) {
    return textResult("query is required for search");
  }
  const index = await buildToolIndex(cwd, allowedServers);
  if (index.length === 0) {
    return textResult(
      allowedServers?.length
        ? `No tools available on the MCP servers this agent may use (${allowedServers.join(", ")}). They may be disabled, unconfigured, or not yet connected (connect happens on first call; ask the user to check Settings → MCP).`
        : "No MCP tools available. Servers may be disabled, unconfigured, or not yet connected " +
          "(connect happens on first call; ask the user to check Settings → MCP).",
      { total: 0 },
    );
  }
  const limit = Math.min(
    Math.max(Math.trunc(Number(params.limit ?? SEARCH_LIMIT_DEFAULT)) || SEARCH_LIMIT_DEFAULT, 1),
    SEARCH_LIMIT_MAX,
  );
  const scored = index
    .map((entry) => ({ entry, score: scoreToolEntry(entry, query) }))
    .filter((x): x is { entry: ToolIndexEntry; score: number } => x.score !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.server.localeCompare(b.entry.server) ||
        a.entry.tool.name.localeCompare(b.entry.tool.name),
    )
    .slice(0, limit);
  if (scored.length === 0) {
    return textResult(`No MCP tools match "${query}".`, { total: index.length });
  }
  const lines = scored.map(
    ({ entry, score }) =>
      `${mcpToolFullName(entry.server, entry.tool.name)} (score ${score})\n  ${entry.tool.description ?? "(no description)"}`,
  );
  return textResult(lines.join("\n"), {
    total: index.length,
    matched: scored.length,
    names: scored.map(({ entry }) => mcpToolFullName(entry.server, entry.tool.name)),
  });
}

async function executeDescribe(
  cwd: string,
  params: { tool?: string },
  allowedServers?: readonly string[],
) {
  const fullName = String(params.tool ?? "").trim();
  if (!fullName) return textResult("tool is required for describe (full name `server__tool`)");
  const index = await buildToolIndex(cwd, allowedServers);
  const hit = index.find((entry) => mcpToolFullName(entry.server, entry.tool.name) === fullName);
  if (!hit) {
    return textResult(
      `Unknown MCP tool "${fullName}". Use mcp({ action: "search" }) to list available tools.`,
    );
  }
  return textResult(
    [
      fullName,
      hit.tool.description ?? "(no description)",
      hit.tool.inputSchema
        ? `Parameters (JSON Schema):\n${JSON.stringify(hit.tool.inputSchema, null, 2)}`
        : "Parameters: (none declared)",
    ].join("\n"),
    { server: hit.server, tool: hit.tool.name },
  );
}

// ---------------------------------------------------------------------------
// resources / prompts（M1.2）
// ---------------------------------------------------------------------------

type CapabilityParams = { query?: string; server?: string; limit?: number };

function capabilityLimit(value: unknown): number {
  const raw = Number(value ?? CAPABILITY_LIMIT_DEFAULT);
  const n = Number.isFinite(raw) ? Math.trunc(raw) : CAPABILITY_LIMIT_DEFAULT;
  return Math.min(Math.max(n, 1), CAPABILITY_LIMIT_MAX);
}

/** 展示/审计里的 URI 去掉 query/hash（可能带签名 token），并限长 */
function displayUri(uri: string): string {
  return (uri.split(/[?#]/, 1)[0] ?? uri).slice(0, 500);
}

function matchesQuery(query: string, fields: ReadonlyArray<string | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(q));
}

async function scopedServers(
  cwd: string,
  allowedServers?: readonly string[],
): Promise<McpServerDef[]> {
  const defs = await activeMcpServers(cwd);
  if (!allowedServers?.length) return defs;
  const allowed = new Set(allowedServers);
  return defs.filter((def) => allowed.has(def.name));
}

/**
 * resource_read / prompt_get 的服务器解析：显式 server 必须存在且在作用域内；
 * 省略时只有一台候选才自动选中（避免把“读哪个服务器的资源”猜错）。
 */
async function resolveCapabilityServer(
  cwd: string,
  requested: string | undefined,
  allowedServers?: readonly string[],
): Promise<{ def: McpServerDef } | { error: string }> {
  const name = requested?.trim();
  const defs = await scopedServers(cwd, allowedServers);
  if (name) {
    if (allowedServers?.length && !allowedServers.includes(name)) {
      const usable = allowedServers.join(", ");
      return {
        error: `You are not allowed to use the MCP server "${name}". This agent may only use: ${usable}.`,
      };
    }
    const def = defs.find((d) => d.name === name);
    if (!def) {
      return {
        error: `MCP server "${name}" is disabled or unconfigured. Ask the user to check Settings → MCP.`,
      };
    }
    return { def };
  }
  if (defs.length === 1) return { def: defs[0]! };
  if (defs.length === 0) {
    return {
      error:
        "No MCP servers are enabled. Ask the user to check Settings → MCP, or pass no server after enabling one.",
    };
  }
  return {
    error: `server is required (enabled: ${defs.map((d) => d.name).join(", ")})`,
  };
}

/** 实时元数据优先，其次磁盘缓存；显式单服务器请求可以懒连接补齐 */
async function capabilityMeta(
  def: McpServerDef,
  ensureConnected: boolean,
): Promise<McpServerMeta | null> {
  const live = mcpManager.getLiveServerMeta(def);
  if (live) return live;
  const cached = getValidServerMeta(def);
  if (cached) return cached;
  if (!ensureConnected) return null;
  await mcpManager.ensureConnected(def);
  return mcpManager.getLiveServerMeta(def);
}

async function executeResources(
  cwd: string,
  params: CapabilityParams,
  allowedServers?: readonly string[],
) {
  const limit = capabilityLimit(params.limit);
  const query = String(params.query ?? "").trim();
  const requested = params.server?.trim();
  let defs = await scopedServers(cwd, allowedServers);

  if (requested) {
    const resolved = await resolveCapabilityServer(cwd, requested, allowedServers);
    if ("error" in resolved) return textResult(resolved.error);
    defs = [resolved.def];
  }
  if (defs.length === 0) {
    return textResult(
      "No MCP servers are enabled. Ask the user to check Settings → MCP.",
      { total: 0 },
    );
  }

  const lines: string[] = [];
  const pending: string[] = [];
  let total = 0;
  let shown = 0;
  for (const def of defs) {
    const meta = await capabilityMeta(def, Boolean(requested));
    if (!meta || !meta.capabilities.resources) {
      if (!meta) pending.push(def.name);
      continue;
    }
    for (const resource of meta.resources) {
      if (!matchesQuery(query, [resource.name, resource.title, resource.description, resource.uri])) {
        continue;
      }
      total += 1;
      if (shown >= limit) continue;
      lines.push(
        `${def.name}: ${resource.title || resource.name} — ${displayUri(resource.uri)}` +
          `${resource.mimeType ? ` (${resource.mimeType})` : ""}` +
          `${resource.description ? `\n  ${resource.description}` : ""}`,
      );
      shown += 1;
    }
    for (const template of meta.resourceTemplates) {
      if (
        !matchesQuery(query, [
          template.name,
          template.title,
          template.description,
          template.uriTemplate,
        ])
      ) {
        continue;
      }
      total += 1;
      if (shown >= limit) continue;
      lines.push(
        `${def.name}: [template] ${template.title || template.name} — ${displayUri(template.uriTemplate)}` +
          `${template.mimeType ? ` (${template.mimeType})` : ""}` +
          `${template.description ? `\n  ${template.description}` : ""}`,
      );
      shown += 1;
    }
  }

  if (lines.length === 0) {
    const hint = pending.length
      ? ` Not connected/cached yet: ${pending.join(", ")}. Call mcp({ action: "resources", server: "<name>" }) to connect one.`
      : "";
    return textResult(
      query
        ? `No MCP resources match "${query}".${hint}`
        : `No MCP resources available.${hint}`,
      { total: 0, pending },
    );
  }
  return textResult(
    [
      ...lines,
      total > shown ? `\n[还有 ${total - shown} 项未显示；用 query/limit 缩小范围]` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    { total, shown, servers: defs.map((d) => d.name) },
  );
}

async function executeResourceRead(
  cwd: string,
  threadId: string,
  params: { server?: string; uri?: string },
  signal: AbortSignal | undefined,
  allowedServers?: readonly string[],
) {
  const uri = String(params.uri ?? "").trim();
  if (!uri) {
    return textResult(
      'uri is required for resource_read. Use mcp({ action: "resources" }) to list URIs.',
    );
  }
  const resolved = await resolveCapabilityServer(cwd, params.server, allowedServers);
  if ("error" in resolved) return textResult(resolved.error);
  const def = resolved.def;
  try {
    const meta = await capabilityMeta(def, true);
    if (!meta?.capabilities.resources) {
      return textResult(`MCP server "${def.name}" does not declare resources.`, {
        server: def.name,
        uri: displayUri(uri),
        isError: true,
      });
    }
    const sessionId = sessionForThread(threadId);
    const raw = await mcpManager.readResource(def, uri, signal, {
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
    const { text, images } = splitResourceContents(raw);
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [];
    if (text.trim() || images.length === 0) {
      content.push({ type: "text", text: text || "(empty resource)" });
    }
    for (const image of images) content.push({ type: "image", ...image });
    return {
      content,
      details: {
        server: def.name,
        uri: displayUri(uri),
        contents: Array.isArray((raw as { contents?: unknown[] })?.contents)
          ? (raw as { contents: unknown[] }).contents.length
          : 0,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`mcp resource ${def.name} ${displayUri(uri)}:`, message);
    return textResult(`MCP resource read failed: ${message}`, {
      server: def.name,
      uri: displayUri(uri),
      isError: true,
    });
  }
}

async function executePrompts(
  cwd: string,
  params: CapabilityParams,
  allowedServers?: readonly string[],
) {
  const limit = capabilityLimit(params.limit);
  const query = String(params.query ?? "").trim();
  const requested = params.server?.trim();
  let defs = await scopedServers(cwd, allowedServers);

  if (requested) {
    const resolved = await resolveCapabilityServer(cwd, requested, allowedServers);
    if ("error" in resolved) return textResult(resolved.error);
    defs = [resolved.def];
  }
  if (defs.length === 0) {
    return textResult(
      "No MCP servers are enabled. Ask the user to check Settings → MCP.",
      { total: 0 },
    );
  }

  const lines: string[] = [];
  const pending: string[] = [];
  let total = 0;
  let shown = 0;
  for (const def of defs) {
    const meta = await capabilityMeta(def, Boolean(requested));
    if (!meta || !meta.capabilities.prompts) {
      if (!meta) pending.push(def.name);
      continue;
    }
    for (const prompt of meta.prompts) {
      if (!matchesQuery(query, [prompt.name, prompt.title, prompt.description])) continue;
      total += 1;
      if (shown >= limit) continue;
      const args = (prompt.arguments ?? [])
        .map((arg) => `${arg.name}${arg.required ? "*" : ""}`)
        .join(", ");
      lines.push(
        `${def.name}: ${prompt.title || prompt.name}` +
          `${args ? ` (${args})` : ""}` +
          `${prompt.description ? `\n  ${prompt.description}` : ""}`,
      );
      shown += 1;
    }
  }

  if (lines.length === 0) {
    const hint = pending.length
      ? ` Not connected/cached yet: ${pending.join(", ")}. Call mcp({ action: "prompts", server: "<name>" }) to connect one.`
      : "";
    return textResult(
      query ? `No MCP prompts match "${query}".${hint}` : `No MCP prompts available.${hint}`,
      { total: 0, pending },
    );
  }
  return textResult(
    [
      ...lines,
      total > shown ? `\n[还有 ${total - shown} 项未显示；用 query/limit 缩小范围]` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    { total, shown, servers: defs.map((d) => d.name) },
  );
}

function parsePromptArgs(
  raw: string | undefined,
): { ok: true; args: Record<string, string> } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `args is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'args must be a JSON object string, e.g. \'{"topic":"MCP"}\'' };
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else {
      return { ok: false, error: `args.${key} must be a string, number or boolean` };
    }
  }
  return { ok: true, args: out };
}

/**
 * task_status / task_result / task_cancel：对 pending task 的后续操作。
 * taskId 必须是本 thread 之前发起的（台账校验），防止跨 thread 干扰。
 */
async function executeTaskQuery(
  cwd: string,
  threadId: string,
  params: { server?: string; taskId?: string },
  signal: AbortSignal | undefined,
  op: "status" | "result" | "cancel",
) {
  const taskId = String(params.taskId ?? "").trim();
  if (!taskId) {
    return textResult(
      `taskId is required for task_${op}. Use the taskId from a pending task call result.`,
    );
  }
  const resolved = await resolveCapabilityServer(cwd, params.server, undefined);
  if ("error" in resolved) return textResult(resolved.error);
  const def = resolved.def;
  const record = getMcpTask(def.name, taskId);
  if (!record || record.threadId !== threadId) {
    return textResult(
      `Unknown MCP task "${taskId}" for this conversation` +
        (record ? " (it belongs to another conversation)." : "."),
      { server: def.name, taskId, isError: true },
    );
  }
  try {
    if (op === "status") {
      const status = await mcpManager.taskStatus(def, taskId, signal);
      if (!status.ok) {
        return textResult(`MCP task status failed: ${status.message}`, {
          server: def.name,
          taskId,
          isError: true,
        });
      }
      const lines = [
        `Task ${taskId} (${record.tool}): ${status.task.status}`,
        status.task.statusMessage ? `statusMessage: ${status.task.statusMessage}` : "",
        status.task.status === "completed"
          ? 'Fetch the result with mcp({ action: "task_result", server: "' + def.name + '", taskId: "' + taskId + '" }).'
          : "",
      ].filter(Boolean);
      return textResult(lines.join("\n"), {
        server: def.name,
        taskId,
        status: status.task.status,
        ...(status.task.statusMessage ? { message: status.task.statusMessage } : {}),
      });
    }
    if (op === "result") {
      const result = await mcpManager.taskResult(def, taskId, signal);
      if (!result.ok) {
        return textResult(`MCP task result failed: ${result.message}`, {
          server: def.name,
          taskId,
          isError: true,
        });
      }
      const { summary, result: bounded } = boundMcpResult(result.result as McpCallResult);
      const { text, images } = splitMcpContent(
        bounded?.content ?? (result.result as McpCallResult)?.content ?? "",
      );
      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];
      if (text.trim() || images.length === 0) {
        content.push({ type: "text", text: text || "(empty result)" });
      }
      for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      return {
        content,
        details: {
          server: def.name,
          taskId,
          tool: record.tool,
          task: true,
          ...(summary ? { summary } : {}),
          ...(bounded && bounded !== result.result
            ? { structuredContent: bounded.structuredContent ?? null }
            : {}),
        },
      };
    }
    const cancel = await mcpManager.taskCancel(def, taskId, signal);
    if (!cancel.ok) {
      return textResult(`MCP task cancel failed: ${cancel.message ?? "unknown error"}`, {
        server: def.name,
        taskId,
        isError: true,
      });
    }
    return textResult(`Task ${taskId} cancelled.`, {
      server: def.name,
      taskId,
      cancelled: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`mcp task ${op} ${def.name}/${taskId}:`, message);
    return textResult(`MCP task ${op} failed: ${message}`, {
      server: def.name,
      taskId,
      isError: true,
    });
  }
}

async function executePromptGet(
  cwd: string,
  threadId: string,
  params: { server?: string; prompt?: string; args?: string },
  signal: AbortSignal | undefined,
  allowedServers?: readonly string[],
) {
  const name = String(params.prompt ?? "").trim();
  if (!name) {
    return textResult(
      'prompt is required for prompt_get. Use mcp({ action: "prompts" }) to list prompt names.',
    );
  }
  const args = parsePromptArgs(params.args);
  if (!args.ok) return textResult(args.error);
  const resolved = await resolveCapabilityServer(cwd, params.server, allowedServers);
  if ("error" in resolved) return textResult(resolved.error);
  const def = resolved.def;
  try {
    const meta = await capabilityMeta(def, true);
    if (!meta?.capabilities.prompts) {
      return textResult(`MCP server "${def.name}" does not declare prompts.`, {
        server: def.name,
        prompt: name,
        isError: true,
      });
    }
    const sessionId = sessionForThread(threadId);
    const raw = await mcpManager.getPrompt(def, name, args.args, signal, {
      threadId,
      ...(sessionId ? { sessionId } : {}),
    });
    const result = raw as {
      description?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const messages = Array.isArray(result.messages) ? result.messages : [];
    const parts: string[] = [];
    if (result.description) parts.push(result.description);
    const images: Array<{ data: string; mimeType: string }> = [];
    for (const message of messages) {
      const content =
        message.content == null
          ? []
          : Array.isArray(message.content)
            ? message.content
            : [message.content];
      const split = splitMcpContent(content);
      if (split.text.trim()) {
        parts.push(`[${message.role ?? "user"}]\n${split.text}`);
      }
      images.push(...split.images);
    }
    const text = guardMcpText(parts.join("\n\n")).text;
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [];
    if (text.trim() || images.length === 0) {
      content.push({ type: "text", text: text || "(empty prompt)" });
    }
    for (const image of images) content.push({ type: "image", ...image });
    return {
      content,
      details: { server: def.name, prompt: name, messages: messages.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`mcp prompt ${def.name} ${name}:`, message);
    return textResult(`MCP prompt get failed: ${message}`, {
      server: def.name,
      prompt: name,
      isError: true,
    });
  }
}

async function executeCall(
  cwd: string,
  threadId: string,
  toolCallId: string,
  params: { tool?: string; args?: string },
  signal?: AbortSignal,
  scope?: McpToolScope,
  getApprovalLevel?: () => ApprovalLevel,
  getReviewFacts?: () => ReviewSessionFacts,
) {
  const fullName = String(params.tool ?? "").trim();
  if (!fullName) return textResult("tool is required for call (full name `server__tool`)");
  let args: Record<string, unknown>;
  if (params.args === undefined || params.args.trim() === "") {
    args = {};
  } else {
    try {
      const parsed = JSON.parse(params.args) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return textResult(
          'args must be a JSON object string, e.g. args: \'{"text": "hi"}\'',
        );
      }
      args = parsed as Record<string, unknown>;
    } catch (err) {
      return textResult(
        `args is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // 作用域闸门先行：在查"服务器是否存在"之前就按声明白名单拒绝。
// 这样拒绝文案不泄露哪些服务器真的配置着——先查存在性会把
// "未授权"变成"未配置"，等于给子代理一张服务器清单做探测。
const scopeAllowed = scope?.allowedServers;
if (scopeAllowed?.length) {
  const requestedServer = fullName.split("__")[0] ?? "";
  if (!scopeAllowed.includes(requestedServer)) {
    const usable = scope?.allowedNames?.length ? scope.allowedNames : scopeAllowed;
    return textResult(
      `You are not allowed to use the MCP server "${requestedServer}". This agent may only use: ${usable.join(", ")}. ` +
        "Do not retry the same call; use a permitted server or report the limitation.",
      { server: requestedServer, allowed: false, allowedServers: [...usable] },
    );
  }
}
  const parsed = parseMcpToolFullName(
    fullName,
    (await activeMcpServers(cwd)).map((d) => d.name),
  );
  if (!parsed) {
    return textResult(
      `Unknown MCP server for "${fullName}". Use mcp({ action: "search" }) to list available tools.`,
    );
  }
  const def = await findServerDef(cwd, parsed.server);
  if (!def) {
    return textResult(
      `MCP server "${parsed.server}" is disabled or unconfigured. Ask the user to check Settings → MCP.`,
    );
  }

  const started = Date.now();
  try {
    // 懒连接 + 白名单校验（未广播的名字拒绝转发）。握手先于审批：连接只发现
    // 工具面，服务器尚未执行任何被请求的操作；执行前的最后闸门是审批。
    await mcpManager.ensureConnected(def);
    // 档位与豁免的判定顺序（与内置工具同一套语义，见 docs/permission-modes.md）：
    // 无人值守自动化 > 审批级别 > 配置 approveTools > 本机清单。
    // 「完全访问」在最前面短路，后面两条豁免在该档下不再被读到——与
    // APPROVAL_REQUIRED_TOOLS 在 auto 档直接 return 是同一个取舍。
    const level = getApprovalLevel?.() ?? "ask";
    if (level !== "auto") {
      const local = await loadWriteRoots(cwd);
      // 工作区层（仓库带来的 .mcp.json / .kova/mcp.json）里的 approveTools **不产生
      // 授权效力**：clone 一个别人的项目不该让那个仓库给自己的工具免审批。它只作为
      // 卡上那句「这个项目请求放行 X」出现；真正生效的授权只有两条——你自己的
      // 系统层配置（~/.kova/mcp.json，本机文件），与审批卡上点出来的
      // allowMcpTools（写进本机 .kova/permissions.local.json，逐工具逐字相等）
      const configApproved = def.layer !== "workspace" && isToolApprovedBy(def, parsed.tool);
      const exempt = configApproved || local.mcpTools.includes(fullName);
      if (!exempt) {
        // 「同意意味着什么」要连着"项目请求了什么"一起说：否则用户只看到一张卡，
        // 不知道仓库文件里早就写好了"这些工具免问"，也不知道该按哪个按钮才有效
        const projectRequested =
          def.layer === "workspace" && def.approveTools?.length
            ? `这个项目在 ${relative(cwd, def.source) || def.source} 里请求 ${def.approveTools.join(", ")} 免审批；仓库文件不能给自己授权。`
            : undefined;
        // AI 审查档：弹卡之前先让模型判一次——allow 直接执行（不打扰用户），
        // deny 拦截并把理由回给模型，审查失败落到下面的弹卡（fail to human）。
        // 免审豁免（配置 approveTools / 本机 allowMcpTools）在上面，命中就不进这里
        let skipApproval = false;
        let reviewFallbackNote: string | undefined;
        if (level === "review") {
          const outcome = await runAutoReview(
            getReviewFacts?.() ?? {},
            {
              cwd,
              action: {
                tool: fullName,
                description: liveToolDescription(def, parsed.tool),
                arguments: args,
              },
            },
            signal ? { signal } : undefined,
          );
          if (outcome.ok) {
            if (outcome.decision.decision === "allow") {
              skipApproval = true;
            } else {
              logAt(
                "event",
                `auto-review denied MCP call: thread=${threadId} tool=${fullName} ` +
                  `risk=${outcome.decision.risk}` +
                  (outcome.decision.reason ? ` reason=${outcome.decision.reason}` : ""),
              );
              return textResult(autoReviewDenyReason(fullName, outcome.decision), {
                server: def.name,
                tool: parsed.tool,
                approved: false,
              });
            }
          } else {
            logErr("auto-review unavailable for MCP call, falling back to the approval card:", outcome.error);
            reviewFallbackNote = `AI 审查这次没跑起来（${outcome.error}），这一步改由你确认。`;
          }
        }
        if (!skipApproval) {
          const decision = await requestMcpApproval(
            threadId,
            toolCallId,
            def.name,
            fullName,
            args,
            level,
            projectRequested,
            reviewFallbackNote,
          );
          if (!decision.approved) {
            return textResult(
              "User rejected this MCP tool call. Do not retry it unchanged; ask how to proceed.",
              { server: def.name, tool: parsed.tool, approved: false },
            );
          }
          // 记住只写本机清单，且失败不阻断这次执行（记住是附带的账，不是执行的前提）
          if (decision.remember) {
            try {
              await rememberMcpTool(cwd, fullName);
            } catch (err) {
              logErr("mcp: failed to remember the approved tool:", err);
            }
          }
        }
      }
    }
    if (signal?.aborted) {
      return textResult("MCP tool call was aborted before execution.");
    }
    const sessionId = sessionForThread(threadId);
    const callContext = {
      threadId,
      ...(sessionId ? { sessionId } : {}),
    };
    // M2.1 分流：required 必走 task；optional 只在服务器声明 tasks 时走。
    // pending outcome（turn 结束任务仍在跑）在此渲染成模型可读的信封。
    const advertisedTool = (
      mcpManager.getLiveServerMeta(def) ?? getValidServerMeta(def)
    )?.tools.find((t) => t.name === parsed.tool);
    if (advertisedTool && shouldUseTask(advertisedTool, { tasks: true })) {
      return executeTaskCall({
        def,
        tool: parsed.tool,
        fullName,
        args,
        threadId,
        sessionId,
        signal,
        started,
      });
    }
    const raw = await mcpManager.callTool(def, parsed.tool, args, signal, callContext);
    const result = raw as McpCallResult;
    const isError = result?.isError === true;
    const { summary, result: bounded } = boundMcpResult(result);
    // 图片透传：合法 image 块不进文本通道，原样拼进结果 content，
    // 正规投影链路（image-parts.ts 2MiB 闸门/白名单 → data-image part）自动上屏
    const { text, images } = splitMcpContent(bounded?.content ?? result?.content ?? "");
    const finalText = isError ? `MCP tool reported an error:\n${text}` : text;
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [];
    // 无图或报错时保底给文本块（错误信息必须可见）；纯图结果不塞空文本
    if (images.length === 0 || isError || finalText.trim().length > 0) {
      content.push({ type: "text", text: finalText });
    }
    for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    const durationMs = Date.now() - started;
    return {
      content,
      details: {
        server: def.name,
        tool: parsed.tool,
        durationMs,
        isError,
        ...(summary ? { summary } : {}),
        ...(bounded && bounded !== result
          ? { structuredContent: bounded.structuredContent ?? null }
          : {}),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logErr(`mcp call ${fullName}:`, message);
    return textResult(`MCP call failed: ${message}`, {
      server: def.name,
      tool: parsed.tool,
      durationMs: Date.now() - started,
      isError: true,
    });
  }
}

/**
 * task 形态调用：进度经 data-mcpTask chunk 直播（1s 节流），结果/挂起信封
 * 渲染为模型可读文本。pending 时给模型 taskId 与下轮查询指引。
 */
async function executeTaskCall(args: {
  def: McpServerDef;
  tool: string;
  fullName: string;
  args: Record<string, unknown>;
  threadId: string;
  sessionId?: string;
  signal?: AbortSignal;
  started: number;
}) {
  const { def, tool, fullName, args: toolArgs, threadId, signal, started } = args;
  let lastProgressAt = 0;
  const outcome = await mcpManager.callToolAsTask(
    def,
    tool,
    toolArgs,
    {
      threadId,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    },
    signal,
    (task) => {
      // 1s 节流：进度 chunk 只进直播流，不落转录
      const now = Date.now();
      if (now - lastProgressAt < 1_000) return;
      lastProgressAt = now;
      sendEventChunk(
        threadId,
        {
          type: "data-mcpTask",
          data: {
            taskId: task.taskId,
            tool: fullName,
            server: def.name,
            status: task.status,
            ...(task.statusMessage ? { message: task.statusMessage } : {}),
          },
        },
        sessionForThread(threadId),
      );
    },
  );
  const durationMs = Date.now() - started;
  if (outcome.kind === "result") {
    // manager 已脱敏的 CallToolResult，走与普通 call 相同的渲染
    const result = outcome.result as McpCallResult;
    const isError = result?.isError === true;
    const { summary, result: bounded } = boundMcpResult(result);
    const { text, images } = splitMcpContent(bounded?.content ?? result?.content ?? "");
    const finalText = isError ? `MCP tool reported an error:\n${text}` : text;
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [];
    if (images.length === 0 || isError || finalText.trim().length > 0) {
      content.push({ type: "text", text: finalText });
    }
    for (const img of images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    return {
      content,
      details: {
        server: def.name,
        tool,
        durationMs,
        isError,
        task: true,
        ...(summary ? { summary } : {}),
        ...(bounded && bounded !== result
          ? { structuredContent: bounded.structuredContent ?? null }
          : {}),
      },
    };
  }
  if (outcome.kind === "error") {
    return textResult(`MCP task failed: ${outcome.message}`, {
      server: def.name,
      tool,
      durationMs,
      task: true,
      isError: true,
    });
  }
  // pending：turn 结束任务仍在跑。给模型 taskId 与下轮查询指引；Inbox 条目
  // 由 task_done/协议命令结算（这里只交账，不写 Inbox——与后台任务同哲学）。
  const record = outcome.kind === "pending" ? outcome.record : undefined;
  if (!record) {
    // 理论不可达（result/error 已在上面分支）：保底按失败渲染
    return textResult(`MCP task ended without a result: ${fullName}`, {
      server: def.name,
      tool,
      durationMs,
      task: true,
      isError: true,
    });
  }
  return textResult(
    [
      `MCP task accepted by "${def.name}" and still running (tool: ${fullName}).`,
      `taskId: ${outcome.taskId}`,
      record.statusMessage ? `status: ${record.statusMessage}` : "",
      "Poll with mcp({ action: \"task_status\", server: \"" + def.name + "\", taskId: \"...\" })",
      "and fetch the result with mcp({ action: \"task_result\", ... }) once completed. Do not re-call the same tool.",
    ]
      .filter(Boolean)
      .join("\n"),
    {
      server: def.name,
      tool,
      durationMs,
      task: true,
      pending: true,
      taskId: outcome.taskId,
    },
  );
}

/**
 * 待审 MCP 工具的说明（给审查器看的那一份）。只读内存缓存（live 连接的工具面
 * 或磁盘缓存），**不触发连接**——审查发生在握手之后，但连不上时也不能把审查
 * 卡在网络上；拿不到就不给（审查策略本来要求按实际效果判，不看描述）
 */
function liveToolDescription(def: McpServerDef, toolName: string): string | undefined {
  const tools = mcpManager.getLiveTools(def) ?? getValidTools(def) ?? [];
  return tools.find((t) => t.name === toolName)?.description ?? undefined;
}

/**
 * 审批挂起：复用 data-toolApproval chunk 与前端审批卡（toolName 恒为 "mcp"）。
 *
 * 卡面按档位分两形：`ask` 档两个按钮（这档的语义就是每次都问，「记住」会把它
 * 悄悄变成另一档）；`workspace-write` / `auto-edit` 两档给第三个「允许并记住这个
 * 工具」。**不给** `auto` 档挂起的机会——那条路在 executeCall 里已经短路了；
 * `review` 档只在审查失败退回时走到这里，同样不给「记住」——一次审查故障不该
 * 换来一个永久免审的工具。
 */
async function requestMcpApproval(
  threadId: string,
  toolCallId: string,
  server: string,
  fullName: string,
  args: Record<string, unknown>,
  level: ApprovalLevel,
  /** 项目层声明过免审批时的说明（「项目请求了什么」；授权仍由用户按按钮决定） */
  projectRequested?: string,
  /** AI 审查失败退回时的说明（回答"这张卡为什么会出现"） */
  fallbackNote?: string,
): Promise<{ approved: boolean; remember: boolean }> {
  // 无人值守自动化：MCP 属外部副作用，仅 full 档放行；否则即时拒绝、不挂起。
  // 走这条路的 turn 没有人在场，卡片无人应答——挂起等于把 execute 永久挂死。
  if (getAutomationPolicy(threadId)) {
    return { approved: getAutomationPolicy(threadId) === "full", remember: false };
  }
  const approvalId = `${toolCallId}:mcp`;
  const input = { action: "call", server, tool: fullName, args };
  // review 档不给「记住」：它只在审查失败退回时出现，一次故障不该换来永久免审
  const canRemember = level === "workspace-write" || level === "auto-edit";
  // 「同意意味着什么」必须显式写出：点了「允许并记住」之后，这个工具在本机
  // 永久免审批（含之后的会话），不显式说明就是静默扩大权限。
  // ask 档没有「记住」按钮，就只说项目请求了什么——别指向一个不存在的按钮
  const rememberNote = canRemember
    ? `点「允许并记住这个工具」会把 ${fullName} 记进 .kova/permissions.local.json，` +
      `之后本机再调它不再询问（同服务器的其他工具仍会逐次问）。`
    : undefined;
  const note = [fallbackNote, projectRequested, rememberNote].filter(Boolean).join(" ") || undefined;
  // 挂起交互登记落行（§4）+ 发起帧水印（§3）：MCP 审批会话必已物化（工具在跑），
  // 台账拿不到会话时自然降级为直播流卡片
  beginInteraction(threadId, {
    interactionId: approvalId,
    kind: "permission",
    anchorToolCallId: toolCallId,
    payload: {
      approvalId,
      toolCallId,
      toolName: "mcp",
      input,
      ...(note ? { note } : {}),
      ...(canRemember ? { canRemember: true } : {}),
    },
    createdAt: new Date().toISOString(),
  });
  sendEventChunk(
    threadId,
    {
      type: "data-toolApproval",
      data: {
        approvalId,
        toolCallId,
        toolName: "mcp",
        input,
        ...(note ? { note } : {}),
        ...(canRemember ? { canRemember: true } : {}),
      },
    },
    sessionForThread(threadId),
  );
  return new Promise<{ approved: boolean; remember: boolean }>((resolve) => {
    pendingMcpApprovals.set(approvalId, { threadId, resolve });
  });
}

async function executeStatus(cwd: string, allowedServers?: readonly string[]) {
  const { defs, enabledBy, diagnostics } = await loadMcpServers(cwd);
  const allowed = allowedServers?.length ? new Set(allowedServers) : undefined;
  const lines: string[] = [];
  for (const def of defs) {
    // 白名单网关：未授权的服务器连"存在"都不该泄露给子代理
    if (allowed && !allowed.has(def.name)) continue;
    const enabled = enabledBy.get(def.name) === true;
    if (!enabled) {
      lines.push(`${def.name}: disabled`);
      continue;
    }
    const status = mcpManager.statusFor(def);
    const target = def.transport === "http" ? def.url : def.command;
    const extra = [
      status.resourceCount ? `${status.resourceCount} resources` : "",
      status.promptCount ? `${status.promptCount} prompts` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `${def.name}: ${status.state}${status.toolCount ? ` (${status.toolCount} tools)` : ""}` +
        `${extra ? ` (${extra})` : ""}` +
        `${status.message ? ` — ${status.message}` : ""} [${def.transport}${target ? `: ${target}` : ""}]`,
    );
  }
  if (lines.length === 0) {
    return textResult(
      "No MCP servers configured. Ask the user to add one in Settings → MCP " +
        "(system ~/.kova/mcp.json or workspace .mcp.json).",
    );
  }
  return textResult(lines.join("\n"), {
    servers: defs.length,
    ...(diagnostics.length ? { diagnostics } : {}),
  });
}

// ---------------------------------------------------------------------------
// 系统提示词注入块（composeModeSystemPrompt 调用；无启用服务器时为空串，
// 默认提示词字节级不变——缓存纪律同 memoryPromptBlock）
// ---------------------------------------------------------------------------

const MCP_PROMPT_MAX_SERVERS = 20;

/**
 * 系统提示词的 MCP 段：列出已启用服务器的名字与描述（让模型无需 search 就知道
 * 有哪些集成可用）。mcp 属易变段：清单变化走提示词尾部更新，不重写首条 system
 * ——工具声明本身在 mcp 网关里，块内清单只是提示，不值得为它整段丢缓存。
 */
export function mcpPromptBlock(cwd: string): string {
  const { defs, enabledBy } = loadMcpServersSync(cwd);
  const active = defs.filter((d) => enabledBy.get(d.name) === true);
  if (active.length === 0) return "";
  const lines = [
    "## MCP servers",
    "External tool servers are available through the `mcp` gateway tool: search → describe → call (full tool names look like `server__tool`; args is a JSON object string). Calls are gated by the session's approval level: under full access they run without asking, otherwise each call needs user approval unless allow-listed by the server config or the user's local permission list.",
  ];
  const shown = active.slice(0, MCP_PROMPT_MAX_SERVERS);
  for (const def of shown) {
    lines.push(`- ${def.name}${def.description ? `: ${def.description}` : ""}`);
  }
  if (active.length > shown.length) {
    lines.push(`- …and ${active.length - shown.length} more (mcp status lists all)`);
  }
  return lines.join("\n");
}
