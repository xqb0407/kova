/**
 * MCP 连接管理（sidecar 进程内全局单例，跨会话共享连接池）。
 *
 * 职责边界：配置与校验在 mcp-config.ts；这里是连接生命周期——
 * - 懒连接：首次 call 才握手（search/describe 走 mcp-cache 不连接）；
 *   eager 在配置装载/会话装配时额外预连（prewarm）；keep-alive/eager 不参与空闲回收
 * - 超时：握手 10s；调用 120s（与 bash 默认超时同量级）；AbortSignal 透传
 * - 退避：握手失败按连败次数指数退避 30s→5min（成功清零），退避期内快速失败
 * - 健康检查：keep-alive/eager 的 ready 连接每 60s 主动 ping 探测（不支持 ping 的
 *   服务器豁免），半死连接在此暴露并断开，下次调用重连
 * - 观测：连接/断开/调用/截断/授权事件持久写审计日志（见 mcp-audit.ts）
 * - 上限：每服务器 64 工具（超出截断并记录）、tools/list 最多 8 页、
 *   活跃连接 16 个（超出按 LRU 驱逐最旧连接，调用不失败）
 * - 空闲回收：lazy 服务器 idleTimeout（默认 10 分钟）无活动即断开，
 *   下次调用重连；keep-alive/eager 不回收
 * - 热重载：applyConfig 按配置哈希 diff——配置变更/删除即断连，下次调用
 *   用新配置重连；工具表常驻不变（代理模式无需重建）
 *
 * 传输：stdio（官方 SDK StdioClientTransport，子进程环境白名单，绝不继承
 * sidecar 全量环境）与 Streamable HTTP（StreamableHTTPClientTransport，
 * headers 来自配置）。HTTP 服务器遇 401 走 MCP OAuth 2.1（见 mcp-oauth.ts）：
 * 已存凭据则静默刷新，未授权则置 needsAuth 等用户在设置页点「授权」。
 * 会话失效（HTTP 404 + Mcp-Session-Id）由 SDK onclose
 * 反映为断连，下次调用自动重连。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { computeConfigHash, updateTools, type McpToolMeta } from "./mcp-cache";
import type { McpServerDef } from "./mcp-config";
import {
  beginInteractiveOAuth,
  clearOAuthForServer,
  hasOAuthTokens,
  silentOAuthProvider,
  type InteractiveOAuthSession,
} from "./mcp-oauth";
import { recordMcpAudit } from "./mcp-audit";
import { logErr } from "./log";

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 120_000;
/** 指数退避：30s 起步，每次连败翻倍，封顶 5min（对齐 pi-mcp-adapter failure-backoff） */
export const MCP_BACKOFF_BASE_MS = 30_000;
export const MCP_BACKOFF_MAX_MS = 300_000;
/** 第 streak 次连败的退避时长（streak 从 1 起） */
export function backoffForStreak(streak: number): number {
  return Math.min(MCP_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1), MCP_BACKOFF_MAX_MS);
}
/** keep-alive/eager 主动健康检查间隔（搭 reaper 的 30s tick，实际粒度为其倍数） */
export const MCP_HEALTH_PROBE_INTERVAL_MS = 60_000;
export const MAX_TOOLS_PER_SERVER = 64;
export const MAX_TOOL_PAGES = 8;
export const MAX_ACTIVE_CONNECTIONS = 16;

export type McpServerState = "idle" | "connecting" | "ready" | "backoff";

/** 协议自报图标（MCP 2025-11-25 initialize 响应的 serverInfo.icons，已过滤规整） */
export type McpServerIcon = {
  /** http(s) URL 或 data: URI */
  src: string;
  /** 深浅色适配声明；缺省 = 通用 */
  theme?: "light" | "dark";
};

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  toolCount: number;
  toolNames?: string[];
  /** 最近一次错误/截断说明（failed/backoff/工具截断） */
  message?: string;
  /** 握手因 401/无凭据失败：该 http 服务器需要用户走一次 OAuth 授权 */
  needsAuth?: boolean;
  /** 该 http 服务器的 URL 已存有 OAuth token（设置页据此呈现「取消授权」） */
  oauthAuthorized?: boolean;
  /** 服务器握手时自报的图标（该配置从未握手成功则无） */
  icons?: McpServerIcon[];
};

/** 连接错误日志一行（设置页「日志」弹窗展示，环形缓冲取最近若干） */
export type McpLogLine = { at: number; message: string };
const MCP_LOG_LIMIT = 100;

type Entry = {
  def: McpServerDef;
  configHash: string;
  state: McpServerState;
  client?: Client;
  tools: McpToolMeta[];
  lastUsedAt: number;
  /** 退避截止时间戳（state=backoff 时有效） */
  backoffUntil?: number;
  /** 连续握手失败次数（指数退避的指数；成功握手清零） */
  failStreak: number;
  /** 最近一次健康探测时间（keep-alive/eager 专用） */
  lastProbeAt?: number;
  /** ping 收到 -32601（协议里 ping 是可选能力）：视为不支持，不再探测不误杀 */
  pingUnsupported?: boolean;
  message?: string;
  /** 最近一次握手因 OAuth 未授权失败（401） */
  needsAuth?: boolean;
  connecting?: Promise<McpToolMeta[]>;
};

/**
 * 只保留能安全渲染为 &lt;img&gt; 的图标：src 必须 http(s) 外链或 data URI，
 * 其余（相对路径 / javascript: 等）丢弃；每服务器最多 4 张。
 */
export function normalizeServerIcons(raw: unknown): McpServerIcon[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpServerIcon[] = [];
  for (const item of raw) {
    if (out.length >= 4) break;
    if (typeof item !== "object" || item === null) continue;
    const { src, theme } = item as { src?: unknown; theme?: unknown };
    if (typeof src !== "string") continue;
    const trimmed = src.trim();
    if (!/^(https?:\/\/|data:)/i.test(trimmed)) continue;
    out.push({
      src: trimmed,
      ...(theme === "light" || theme === "dark" ? { theme } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * stdio 子进程环境：只传显式声明值。SDK 的 StdioClientTransport 在 start() 时
 * 会以 getDefaultEnvironment()（HOME/PATH/SHELL/TERM 等安全白名单，并剔除函数型
 * 变量）与这里给出的 env 合并——sidecar 全量环境（可能经 hostdb 摸到 provider
 * 密钥）从不越过这道闸。
 */
export function mcpChildEnv(declared: Record<string, string> | undefined): Record<string, string> {
  return { ...(declared ?? {}) };
}

/** 日志正文（去掉「握手失败：」等前缀），用于跨来源去重比较 */
function logCore(message: string): string {
  const i = message.indexOf("：");
  return i >= 0 ? message.slice(i + 1) : message;
}

function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 500);
}

/**
 * 「需要授权」的两种失败形态：挂了 provider 的 401 由 SDK 转成
 * UnauthorizedError；没挂 provider（全新未授权）时 initialize 得到的是
 * StreamableHTTPError{code:401}。两者都要点亮 needsAuth。
 */
function isAuthFailure(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  return (err as { code?: unknown } | null)?.code === 401;
}

export class McpManager {
  private entries = new Map<string, Entry>();
  private reaperTimer?: ReturnType<typeof setInterval>;
  /**
   * 握手时自报的图标，按「名字 + 配置哈希」缓存在进程内：lazy 服务器空闲回收后
   * 设置页行仍显示图标；配置变更后哈希不同，不会串用旧服务器的图标。
   */
  private iconCache = new Map<string, McpServerIcon[]>();
  /** 每台服务器的连接错误日志（按名字聚合，跨断开/重连保留） */
  private logs = new Map<string, McpLogLine[]>();

  /** 某服务器的连接错误日志（时间升序） */
  logFor(name: string): McpLogLine[] {
    return [...(this.logs.get(name) ?? [])];
  }

  private pushLog(name: string, message: string): void {
    const lines = this.logs.get(name) ?? [];
    const last = lines[lines.length - 1];
    // 一次失败可能同时触发 onerror 与握手 catch（如 stdio spawn 失败）：
    // 短窗口内正文相同的连续条目只记一条
    if (last && Date.now() - last.at < 2000 && logCore(last.message) === logCore(message)) {
      return;
    }
    lines.push({ at: Date.now(), message });
    if (lines.length > MCP_LOG_LIMIT) lines.splice(0, lines.length - MCP_LOG_LIMIT);
    this.logs.set(name, lines);
  }

  /** 当前某服务器的实时状态（无条目 = idle） */
  statusFor(def: McpServerDef): McpServerStatus {
    const entry = this.entries.get(def.name);
    const configHash = computeConfigHash(def);
    // 缓存键自带配置哈希：断开/回收后仍命中，改配置后自然落空
    const icons = this.iconCache.get(`${def.name}\u0000${configHash}`);
    // 凭据按 URL 键控：断开态也要如实反映「已授权」（取消授权入口不依赖连接）
    const oauthAuthorized = def.transport === "http" && hasOAuthTokens(String(def.url ?? ""));
    if (!entry || entry.configHash !== configHash) {
      return {
        name: def.name,
        state: "idle",
        toolCount: 0,
        ...(icons ? { icons } : {}),
        ...(oauthAuthorized ? { oauthAuthorized: true } : {}),
      };
    }
    return {
      name: def.name,
      state: entry.state,
      toolCount: entry.tools.length,
      ...(entry.tools.length > 0 ? { toolNames: entry.tools.map((t) => t.name) } : {}),
      ...(entry.message ? { message: entry.message } : {}),
      ...(entry.needsAuth ? { needsAuth: true } : {}),
      ...(oauthAuthorized ? { oauthAuthorized: true } : {}),
      ...(icons ? { icons } : {}),
    };
  }

  /** 全部服务器状态（设置页行渲染用） */
  listStatuses(defs: McpServerDef[]): McpServerStatus[] {
    return defs.map((def) => this.statusFor(def));
  }

  /**
   * 交互式 OAuth 授权（设置页「授权」按钮）：起 127.0.0.1 回调服务、
   * 打开浏览器让用户批准、换 token 落盘，然后带着凭据重连入池。
   * 只支持 http 传输；stdio 服务器没有 OAuth 概念。
   */
  async authorize(def: McpServerDef): Promise<McpServerStatus> {
    if (def.transport !== "http") {
      throw new Error(`MCP 服务器 "${def.name}" 不是 http 传输，无需 OAuth 授权`);
    }
    const session = await beginInteractiveOAuth(String(def.url ?? ""));
    this.disconnect(def.name, "reauthorize");
    const entry: Entry = {
      def,
      configHash: computeConfigHash(def),
      state: "idle",
      tools: [],
      lastUsedAt: 0,
      failStreak: 0,
    };
    this.entries.set(def.name, entry);
    entry.connecting = this.handshake(entry, session);
    try {
      await entry.connecting;
      recordMcpAudit({ at: Date.now(), server: def.name, kind: "auth", ok: true, detail: "OAuth 授权完成" });
    } finally {
      entry.connecting = undefined;
      await session.finish();
    }
    return this.statusFor(def);
  }

  /**
   * 取消 OAuth 授权（设置页「取消授权」按钮）：清掉该 URL 的全部存量凭据，
   * 并断开现有连接——下次握手无凭据裸 401，重新回到 needsAuth。
   */
  revokeAuth(def: McpServerDef): void {
    if (def.transport !== "http") {
      throw new Error(`MCP 服务器 "${def.name}" 不是 http 传输，没有 OAuth 授权可取消`);
    }
    clearOAuthForServer(String(def.url ?? ""));
    recordMcpAudit({ at: Date.now(), server: def.name, kind: "auth", ok: true, detail: "取消授权：已清除存量凭据" });
    this.disconnect(def.name, "revoke");
  }

  /** 连接中服务器的实时工具元数据（比缓存新鲜；未连接返回 null） */
  getLiveTools(def: McpServerDef): McpToolMeta[] | null {
    const entry = this.entries.get(def.name);
    if (!entry || entry.state !== "ready" || entry.configHash !== computeConfigHash(def)) {
      return null;
    }
    return entry.tools.map((t) => ({ ...t }));
  }

  /** 当前连接中的服务器数（活跃上限判断） */
  get activeCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.client) n += 1;
    }
    return n;
  }

  /**
   * 确保已连接并返回工具清单（懒连接入口）。退避期内快速失败；
   * 同名配置已变（applyConfig 未及处理）时视为旧连接失效，先断后连。
   */
  async ensureConnected(def: McpServerDef): Promise<McpToolMeta[]> {
    const hash = computeConfigHash(def);
    let entry = this.entries.get(def.name);
    if (entry && entry.configHash !== hash) {
      this.disconnect(def.name, "config_change");
      entry = undefined;
    }
    if (!entry) {
      entry = {
        def,
        configHash: hash,
        state: "idle",
        tools: [],
        lastUsedAt: 0,
        failStreak: 0,
      };
      this.entries.set(def.name, entry);
    }
    if (entry.client && entry.state === "ready") {
      entry.lastUsedAt = Date.now();
      return entry.tools;
    }
    if (entry.state === "backoff" && (entry.backoffUntil ?? 0) > Date.now()) {
      throw new Error(
        `MCP 服务器 "${def.name}" 连接失败退避中（${Math.ceil(((entry.backoffUntil ?? 0) - Date.now()) / 1000)}s 后重试）：${entry.message ?? ""}`,
      );
    }
    if (entry.state === "backoff") {
      entry.state = "idle";
      entry.backoffUntil = undefined;
    }
    entry.connecting ??= this.handshake(entry);
    try {
      return await entry.connecting;
    } finally {
      entry.connecting = undefined;
    }
  }

  /**
   * 调用工具：先懒连接，再做工具名白名单校验（服务器未广播的名字拒绝转发——
   * 防幻觉工具名直达服务器，也防缓存残留调用已被禁用/删除的服务器）。
   * 返回原始 CallToolResult，内容格式化与输出防护由调用方（mcp-tools）负责。
   */
  async callTool(
    def: McpServerDef,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const entry = await this.readyEntry(def);
    const advertised = entry.tools.some((t) => t.name === toolName);
    if (!advertised) {
      throw new Error(
        `MCP 服务器 "${def.name}" 未提供工具 "${toolName}"：先用 mcp search 查看可用工具`,
      );
    }
    entry.lastUsedAt = Date.now();
    const t0 = Date.now();
    try {
      const result = await entry.client!.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS, signal },
      );
      // 只记元数据（名字/耗时/成败），参数与结果内容不进审计
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "call",
        ok: true,
        ms: Date.now() - t0,
        detail: toolName,
      });
      return result;
    } catch (err) {
      // 传输层死亡（服务器退出/会话失效）时 onclose 已置 idle，下次调用自动重连；
      // 业务错误（isError / 服务器返回错误）不清连接
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "call",
        ok: false,
        ms: Date.now() - t0,
        detail: `${toolName}：${describeError(err)}`,
      });
      throw err;
    }
  }

  /**
   * 配置热重载：按名字 + 配置哈希 diff。删除/改配置的服务器断连，
   * 未变的保持连接（工具列表缓存原地有效）。
   */
  applyConfig(defs: McpServerDef[]): void {
    const hashes = new Map(defs.map((d) => [d.name, computeConfigHash(d)]));
    for (const [name, entry] of [...this.entries]) {
      const nextHash = hashes.get(name);
      if (!nextHash) {
        this.disconnect(name, "config_removed");
        continue;
      }
      if (entry.configHash !== nextHash) {
        // 立即以新配置覆盖旧条目（旧连接作废）
        this.disconnect(name, "config_change");
      }
    }
    // 图标缓存同样按「名字+哈希」过期：删除/改配置的服务器不再沿用旧图标
    for (const key of [...this.iconCache.keys()]) {
      const [name, hash] = key.split("\u0000");
      if (hashes.get(name) !== hash) this.iconCache.delete(key);
    }
  }

  /** 全部断开（sidecar 退出 / 测试 teardown）：图标与日志缓存一并清空 */
  disposeAll(): void {
    this.stopReaper();
    for (const name of [...this.entries.keys()]) this.disconnect(name, "teardown");
    this.iconCache.clear();
    this.logs.clear();
  }

  /**
   * 启动后台维护定时器（30s 一轮；index.ts 初始化时调用）：
   * 空闲回收（lazy 超时无活动断开）+ keep-alive/eager 健康探测。
   */
  startReaper(intervalMs = 30_000): void {
    this.stopReaper();
    this.reaperTimer = setInterval(() => {
      this.reapIdle();
      this.probeHealth();
    }, intervalMs);
    // 不阻止进程退出
    this.reaperTimer.unref?.();
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
  }

  /** 测试与回收共用：按当前时间执行一轮空闲断开 */
  reapIdle(now = Date.now()): void {
    for (const [name, entry] of this.entries) {
      if (!entry.client || entry.state !== "ready") continue;
      if (entry.def.lifecycle && entry.def.lifecycle !== "lazy") continue;
      const idleTimeout = entry.def.idleTimeout ?? 10 * 60 * 1000;
      // 从未使用过的连接（lastUsedAt=0）用 connectedAt 之外兜底：不给回收（握手即用，行为一致）
      if (entry.lastUsedAt <= 0) continue;
      if (now - entry.lastUsedAt >= idleTimeout) {
        this.disconnect(name, "idle_reclaim");
      }
    }
  }

  /**
   * keep-alive/eager 主动健康检查（reaper tick 搭车；测试可直接调）：
   * ready 连接每 MCP_HEALTH_PROBE_INTERVAL_MS ping 一次。半开连接（TCP 活着、
   * 服务器已死）onclose 兜不住，这里 ping 超时后断开，下次调用重连。
   * 服务器回 -32601（协议里 ping 是可选能力）标记豁免，不误杀健康连接。
   */
  probeHealth(now = Date.now()): void {
    for (const [name, entry] of [...this.entries]) {
      if (!entry.client || entry.state !== "ready") continue;
      if (!entry.def.lifecycle || entry.def.lifecycle === "lazy") continue;
      if (entry.pingUnsupported) continue;
      if (now - (entry.lastProbeAt ?? 0) < MCP_HEALTH_PROBE_INTERVAL_MS) continue;
      entry.lastProbeAt = now;
      const client = entry.client;
      withTimeout(
        client.ping({ timeout: MCP_CONNECT_TIMEOUT_MS }),
        MCP_CONNECT_TIMEOUT_MS + 2000,
        "健康检查 ping 超时",
      ).catch((err) => {
        if ((err as { code?: unknown } | null)?.code === -32601) {
          entry.pingUnsupported = true;
          return;
        }
        this.pushLog(name, `健康检查失败：${describeError(err)}`);
        recordMcpAudit({
          at: Date.now(),
          server: name,
          kind: "probe_fail",
          ok: false,
          detail: describeError(err),
        });
        // 探测期间连接可能已被回收/重连：只断当前这条仍挂着的
        if (this.entries.get(name) === entry && entry.client === client) {
          this.disconnect(name, "probe_fail");
        }
      });
    }
  }

  /**
   * eager 服务器预连（配置装载/变更、会话装配时调用）：fire-and-forget，
   * 失败已由握手路径落退避/日志/审计，这里不抛出、不阻塞装配。
   */
  prewarm(defs: McpServerDef[]): void {
    for (const def of defs) {
      if (def.lifecycle !== "eager") continue;
      void this.ensureConnected(def).catch(() => {});
    }
  }

  /** 断开并移除条目（连接池权威出口）；reason 进审计日志 */
  disconnect(name: string, reason = "manual"): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
    if (entry.client) {
      recordMcpAudit({ at: Date.now(), server: name, kind: "disconnect", detail: reason });
    }
    try {
      entry.client?.close();
    } catch {
      /* 关闭失败不影响释放 */
    }
  }

  // -------------------------------------------------------------------------
  // 内部：握手与传输
  // -------------------------------------------------------------------------

  private async readyEntry(def: McpServerDef): Promise<Entry> {
    await this.ensureConnected(def);
    const entry = this.entries.get(def.name);
    if (!entry?.client || entry.state !== "ready") {
      throw new Error(`MCP 服务器 "${def.name}" 不可用`);
    }
    return entry;
  }

  /** 一对全新的 client/transport（connect 失败后 SDK 不允许复用同实例重连） */
  private createConnection(
    entry: Entry,
    oauth?: InteractiveOAuthSession,
  ): { client: Client; transport: Transport } {
    const { def } = entry;
    const client = new Client(
      { name: "xulux-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    client.onclose = () => {
      // 服务器退出/会话失效：下次调用重连（保留 entry 以承载退避/状态语义）
      if (this.entries.get(def.name)?.client === client) {
        entry.client = undefined;
        entry.tools = [];
        if (entry.state === "ready") entry.state = "idle";
      }
    };
    client.onerror = (err) => {
      const text = err instanceof Error ? err.message : String(err);
      logErr(`mcp[${def.name}]:`, text);
      this.pushLog(def.name, `传输错误：${text}`);
    };
    let transport: Transport;
    if (def.transport === "stdio") {
      transport = new StdioClientTransport({
        command: String(def.command ?? ""),
        args: def.args ?? [],
        env: mcpChildEnv(def.env),
        stderr: "pipe",
      });
    } else {
      // OAuth 凭据挂载策略：交互会话的 provider（授权流进行中）优先；
      // 否则仅在已存过凭据时挂静默 provider（过期自动刷新）。全新未授权的
      // 服务器不挂 provider——裸 401 由下面按状态码点亮 needsAuth。
      const provider = oauth?.provider ?? silentOAuthProvider(String(def.url ?? ""));
      // SDK 的 header 合并顺序是 requestInit 覆盖 OAuth Bearer（_commonHeaders
      // 里 {...authHeaders, ...extraHeaders}），配置里残留的静态 Authorization
      // 会把授权换来的 token 顶掉——已有真凭据时以 token 为准，剥掉它。
      let headers = def.headers;
      if (provider?.tokens()) {
        const rest: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers ?? {})) {
          if (k.toLowerCase() !== "authorization") rest[k] = v;
        }
        headers = Object.keys(rest).length > 0 ? rest : undefined;
      }
      transport = new StreamableHTTPClientTransport(new URL(String(def.url ?? "")), {
        requestInit: headers ? { headers } : undefined,
        ...(provider ? { authProvider: provider } : {}),
      });
    }
    return { client, transport };
  }

  private async handshake(entry: Entry, oauth?: InteractiveOAuthSession): Promise<McpToolMeta[]> {
    const { def } = entry;
    const t0 = Date.now();
    entry.state = "connecting";
    entry.message = undefined;
    entry.needsAuth = false;
    // 活跃连接上限：超出按 lastUsedAt 驱逐最旧的一个 ready 连接
    if (!entry.client && this.activeCount >= MAX_ACTIVE_CONNECTIONS) {
      this.evictOldest();
    }
    const connectTimeoutMsg = `连接 MCP 服务器 "${def.name}" 超时（${MCP_CONNECT_TIMEOUT_MS / 1000}s）`;
    let conn: { client: Client; transport: Transport } | undefined;
    try {
      conn = this.createConnection(entry, oauth);
      try {
        await withTimeout(
          conn.client.connect(conn.transport),
          MCP_CONNECT_TIMEOUT_MS,
          connectTimeoutMsg,
        );
      } catch (err) {
        // 交互式授权流：401 时 provider 已拉起浏览器。等用户批准回跳拿 code，
        // finishAuth 换 token 后换新实例重连（同一 client connect 失败后不可复用）
        if (!oauth || !isAuthFailure(err)) throw err;
        const code = await oauth.waitForCode();
        try {
          conn.client.close();
        } catch {
          /* 容错 */
        }
        // 交互式授权会话只存在于 http 传输（authorize() 已 guard），finishAuth
        // 是 StreamableHTTPClientTransport 的能力
        await (conn.transport as StreamableHTTPClientTransport).finishAuth(code);
        conn = this.createConnection(entry, oauth);
        await withTimeout(
          conn.client.connect(conn.transport),
          MCP_CONNECT_TIMEOUT_MS,
          connectTimeoutMsg,
        );
      }
      const tools = await withTimeout(
        this.listTools(conn.client),
        MCP_CONNECT_TIMEOUT_MS,
        `获取 MCP 服务器 "${def.name}" 工具列表超时`,
      );
      entry.client = conn.client;
      entry.state = "ready";
      entry.tools = tools;
      entry.lastUsedAt = Date.now();
      // 2025-11-25 起 serverInfo 可携带 icons；老服务器/未声明则无字段（前端用默认图标）。
      // 重连后不再自报时也要清掉旧缓存，避免展示过期图标。
      const iconsKey = `${def.name}\u0000${entry.configHash}`;
      const icons = normalizeServerIcons(conn.client.getServerVersion()?.icons);
      if (icons) this.iconCache.set(iconsKey, icons);
      else this.iconCache.delete(iconsKey);
      entry.failStreak = 0;
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        entry.message = `工具数达到上限 ${MAX_TOOLS_PER_SERVER}，超出部分已截断`;
        recordMcpAudit({
          at: Date.now(),
          server: def.name,
          kind: "truncate",
          ok: false,
          detail: `工具数达上限，保留 ${MAX_TOOLS_PER_SERVER} 个`,
        });
      }
      updateTools(def, tools);
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "connect",
        ok: true,
        ms: Date.now() - t0,
        detail: `${tools.length} 个工具`,
      });
      return tools;
    } catch (err) {
      entry.state = "backoff";
      entry.failStreak += 1;
      entry.backoffUntil = Date.now() + backoffForStreak(entry.failStreak);
      if (isAuthFailure(err)) {
        entry.needsAuth = true;
        entry.message = "需要 OAuth 授权：在设置 → MCP 中点「授权」完成浏览器登录";
      } else {
        entry.message = describeError(err);
      }
      this.pushLog(def.name, `握手失败：${entry.message}`);
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "connect_fail",
        ok: false,
        ms: Date.now() - t0,
        detail: `${entry.needsAuth ? "[needsAuth] " : ""}${entry.message}（下次重试约 ${Math.round(backoffForStreak(entry.failStreak) / 1000)}s 后）`,
      });
      entry.client = undefined;
      entry.tools = [];
      try {
        conn?.client.close();
      } catch {
        /* 传输未建立时的关闭容错 */
      }
      throw err;
    }
  }

  private async listTools(client: Client): Promise<McpToolMeta[]> {
    const collected: McpToolMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools ?? []) {
        if (!tool.name?.trim()) continue;
        if (collected.length >= MAX_TOOLS_PER_SERVER) return collected;
        collected.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return collected;
  }

  private evictOldest(): void {
    let oldestName: string | undefined;
    let oldestAt = Infinity;
    for (const [name, entry] of this.entries) {
      if (!entry.client || entry.state !== "ready") continue;
      const usedAt = entry.lastUsedAt || 0;
      if (usedAt < oldestAt) {
        oldestAt = usedAt;
        oldestName = name;
      }
    }
    if (oldestName) this.disconnect(oldestName, "lru_evict");
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 进程级单例（sidecar 与测试共用同一入口） */
export const mcpManager = new McpManager();
