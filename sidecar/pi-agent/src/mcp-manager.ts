/**
 * MCP 连接管理（sidecar 进程内全局单例，跨会话共享连接池）。
 *
 * 职责边界：配置与校验在 mcp-config.ts；这里是连接生命周期——
 * - 懒连接：首次 call 才握手（search/describe 走 mcp-cache 不连接）；
 *   keep-alive/eager 生命周期只在「不参与空闲回收」上有区别，P0 不做启动预连
 * - 超时：握手 10s；调用 120s（与 bash 默认超时同量级）；AbortSignal 透传
 * - 退避：握手失败 60s 内快速失败，不反复付超时代价（pi-mcp-adapter failure-backoff）
 * - 上限：每服务器 64 工具（超出截断并记录）、tools/list 最多 8 页、
 *   活跃连接 16 个（超出按 LRU 驱逐最旧连接，调用不失败）
 * - 空闲回收：lazy 服务器 idleTimeout（默认 10 分钟）无活动即断开，
 *   下次调用重连；keep-alive/eager 不回收
 * - 热重载：applyConfig 按配置哈希 diff——配置变更/删除即断连，下次调用
 *   用新配置重连；工具表常驻不变（代理模式无需重建）
 *
 * 传输：stdio（官方 SDK StdioClientTransport，子进程环境白名单，绝不继承
 * sidecar 全量环境）与 Streamable HTTP（StreamableHTTPClientTransport，
 * headers 来自配置）。会话失效（HTTP 404 + Mcp-Session-Id）由 SDK onclose
 * 反映为断连，下次调用自动重连。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { computeConfigHash, updateTools, type McpToolMeta } from "./mcp-cache";
import type { McpServerDef } from "./mcp-config";
import { logErr } from "./log";

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 120_000;
export const MCP_FAILURE_BACKOFF_MS = 60_000;
export const MAX_TOOLS_PER_SERVER = 64;
export const MAX_TOOL_PAGES = 8;
export const MAX_ACTIVE_CONNECTIONS = 16;

export type McpServerState = "idle" | "connecting" | "ready" | "backoff";

export type McpServerStatus = {
  name: string;
  state: McpServerState;
  toolCount: number;
  toolNames?: string[];
  /** 最近一次错误/截断说明（failed/backoff/工具截断） */
  message?: string;
};

type Entry = {
  def: McpServerDef;
  configHash: string;
  state: McpServerState;
  client?: Client;
  tools: McpToolMeta[];
  lastUsedAt: number;
  /** 退避截止时间戳（state=backoff 时有效） */
  backoffUntil?: number;
  message?: string;
  connecting?: Promise<McpToolMeta[]>;
};

/**
 * stdio 子进程环境：只传显式声明值。SDK 的 StdioClientTransport 在 start() 时
 * 会以 getDefaultEnvironment()（HOME/PATH/SHELL/TERM 等安全白名单，并剔除函数型
 * 变量）与这里给出的 env 合并——sidecar 全量环境（可能经 hostdb 摸到 provider
 * 密钥）从不越过这道闸。
 */
export function mcpChildEnv(declared: Record<string, string> | undefined): Record<string, string> {
  return { ...(declared ?? {}) };
}

function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, 500);
}

export class McpManager {
  private entries = new Map<string, Entry>();
  private reaperTimer?: ReturnType<typeof setInterval>;

  /** 当前某服务器的实时状态（无条目 = idle） */
  statusFor(def: McpServerDef): McpServerStatus {
    const entry = this.entries.get(def.name);
    if (!entry || entry.configHash !== computeConfigHash(def)) {
      return { name: def.name, state: "idle", toolCount: 0 };
    }
    return {
      name: def.name,
      state: entry.state,
      toolCount: entry.tools.length,
      ...(entry.tools.length > 0 ? { toolNames: entry.tools.map((t) => t.name) } : {}),
      ...(entry.message ? { message: entry.message } : {}),
    };
  }

  /** 全部服务器状态（设置页行渲染用） */
  listStatuses(defs: McpServerDef[]): McpServerStatus[] {
    return defs.map((def) => this.statusFor(def));
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
      this.disconnect(def.name);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        def,
        configHash: hash,
        state: "idle",
        tools: [],
        lastUsedAt: 0,
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
    try {
      return await entry.client!.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS, signal },
      );
    } catch (err) {
      // 传输层死亡（服务器退出/会话失效）时 onclose 已置 idle，下次调用自动重连；
      // 业务错误（isError / 服务器返回错误）不清连接
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
        this.disconnect(name);
        continue;
      }
      if (entry.configHash !== nextHash) {
        // 立即以新配置覆盖旧条目（旧连接作废）
        this.disconnect(name);
      }
    }
  }

  /** 全部断开（sidecar 退出 / 测试 teardown） */
  disposeAll(): void {
    this.stopReaper();
    for (const name of [...this.entries.keys()]) this.disconnect(name);
  }

  /**
   * 启动空闲回收定时器（30s 一轮；index.ts 初始化时调用）。
   * 只回收 lifecycle=lazy 且超过 idleTimeout 无活动的连接。
   */
  startReaper(intervalMs = 30_000): void {
    this.stopReaper();
    this.reaperTimer = setInterval(() => this.reapIdle(), intervalMs);
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
        this.disconnect(name);
      }
    }
  }

  /** 断开并移除条目（连接池权威出口） */
  disconnect(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
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

  private async handshake(entry: Entry): Promise<McpToolMeta[]> {
    const { def } = entry;
    entry.state = "connecting";
    entry.message = undefined;
    // 活跃连接上限：超出按 lastUsedAt 驱逐最旧的一个 ready 连接
    if (!entry.client && this.activeCount >= MAX_ACTIVE_CONNECTIONS) {
      this.evictOldest();
    }
    let transport: Transport;
    const client = new Client(
      { name: "xulux-agent", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      if (def.transport === "stdio") {
        transport = new StdioClientTransport({
          command: String(def.command ?? ""),
          args: def.args ?? [],
          env: mcpChildEnv(def.env),
          stderr: "pipe",
        });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(String(def.url ?? "")), {
          requestInit: def.headers ? { headers: def.headers } : undefined,
        });
      }
      client.onclose = () => {
        // 服务器退出/会话失效：下次调用重连（保留 entry 以承载退避/状态语义）
        if (this.entries.get(def.name)?.client === client) {
          entry.client = undefined;
          entry.tools = [];
          if (entry.state === "ready") entry.state = "idle";
        }
      };
      client.onerror = (err) => {
        logErr(`mcp[${def.name}]:`, err instanceof Error ? err.message : String(err));
      };
      await withTimeout(
        client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `连接 MCP 服务器 "${def.name}" 超时（${MCP_CONNECT_TIMEOUT_MS / 1000}s）`,
      );
      const tools = await withTimeout(
        this.listTools(client),
        MCP_CONNECT_TIMEOUT_MS,
        `获取 MCP 服务器 "${def.name}" 工具列表超时`,
      );
      entry.client = client;
      entry.state = "ready";
      entry.tools = tools;
      entry.lastUsedAt = Date.now();
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        entry.message = `工具数达到上限 ${MAX_TOOLS_PER_SERVER}，超出部分已截断`;
      }
      updateTools(def, tools);
      return tools;
    } catch (err) {
      entry.state = "backoff";
      entry.backoffUntil = Date.now() + MCP_FAILURE_BACKOFF_MS;
      entry.message = describeError(err);
      entry.client = undefined;
      entry.tools = [];
      try {
        client.close();
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
    if (oldestName) this.disconnect(oldestName);
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
