/**
 * MCP 网关工具（代理模式，常驻注册）：一个 `mcp` 工具覆盖全部服务器的工具面，
 * 保护工具表字节级稳定（提示词前缀缓存的前提）。
 *
 * 动作：
 * - search  按关键词在工具索引里找工具（不连接，断连可用），带权重排名
 * - describe 看单个工具的完整 schema（调用前确认参数）
 * - call    执行：懒连接 → 白名单校验 → 逐次审批（approveTools glob 豁免）→
 *           调用 → 输出防护
 * - status  各服务器连接状态
 *
 * 工具全名约定 `<server>__<tool>`：search 结果即返回全名，describe/call 接受全名。
 * 解析不是朴素 split（名字里可含下划线），而是对已知服务器集合做最长前缀匹配。
 *
 * 审批回路与 Question 同构（question-tools.ts）：execute 内挂起 Promise →
 * sendEventChunk 推 data-toolApproval chunk（复用前端既有审批卡）→ protocol 的
 * tool_confirm 结算（先 run 内审批、回退本模块挂起表）→ 放行或拦截。
 */
import { Type } from "typebox";
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
import { getValidTools, type McpToolMeta } from "./mcp-cache";
import { mcpManager } from "./mcp-manager";
import { splitMcpContent, boundMcpResult, type McpCallResult } from "./mcp-output-guard";
import { getAutomationPolicy } from "../automation/policy";
import { logErr } from "../log";

/** search 返回条数上限（与 grep 的 MAX_MATCH_ENTRIES 同哲学：有界） */
const SEARCH_LIMIT_DEFAULT = 12;
const SEARCH_LIMIT_MAX = 40;

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

/** 汇集全部启用服务器的工具索引（已连接用池内实时清单，未连接用元数据缓存） */
async function buildToolIndex(cwd: string | undefined): Promise<ToolIndexEntry[]> {
  const defs = await activeMcpServers(cwd);
  const index: ToolIndexEntry[] = [];
  for (const def of defs) {
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

type PendingMcpApproval = { threadId: string; resolve: (approved: boolean) => void };
const pendingMcpApprovals = new Map<string, PendingMcpApproval>();

/** protocol tool_confirm 的回退结算：返回是否存在 */
export function resolveMcpApproval(approvalId: string, approved: boolean): boolean {
  const pending = pendingMcpApprovals.get(approvalId);
  if (!pending) return false;
  pendingMcpApprovals.delete(approvalId);
  settleInteraction(approvalId, approved ? "approved" : "denied");
  pending.resolve(approved);
  return true;
}

/** 用户 Stop / 新 prompt 的兜底清理：按拒绝结算，防 execute 永久挂起 */
export function cancelPendingMcpApprovals(threadId: string): void {
  for (const [id, entry] of [...pendingMcpApprovals]) {
    if (entry.threadId !== threadId) continue;
    pendingMcpApprovals.delete(id);
    settleInteraction(id, "cancelled");
    entry.resolve(false);
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

export function buildMcpTool(cwd: string, threadId: string): AgentTool {
  // 会话装配预连：eager 服务器后台握手（fire-and-forget，不阻塞装配；
  // 失败由连接池落退避/日志/审计，lazy 服务器维持首调才连）
  void activeMcpServers(cwd)
    .then((defs) => mcpManager.prewarm(defs))
    .catch(() => {});
  return {
    name: "mcp",
    label: "MCP",
    description:
      "Use tools from configured MCP servers (external integrations: databases, browsers, SaaS APIs). " +
      'Workflow: mcp({ action: "search", query: "..." }) to discover tools (returns full names like `server__tool`), ' +
      'mcp({ action: "describe", tool: "server__tool" }) to check parameters, ' +
      'then mcp({ action: "call", tool: "server__tool", args: "{...}" }) to execute. ' +
      "args is a JSON object serialized as a string. " +
      'mcp({ action: "status" }) lists configured servers and their connection state.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("search"),
        Type.Literal("describe"),
        Type.Literal("call"),
        Type.Literal("status"),
      ]),
      query: Type.Optional(
        Type.String({
          description: "search: keywords to find tools (matches tool name, server name or description)",
        }),
      ),
      tool: Type.Optional(
        Type.String({
          description: "describe/call: full tool name `server__tool` from search results",
        }),
      ),
      args: Type.Optional(
        Type.String({ description: 'call: JSON object string, e.g. "{\\"text\\": \\"hi\\"}"' }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `search: max results (default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX})`,
        }),
      ),
    }),
    execute: async (toolCallId, raw, signal) => {
      const params = raw as {
        action?: string;
        query?: string;
        tool?: string;
        args?: string;
        limit?: number;
      };
      switch (params.action) {
        case "search":
          return executeSearch(cwd, params);
        case "describe":
          return executeDescribe(cwd, params);
        case "call":
          return executeCall(cwd, threadId, toolCallId, params, signal);
        case "status":
          return executeStatus(cwd);
        default:
          return textResult(`unknown action: ${String(params.action)}`);
      }
    },
  };
}

async function executeSearch(cwd: string, params: { query?: string; limit?: number }) {
  const query = String(params.query ?? "").trim();
  if (!query) {
    return textResult("query is required for search");
  }
  const index = await buildToolIndex(cwd);
  if (index.length === 0) {
    return textResult(
      "No MCP tools available. Servers may be disabled, unconfigured, or not yet connected " +
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

async function executeDescribe(cwd: string, params: { tool?: string }) {
  const fullName = String(params.tool ?? "").trim();
  if (!fullName) return textResult("tool is required for describe (full name `server__tool`)");
  const index = await buildToolIndex(cwd);
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

async function executeCall(
  cwd: string,
  threadId: string,
  toolCallId: string,
  params: { tool?: string; args?: string },
  signal?: AbortSignal,
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
    if (!isToolApprovedBy(def, parsed.tool)) {
      const approved = await requestMcpApproval(threadId, toolCallId, def.name, fullName, args);
      if (!approved) {
        return textResult(
          "User rejected this MCP tool call. Do not retry it unchanged; ask how to proceed.",
          { server: def.name, tool: parsed.tool, approved: false },
        );
      }
    }
    if (signal?.aborted) {
      return textResult("MCP tool call was aborted before execution.");
    }
    const raw = await mcpManager.callTool(def, parsed.tool, args, signal);
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

/** 审批挂起：复用 data-toolApproval chunk 与前端审批卡（toolName 恒为 "mcp"） */
async function requestMcpApproval(
  threadId: string,
  toolCallId: string,
  server: string,
  fullName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  // 无人值守自动化：MCP 属外部副作用，仅 full 档放行；否则即时拒绝、不挂起
  if (getAutomationPolicy(threadId)) return getAutomationPolicy(threadId) === "full";
  const approvalId = `${toolCallId}:mcp`;
  const input = { action: "call", server, tool: fullName, args };
  // 挂起交互登记落行（§4）+ 发起帧水印（§3）：MCP 审批会话必已物化（工具在跑），
  // 台账拿不到会话时自然降级为直播流卡片
  beginInteraction(threadId, {
    interactionId: approvalId,
    kind: "permission",
    anchorToolCallId: toolCallId,
    payload: { approvalId, toolCallId, toolName: "mcp", input },
    createdAt: new Date().toISOString(),
  });
  sendEventChunk(
    threadId,
    { type: "data-toolApproval", data: { approvalId, toolCallId, toolName: "mcp", input } },
    sessionForThread(threadId),
  );
  return new Promise<boolean>((resolve) => {
    pendingMcpApprovals.set(approvalId, { threadId, resolve });
  });
}

async function executeStatus(cwd: string) {
  const { defs, enabledBy, diagnostics } = await loadMcpServers(cwd);
  const lines: string[] = [];
  for (const def of defs) {
    const enabled = enabledBy.get(def.name) === true;
    if (!enabled) {
      lines.push(`${def.name}: disabled`);
      continue;
    }
    const status = mcpManager.statusFor(def);
    const target = def.transport === "http" ? def.url : def.command;
    lines.push(
      `${def.name}: ${status.state}${status.toolCount ? ` (${status.toolCount} tools)` : ""}` +
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
 * 有哪些集成可用）。配置变更后整段重排属低频显式操作，缓存代价可接受。
 */
export function mcpPromptBlock(cwd: string): string {
  const { defs, enabledBy } = loadMcpServersSync(cwd);
  const active = defs.filter((d) => enabledBy.get(d.name) === true);
  if (active.length === 0) return "";
  const lines = [
    "## MCP servers",
    "External tool servers are available through the `mcp` gateway tool: search → describe → call (full tool names look like `server__tool`; args is a JSON object string). Every call needs user approval unless allow-listed by the server config.",
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
