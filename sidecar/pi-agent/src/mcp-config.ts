/**
 * MCP 服务器配置（设置 → MCP）：来源、合并、校验与写路径。
 *
 * 三层来源，同名按 id 字段级合并，后层覆盖前层（工作区覆盖层 > 工作区标准层 > 系统）：
 * - 系统：`~/.xulux/mcp.json`（PI_MCP_CONFIG 可覆盖，测试用），完整 schema
 * - 工作区标准层：`<cwd>/.mcp.json`，生态标准格式（mcpServers map），随仓库共享，
 *   只认 command/args/env/url/headers/type；adapter 专属字段在此层被忽略
 * - 工作区覆盖层：`<cwd>/.xulux/mcp.json`，xulux 专属字段（approveTools/lifecycle…），
 *   与 .xulux/subagents 同族；设置页对工作区层的写入只落这个文件，从不改写 .mcp.json
 *
 * 字段级合并是有意的：覆盖层可以只给标准层的条目补 approveTools 而不必重抄 command。
 * 安全约束：合并后 url 与低层不同时，不继承低层的 headers（认证材料跟着旧端点走
 * 是偷换指向攻击的收益面，照抄 pi-mcp-adapter 的 URL_BOUND_AUTH 防护）。
 *
 * 启用开关是"本机的运行时决定"，不写进配置文件（工作区文件在 git 里）：整包存
 * SQLite kv（key = ENABLED_KV_KEY），键规则与 subagents 一致（工作区按 cwd 隔离）。
 *
 * 动态化：每次加载对三份文件做签名（mtime+大小），签名没变用缓存——设置页保存/
 * 删除后缓存自然失效；网关工具每次 execute 前重载，改动即时生效，无需重启。
 */
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

export type McpServerName = string;

/** 服务器定义（合并与校验后的运行时形状；协议/manager/缓存共用） */
export type McpServerDef = {
  name: McpServerName;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** lazy（默认，空闲断开）| eager / keep-alive（保持连接，不空闲回收） */
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  /** 工具名 glob 免审批（对 gateway 的 call 动作） */
  approveTools?: string[];
  /** 所属层与来源文件，设置页展示与写路径用 */
  layer: "system" | "workspace";
  source: string;
  /** 最终生效定义来自工作区标准层 .mcp.json（该文件设置页从不改写） */
  fromStandard?: boolean;
};

/** 每文件条目上限：坏目录不该撑爆搜索结果，与 subagents 的层上限同哲学 */
const MAX_PER_FILE = 32;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MAX_VALUE_BYTES = 4096;

const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 系统级配置文件（应用数据目录，与 ~/.xulux/subagents 同族） */
export function systemMcpConfigPath(): string {
  if (process.env.PI_MCP_CONFIG) return process.env.PI_MCP_CONFIG;
  return join(homedir(), ".xulux", "mcp.json");
}

/** 工作区标准层（生态共享格式） */
export function workspaceStandardMcpPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

/** 工作区覆盖层（xulux 专属字段；设置页工作区写路径） */
export function workspaceOverrideMcpPath(cwd: string): string {
  return join(cwd, ".xulux", "mcp.json");
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

type RawEntry = Record<string, unknown>;

/** 标准层（.mcp.json）只认的字段；其余（approveTools 等）静默忽略并记诊断 */
const STANDARD_FIELDS = new Set(["command", "args", "env", "url", "headers", "type"]);

function transportOf(
  raw: RawEntry,
  label: string,
  errors: string[],
): "stdio" | "http" | null {
  const hasCommand = typeof raw.command === "string" && raw.command.trim().length > 0;
  const hasUrl = typeof raw.url === "string" && raw.url.trim().length > 0;
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (type === "http" || type === "sse" || type === "streamable-http") return "http";
  if (type === "stdio") return "stdio";
  if (hasCommand && hasUrl) {
    errors.push(`${label}: command 与 url 只能二选一`);
    return null;
  }
  if (hasUrl) return "http";
  if (hasCommand) return "stdio";
  errors.push(`${label}: 缺少 command（stdio）或 url（http）`);
  return null;
}

function stringMap(
  raw: unknown,
  keyRe: RegExp,
  label: string,
  cap: number,
  errors: string[],
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${label}: 必须是键值对象`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      errors.push(`${label}.${k}: 值必须是字符串`);
      continue;
    }
    if (!keyRe.test(k)) {
      errors.push(`${label} 键 "${k}" 不符合命名规则`);
      continue;
    }
    if (byteLen(v) > MAX_VALUE_BYTES) {
      errors.push(`${label}.${k}: 值超过 ${MAX_VALUE_BYTES} 字节`);
      continue;
    }
    out[k] = v;
  }
  if (Object.keys(out).length > cap) {
    errors.push(`${label}: 条目超过上限 ${cap}`);
  }
  return out;
}

/**
 * 解析一个 mcpServers 条目。格式错误进 errors（该条目丢弃），可疑但可降级的进
 * warnings（standard 之外的字段在标准层是「忽略」，在 xulux 层是「未知字段」）。
 * 复用于设置页保存的草稿校验（source 传空串，错误文案不带文件前缀）。
 */
function parseEntry(
  name: string,
  raw: unknown,
  opts: { layer: "system" | "workspace"; source: string; standard: boolean },
  errors: string[],
  warnings: string[],
): McpServerDef | null {
  const label = `[${name}]`;
  if (!NAME_RE.test(name)) {
    errors.push(`${label}: 名称需匹配 [a-zA-Z0-9_-]{1,64}`);
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`${label}: 必须是对象`);
    return null;
  }
  const r = raw as RawEntry;
  const transport = transportOf(r, label, errors);
  if (!transport) return null;

  const def: McpServerDef = {
    name,
    transport,
    layer: opts.layer,
    source: opts.source,
  };

  if (transport === "stdio") {
    if (r.url !== undefined || r.headers !== undefined) {
      errors.push(`${label}: stdio 服务器不能设置 url/headers`);
      return null;
    }
    const command = String(r.command ?? "").trim();
    if (!command) {
      errors.push(`${label}: stdio 服务器需要 command`);
      return null;
    }
    if (command.includes("..")) {
      errors.push(`${label}: command 不能包含 ".."`);
      return null;
    }
    if (byteLen(command) > MAX_VALUE_BYTES) {
      errors.push(`${label}: command 超过 ${MAX_VALUE_BYTES} 字节`);
      return null;
    }
    def.command = command;
    if (r.args !== undefined) {
      if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string")) {
        errors.push(`${label}: args 必须是字符串数组`);
        return null;
      }
      if (r.args.length > 64) {
        errors.push(`${label}: args 超过 64 项`);
        return null;
      }
      def.args = r.args as string[];
    }
    const env = stringMap(r.env, ENV_KEY_RE, `${label} env`, 64, errors);
    if (env) def.env = env;
  } else {
    if (r.command !== undefined || r.args !== undefined || r.env !== undefined) {
      errors.push(`${label}: http 服务器不能设置 command/args/env`);
      return null;
    }
    const url = String(r.url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      errors.push(`${label}: url 不是合法绝对地址`);
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push(`${label}: url 仅支持 http/https`);
      return null;
    }
    def.url = url;
    const headers = stringMap(r.headers, HEADER_KEY_RE, `${label} headers`, 32, errors);
    if (headers) def.headers = headers;
  }

  if (typeof r.description === "string" && r.description.trim()) {
    if (byteLen(r.description) > MAX_VALUE_BYTES) warnings.push(`${label}: description 过长已忽略`);
    else def.description = r.description.trim();
  }

  // ---- xulux 层专属字段（标准层一律忽略：警告后返回 undefined，调用方不赋值）----
  const extra = (key: string): unknown => {
    if (r[key] === undefined) return undefined;
    if (opts.standard) {
      warnings.push(`${label}: 标准层忽略 xulux 专属字段 "${key}"`);
      return undefined;
    }
    return r[key];
  };
  const lifecycle = extra("lifecycle");
  if (typeof lifecycle === "string" && ["lazy", "eager", "keep-alive"].includes(lifecycle)) {
    def.lifecycle = lifecycle as McpServerDef["lifecycle"];
  } else if (lifecycle !== undefined) {
    warnings.push(`${label}: 忽略非法 lifecycle "${String(lifecycle)}"`);
  }
  const idleTimeout = extra("idleTimeout");
  if (typeof idleTimeout === "number" && Number.isFinite(idleTimeout) && idleTimeout >= 5_000) {
    def.idleTimeout = Math.floor(idleTimeout);
  } else if (idleTimeout !== undefined) {
    warnings.push(`${label}: 忽略非法 idleTimeout（需 ≥5000 的毫秒数）`);
  }
  const approve = extra("approveTools");
  if (Array.isArray(approve) && approve.every((g) => typeof g === "string" && g.trim())) {
    def.approveTools = (approve as string[]).map((g) => g.trim());
  } else if (approve === true) {
    def.approveTools = ["*"];
  } else if (approve !== undefined) {
    warnings.push(`${label}: 忽略非法 approveTools（需 glob 字符串数组）`);
  }

  for (const key of Object.keys(r)) {
    const known =
      STANDARD_FIELDS.has(key) ||
      ["description", "lifecycle", "idleTimeout", "approveTools"].includes(key);
    if (!known) warnings.push(`${label}: 忽略未知字段 "${key}"`);
  }
  return def;
}

type LayerParse = {
  defs: McpServerDef[];
  diagnostics: string[];
};

function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "";
  }
}

function parseLayer(
  path: string,
  layer: "system" | "workspace",
  standard: boolean,
): LayerParse {
  const diagnostics: string[] = [];
  if (!existsSync(path)) return { defs: [], diagnostics };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    diagnostics.push(`${path}: 解析失败（${err instanceof Error ? err.message : String(err)}）`);
    return { defs: [], diagnostics };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    diagnostics.push(`${path}: 顶层必须是对象`);
    return { defs: [], diagnostics };
  }
  const servers = (doc as Record<string, unknown>).mcpServers;
  if (servers === undefined) return { defs: [], diagnostics };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    diagnostics.push(`${path}: mcpServers 必须是键值对象`);
    return { defs: [], diagnostics };
  }
  const defs: McpServerDef[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let names = Object.keys(servers as Record<string, unknown>);
  if (names.length > MAX_PER_FILE) {
    diagnostics.push(`${path}: 条目超过 ${MAX_PER_FILE}，超出部分丢弃`);
    names = names.slice(0, MAX_PER_FILE);
  }
  for (const name of names) {
    if (seen.has(name)) {
      warnings.push(`${path}: [${name}] 同文件内重名，丢弃后者`);
      continue;
    }
    seen.add(name);
    const def = parseEntry(
      name,
      (servers as Record<string, unknown>)[name],
      { layer, source: path, standard },
      errors,
      warnings,
    );
    if (def) defs.push(def);
  }
  for (const e of errors) diagnostics.push(`${path}: ${e}`);
  for (const w of warnings) diagnostics.push(`${path}: ${w}`);
  return { defs, diagnostics };
}

// ---------------------------------------------------------------------------
// 合并（字段级，URL 变更丢认证）
// ---------------------------------------------------------------------------

/** URL 变更时不得从低层继承的认证材料 */
const URL_BOUND_FIELDS = ["headers"] as const;

function mergeEntry(base: McpServerDef, next: McpServerDef): McpServerDef {
  const merged: McpServerDef = { ...base, ...next };
  // transport 换型：低层字段全部不继承（stdio/env 与 http/headers 是不同世界）
  if (base.transport !== next.transport) {
    if (next.transport === "stdio") {
      delete merged.url;
      delete merged.headers;
    } else {
      delete merged.command;
      delete merged.args;
      delete merged.env;
    }
    return merged;
  }
  if (next.transport === "http" && base.url && next.url && base.url !== next.url) {
    // 指向被改：认证材料（headers）只认新层显式给出的值
    for (const field of URL_BOUND_FIELDS) {
      merged[field] = next[field];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 启用开关（kv 整包，键规则同 subagents）
// ---------------------------------------------------------------------------

export type McpEnabledState = { disabled: Record<string, true> };

export const MCP_ENABLED_KV_KEY = "pi.mcp";

let enabledState: McpEnabledState = { disabled: {} };
let enabledLoad: Promise<void> | undefined;

export function mcpStateKey(layer: "system" | "workspace", name: string, cwd?: string): string {
  return layer === "workspace" ? `workspace:${cwd ?? ""}::${name}` : `system:${name}`;
}

/** 启动装配调一次（index.ts 闸门内）；幂等 */
export function initMcpEnabledState(): Promise<void> {
  enabledLoad ??= (async () => {
    try {
      const row = await kvGet(MCP_ENABLED_KV_KEY);
      if (!row?.value) return;
      const parsed = JSON.parse(row.value) as Partial<McpEnabledState>;
      enabledState = { disabled: (parsed.disabled ?? {}) as Record<string, true> };
    } catch (err) {
      logErr("mcp-state:", err instanceof Error ? err.message : String(err));
    }
  })();
  return enabledLoad;
}

async function persistEnabledState(): Promise<void> {
  try {
    await kvSet(MCP_ENABLED_KV_KEY, JSON.stringify(enabledState));
  } catch (err) {
    logErr("mcp-state save:", err instanceof Error ? err.message : String(err));
  }
}

export async function setMcpServerEnabled(
  layer: "system" | "workspace",
  name: string,
  enabled: boolean,
  cwd?: string,
): Promise<void> {
  await initMcpEnabledState();
  const key = mcpStateKey(layer, name, cwd);
  if (enabled) delete enabledState.disabled[key];
  else enabledState.disabled[key] = true;
  await persistEnabledState();
  loadCache.clear();
}

/** 测试钩子：清掉 kv 装载与文件签名缓存 */
export function resetMcpConfigForTest(): void {
  enabledState = { disabled: {} };
  enabledLoad = undefined;
  loadCache.clear();
}

// ---------------------------------------------------------------------------
// 三层加载（签名缓存）
// ---------------------------------------------------------------------------

export type McpLoadResult = {
  /** 合并后的全部定义（含被禁用的；enabledBy 单独给） */
  defs: McpServerDef[];
  /** name -> 是否启用（禁用 = kv 显式关闭） */
  enabledBy: Map<McpServerName, boolean>;
  diagnostics: string[];
};

const loadCache = new Map<string, { sig: string; result: McpLoadResult }>();

function loadSync(cwd: string | undefined): McpLoadResult {
  const systemPath = systemMcpConfigPath();
  const stdPath = cwd ? workspaceStandardMcpPath(cwd) : "";
  const ovrPath = cwd ? workspaceOverrideMcpPath(cwd) : "";
  const sig = [
    fileSignature(systemPath),
    cwd ? fileSignature(stdPath) : "",
    cwd ? fileSignature(ovrPath) : "",
  ].join("|");
  const cached = loadCache.get(cwd ?? "");
  if (cached && cached.sig === sig) return cached.result;

  const system = parseLayer(systemPath, "system", false);
  const standard = cwd
    ? parseLayer(stdPath, "workspace", true)
    : { defs: [], diagnostics: [] };
  const override = cwd
    ? parseLayer(ovrPath, "workspace", false)
    : { defs: [], diagnostics: [] };
  const diagnostics = [
    ...system.diagnostics,
    ...standard.diagnostics,
    ...override.diagnostics,
  ];

  const byName = new Map<McpServerName, McpServerDef>();
  // 合并顺序：系统 → 工作区标准 → 工作区覆盖（后者字段级覆盖前者）
  for (const def of [...system.defs, ...standard.defs, ...override.defs]) {
    const base = byName.get(def.name);
    if (!base) {
      byName.set(def.name, { ...def });
      continue;
    }
    byName.set(def.name, mergeEntry(base, def));
  }
  // 层语义跟最终提供者走；标准层条目保留 fromStandard 标记（设置页据此降级删除入口）
  for (const def of byName.values()) {
    def.fromStandard =
      def.layer === "workspace" && cwd && def.source === stdPath ? true : undefined;
  }

  const enabledBy = new Map<McpServerName, boolean>();
  for (const def of byName.values()) {
    enabledBy.set(
      def.name,
      enabledState.disabled[
        mcpStateKey(def.layer, def.name, def.layer === "workspace" ? cwd : undefined)
      ] !== true,
    );
  }

  const result: McpLoadResult = { defs: [...byName.values()], enabledBy, diagnostics };
  loadCache.set(cwd ?? "", { sig, result });
  return result;
}

/** 设置页清单：全部定义 + 启用态（协议消息与网关工具共用） */
export async function loadMcpServers(cwd?: string | null): Promise<McpLoadResult> {
  await initMcpEnabledState();
  return loadSync(cwd?.trim() || undefined);
}

/**
 * 同步加载：假定 initMcpEnabledState 已完成（index.ts 启动闸门内调用过）。
 * 供系统提示词组合（composeModeSystemPrompt 是同步链）等无法 await 的路径使用；
 * kv 未初始化的极早期调用会按全启用处理，与"默认开启"语义一致。
 */
export function loadMcpServersSync(cwd?: string | null): McpLoadResult {
  return loadSync(cwd?.trim() || undefined);
}

/** 网关工具用：当前生效（启用）的定义集合 */
export async function activeMcpServers(cwd?: string | null): Promise<McpServerDef[]> {
  const { defs, enabledBy } = await loadMcpServers(cwd);
  return defs.filter((def) => enabledBy.get(def.name) === true);
}

// ---------------------------------------------------------------------------
// 写路径（设置页 → 系统文件 / 工作区覆盖文件）
// ---------------------------------------------------------------------------

export type McpDraft = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive";
  idleTimeout?: number;
  approveTools?: string[];
};

/** 草稿校验：复用条目解析（source 为空串，错误文案不带文件前缀）；返回错误列表 */
export function validateMcpDraft(draft: McpDraft): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];
  parseEntry(
    draft.name,
    draft as unknown as RawEntry,
    { layer: "system", source: "", standard: false },
    errors,
    warnings,
  );
  return errors;
}

function readJsonDoc(path: string): Record<string, RawEntry> {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      return doc as Record<string, RawEntry>;
    }
  } catch {
    /* 新文件/坏文件：按空对象重建 */
  }
  return {};
}

/** 写盘条目：与加载解析对齐的形状（type 字段显式标注 transport） */
function emitEntry(draft: McpDraft): RawEntry {
  const entry: RawEntry = { type: draft.transport };
  if (draft.transport === "stdio") {
    entry.command = draft.command;
    if (draft.args?.length) entry.args = draft.args;
    if (draft.env && Object.keys(draft.env).length > 0) entry.env = draft.env;
  } else {
    entry.url = draft.url;
    if (draft.headers && Object.keys(draft.headers).length > 0) entry.headers = draft.headers;
  }
  if (draft.description?.trim()) entry.description = draft.description.trim();
  if (draft.lifecycle) entry.lifecycle = draft.lifecycle;
  if (draft.idleTimeout !== undefined) entry.idleTimeout = draft.idleTimeout;
  if (draft.approveTools?.length) entry.approveTools = draft.approveTools;
  return entry;
}

export type McpWriteOptions = {
  /** workspace 层必填 */
  cwd?: string;
  /** 测试注入：覆盖系统文件路径 */
  systemPath?: string;
  /** 编辑时改名：旧名条目一并移除 */
  replaceName?: string;
};

function targetPathFor(
  layer: "system" | "workspace",
  options: McpWriteOptions,
): { path: string; standard?: string } {
  if (layer === "system") {
    return { path: options.systemPath ?? systemMcpConfigPath() };
  }
  const cwd = options.cwd?.trim();
  if (!cwd) throw new Error("workspace 层保存需要工作区目录（cwd）");
  return { path: workspaceOverrideMcpPath(cwd), standard: workspaceStandardMcpPath(cwd) };
}

/** 保存（新增或同名覆盖）到系统/工作区覆盖文件；工作区覆盖层可接管标准层同名条目 */
export async function saveMcpServer(
  layer: "system" | "workspace",
  draft: McpDraft,
  options: McpWriteOptions = {},
): Promise<void> {
  const errors = validateMcpDraft(draft);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const { path } = targetPathFor(layer, options);
  const doc = readJsonDoc(path);
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers)
    ? (doc.mcpServers as Record<string, RawEntry>)
    : (doc.mcpServers = {}));
  const replaceName = options.replaceName?.trim();
  if (replaceName && replaceName !== draft.name) delete servers[replaceName];
  servers[draft.name] = emitEntry(draft);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  loadCache.clear();
}

/** 删除一份定义；只动本层文件（系统文件 / 工作区覆盖文件），从不改写标准层 .mcp.json */
export async function deleteMcpServer(
  layer: "system" | "workspace",
  name: string,
  options: McpWriteOptions = {},
): Promise<void> {
  const { path, standard } = targetPathFor(layer, options);
  const doc = readJsonDoc(path);
  const servers = doc.mcpServers as Record<string, RawEntry> | undefined;
  if (!servers || !(name in servers)) {
    if (standard && existsSync(standard)) {
      throw new Error(
        `"${name}" 来自工作区共享文件 ${standard}，设置页不直接改写它：` +
          `可在覆盖层保存同名条目接管，或手工编辑该文件`,
      );
    }
    throw new Error(`未找到${layer === "system" ? "系统" : "工作区"}服务器 "${name}"`);
  }
  delete servers[name];
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  loadCache.clear();
}
