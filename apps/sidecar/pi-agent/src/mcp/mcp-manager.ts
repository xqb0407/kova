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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { commandOnPath, pathWithNodeShim } from "../local-host/runtime-shims";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpCapabilityFlags,
  McpPromptMeta,
  McpResourceMeta,
  McpResourceSnapshot,
  McpResourceTemplateMeta,
} from "pi-protocol";
import {
  computeConfigHash,
  emptyMcpCapabilities,
  emptyMcpServerMeta,
  getValidTools,
  parseToolUiMeta,
  updateServerMeta,
  type McpServerMeta,
  type McpToolMeta,
} from "./mcp-cache";
import type { McpServerDef } from "./mcp-config";
import {
  beginInteractiveOAuth,
  clearOAuthForServer,
  hasOAuthTokens,
  silentOAuthProvider,
  type InteractiveOAuthSession,
} from "./mcp-oauth";
import { recordMcpAudit } from "./mcp-audit";
import {
  registerElicitationHandler,
  type McpCallContext,
} from "./elicitation";
import {
  callToolViaTask,
  cancelTask,
  getTaskResult,
  getTaskStatus,
  type McpTaskOutcome,
  type McpTaskProgress,
} from "./mcp-tasks";
import type { Task } from "@modelcontextprotocol/sdk/types.js";
import {
  redactMcpSecretText,
  redactMcpSecretValue,
  resolveMcpSecretEnvForSpawn,
  resolveMcpSecretHeaders,
  type McpResolvedSecret,
} from "./mcp-secrets";
import { logErr } from "../log";

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 120_000;
/** 生成授权链接的等待上限（beginAuthorize 第一阶段）。超时说明授权流根本没起来
 *  （受保护资源元数据发现 / DCR 卡住）：放弃本次授权并按失败上报，绝不让它继续
 *  占着 mgmt 串行队列空转——旧实现同步等满 180s，整条队列连带全应用假死数分钟。 */
export const MCP_AUTH_URL_TIMEOUT_MS = 30_000;
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
/** 资源/Prompt 的握手期上限：防止第三方服务器用无限分页拖住连接 */
export const MAX_RESOURCES_PER_SERVER = 200;
export const MAX_PROMPTS_PER_SERVER = 100;
export const MAX_CAPABILITY_PAGES = 8;
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
  /** 服务器 initialize 声明的能力（离线/未连接时全 false） */
  capabilities: McpCapabilityFlags;
  resourceCount: number;
  promptCount: number;
  /** 最近一次错误/截断说明（failed/backoff/工具截断） */
  message?: string;
  /** 握手因 401/无凭据失败：该 http 服务器需要用户走一次 OAuth 授权 */
  needsAuth?: boolean;
  /** 该 http 服务器的 URL 已存有 OAuth token（设置页据此呈现「取消授权」） */
  oauthAuthorized?: boolean;
  /** 服务器握手时自报的图标（该配置从未握手成功则无） */
  icons?: McpServerIcon[];
};

/** 两段式交互式授权的第一阶段交付物（第二阶段经 completed 结算） */
export type McpAuthStarted = {
  /** 授权链接（生成时已尝试拉起浏览器）；缺省 = 握手没走到需要授权那一步 */
  authUrl?: string;
  /** 浏览器是否成功拉起（false = 请用户手动打开 authUrl） */
  browserOpened?: boolean;
  status: McpServerStatus;
  /** 第二阶段结算：ok=true 表示已带凭据入池；失败给原因（不抛，协议层推自发帧） */
  completed: Promise<{ ok: true } | { ok: false; message: string }>;
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
  resources: McpResourceMeta[];
  resourceTemplates: McpResourceTemplateMeta[];
  prompts: McpPromptMeta[];
  capabilities: McpCapabilityFlags;
  /** 该连接上正在跑的 MCP 请求上下文；elicitation 请求没有关联 id，取最近一条 */
  activeCalls: McpCallContext[];
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
  /** 本次握手解析出的密钥 env（仅 stdio；断开即随 entry 丢弃） */
  secretEnv?: Record<string, string>;
  /** 本次握手解析出的密钥请求头（仅 http；断开即随 entry 丢弃） */
  secretHeaders?: Record<string, string>;
  /** 本次握手解析出的密钥值，仅用于工具输出/stderr 脱敏 */
  secretValues?: McpResolvedSecret[];
  /** 最近一次连接的 stderr 尾部：握手失败时拼进用户可见错误，别只剩 Connection closed */
  lastStderr?: string;
};

/** 新建连接池条目：能力元数据必须有初值，避免 handshake 失败路径拿到 undefined */
function newEntry(def: McpServerDef, configHash: string): Entry {
  return {
    def,
    configHash,
    state: "idle",
    ...emptyServerMeta(),
    lastUsedAt: 0,
    failStreak: 0,
    activeCalls: [],
  };
}

type McpCapabilityMeta = {
  resources: McpResourceMeta[];
  resourceTemplates: McpResourceTemplateMeta[];
  prompts: McpPromptMeta[];
  capabilities: McpCapabilityFlags;
};

function emptyServerMeta(): Pick<
  Entry,
  "tools" | "resources" | "resourceTemplates" | "prompts" | "capabilities"
> {
  const empty = emptyMcpServerMeta();
  return {
    tools: empty.tools,
    resources: empty.resources,
    resourceTemplates: empty.resourceTemplates,
    prompts: empty.prompts,
    capabilities: empty.capabilities,
  };
}

/** 对外返回副本：调用方改写不能污染连接池内的能力面 */
function cloneServerMeta(meta: McpServerMeta): McpServerMeta {
  return {
    tools: meta.tools.map((t) => ({ ...t })),
    resources: meta.resources.map((r) => ({ ...r })),
    resourceTemplates: meta.resourceTemplates.map((r) => ({ ...r })),
    prompts: meta.prompts.map((p) => ({
      ...p,
      ...(p.arguments ? { arguments: p.arguments.map((a) => ({ ...a })) } : {}),
    })),
    capabilities: { ...meta.capabilities },
  };
}

/** 审计里的资源 URI：去掉 query/hash（可能带 token），并限长 */
function auditTarget(value: string): string {
  const clipped = value.split(/[?#]/, 1)[0] ?? value;
  return clipped.slice(0, 200);
}

/**
 * 把一次 MCP 请求登记到连接的活跃调用栈，供 elicitation handler 取上下文。
 * 服务器请求没有关联 id，只能取最近一条；同一服务器并发调用时以最后发起的
 * 为准（elicitation 通常就在这条调用内部发生）。
 */
async function runInCallContext<T>(
  entry: Entry,
  context: Omit<McpCallContext, "server" | "operation"> | undefined,
  operation: McpCallContext["operation"],
  fn: () => Promise<T>,
): Promise<T> {
  if (!context) return fn();
  const active: McpCallContext = { ...context, server: entry.def.name, operation };
  entry.activeCalls.push(active);
  try {
    return await fn();
  } finally {
    const index = entry.activeCalls.lastIndexOf(active);
    if (index >= 0) entry.activeCalls.splice(index, 1);
  }
}

/** 第三方元数据字段限长：资源/Prompt 的描述可能很长，不能原样进状态与缓存 */
function boundedText(value: unknown, max = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

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
export function mcpChildEnv(
  declared: Record<string, string> | undefined,
  secretEnv?: Record<string, string>,
  extras?: {
    /** Codex env_vars：从宿主环境透传的变量名 */
    envVars?: string[];
    /** 插件根 / 数据根：Codex Agent Plugins 约定注入 PLUGIN_ROOT / PLUGIN_DATA */
    pluginRoot?: string;
    pluginDataRoot?: string;
  },
): Record<string, string> {
  // 密钥绑定显式覆盖同名 literal：用户选择注入密钥后，配置里的旧占位符
  // 不应把真正的值挡住。值只在这里短暂经过，随后交给子进程。
  const env: Record<string, string> = { ...(declared ?? {}), ...(secretEnv ?? {}) };
  for (const name of extras?.envVars ?? []) {
    if (env[name] !== undefined) continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (extras?.pluginRoot) env.PLUGIN_ROOT = extras.pluginRoot;
  if (extras?.pluginDataRoot) env.PLUGIN_DATA = extras.pluginDataRoot;
  return env;
}

/**
 * Codex 插件常用 `node` / `npx`，而打包态从 Dock 启动时 PATH 很窄。
 * 找不到时回退到应用内置运行时（sidecar 二进制以 bun 语义运行）：
 * - node → process.execPath + BUN_BE_BUN=1
 * - npx  → process.execPath x ...（bun x）
 * - sh/bash 启动器（如 Codex 插件的 scripts/start.sh）→ 把内置运行时以
 *   `node` 之名前置进子进程 PATH，脚本内部的 `command -v node` 也能命中
 * 原生模块可能不兼容，会在服务器日志里明确标注；用户可安装 node 后自动走回退前路径。
 */
function resolveStdioLaunch(def: McpServerDef, secretEnv?: Record<string, string>): {
  command: string;
  args: string[];
  env: Record<string, string>;
  note?: string;
} {
  const env = mcpChildEnv(def.env, secretEnv, {
    envVars: def.envVars,
    ...(def.pluginRoot ? { pluginRoot: def.pluginRoot } : {}),
    ...(def.pluginDataRoot ? { pluginDataRoot: def.pluginDataRoot } : {}),
  });
  const command = String(def.command ?? "");
  const args = def.args ?? [];
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if ((base === "node" || base === "node.exe") && !commandOnPath(command)) {
    env.BUN_BE_BUN = "1";
    return {
      command: process.execPath,
      args,
      env,
      note: `PATH 中未找到 node，已回退内置运行时（${process.execPath}）；原生模块可能不兼容`,
    };
  }
  if ((base === "npx" || base === "npx.cmd") && !commandOnPath(command)) {
    env.BUN_BE_BUN = "1";
    return {
      command: process.execPath,
      args: ["x", ...args],
      env,
      note: `PATH 中未找到 npx，已回退内置运行时（bun x）；原生模块可能不兼容`,
    };
  }
  // shell 启动器不走上面的直接命令判定：PATH 里找不到 node 时，脚本会在
  // `command -v node` 处直接退出（表现为 MCP 秒断）。把软链目录前置到子进程
  // PATH，脚本里的 node 即命中内置运行时。
  if (process.platform !== "win32" && (base === "sh" || base === "bash")) {
    const childPath = env.PATH ?? process.env.PATH ?? process.env.Path ?? "";
    if (!commandOnPath("node", childPath)) {
      const shimmedPath = pathWithNodeShim(childPath);
      if (shimmedPath) {
        env.BUN_BE_BUN = "1";
        env.PATH = shimmedPath;
        return {
          command,
          args,
          env,
          note: `PATH 中未找到 node，已为 shell 启动器注入内置运行时（${process.execPath}）；原生模块可能不兼容`,
        };
      }
    }
  }
  return { command, args, env };
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
        capabilities: emptyMcpCapabilities(),
        resourceCount: 0,
        promptCount: 0,
        ...(icons ? { icons } : {}),
        ...(oauthAuthorized ? { oauthAuthorized: true } : {}),
      };
    }
    return {
      name: def.name,
      state: entry.state,
      toolCount: entry.tools.length,
      capabilities: { ...entry.capabilities },
      resourceCount: entry.resources.length,
      promptCount: entry.prompts.length,
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
   * 交互式 OAuth 授权（设置页「授权」按钮）第一阶段：起 127.0.0.1 回调服务、
   * 后台跑握手，等授权链接生成（浏览器拉起已尝试）后立即返回。用户在浏览器里
   * 批准可能长达几分钟——那段时间不再挂在请求上，改由 completed 结算、协议层
   * 推 mcp_auth_result 自发帧（旧实现在命令里同步等满 180s，把整条管理命令串行
   * 队列堵死：期间所有会话/清单/设置请求排队等死，全应用假死数分钟）。
   * 只支持 http 传输；stdio 服务器没有 OAuth 概念。
   */
  async beginAuthorize(def: McpServerDef): Promise<McpAuthStarted> {
    if (def.transport !== "http") {
      throw new Error(`MCP 服务器 "${def.name}" 不是 http 传输，无需 OAuth 授权`);
    }
    const session = await beginInteractiveOAuth(String(def.url ?? ""));
    this.disconnect(def.name, "reauthorize");
    const entry = newEntry(def, computeConfigHash(def));
    this.entries.set(def.name, entry);
    const flow = this.handshake(entry, session);
    entry.connecting = flow;
    // 结算链自己吸收失败：协议层只订阅 completed，没人再接这个 reject
    const completed: McpAuthStarted["completed"] = flow
      .then(() => {
        recordMcpAudit({
          at: Date.now(),
          server: def.name,
          kind: "auth",
          ok: true,
          detail: "OAuth 授权完成",
        });
        return { ok: true as const };
      })
      .catch((err: unknown) => ({ ok: false as const, message: describeError(err) }))
      .finally(() => {
        if (entry.connecting === flow) entry.connecting = undefined;
        void session.finish();
      });

    const first = await this.awaitAuthLink(session, flow);
    return {
      ...(first === "done" ? {} : { authUrl: first.url, browserOpened: first.browserOpened }),
      status: this.statusFor(def),
      completed,
    };
  }

  /**
   * 等授权链接生成（或握手在拿到链接前就结束）。超时视为授权流没起来：
   * 放弃本次授权（关回调服务、让在飞等待立即以原因失败）并抛明确错误。
   */
  private async awaitAuthLink(
    session: InteractiveOAuthSession,
    flow: Promise<McpToolMeta[]>,
  ): Promise<{ url: string; browserOpened: boolean } | "done"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        session.urlReady,
        // 握手可能压根没走到授权（存量凭据仍有效即已连上）：此时无需链接
        flow.then(() => "done" as const),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("mcp-oauth-url-timeout")),
            MCP_AUTH_URL_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "mcp-oauth-url-timeout") {
        session.abort("授权链接生成超时");
        throw new Error(
          `授权启动失败：${MCP_AUTH_URL_TIMEOUT_MS / 1000}s 内未生成授权链接` +
            `（授权服务器元数据发现或客户端注册失败），请点「日志」查看握手细节`,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 旧语义入口：等完整授权流结束才返回（测试/脚本用；UI 走两段式 beginAuthorize） */
  async authorize(def: McpServerDef): Promise<McpServerStatus> {
    const started = await this.beginAuthorize(def);
    const result = await started.completed;
    if (!result.ok) throw new Error(result.message || "OAuth 授权失败");
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

  /** 连接中服务器的全部能力元数据（比缓存新鲜；未连接返回 null） */
  getLiveServerMeta(def: McpServerDef): McpServerMeta | null {
    const entry = this.entries.get(def.name);
    if (!entry || entry.state !== "ready" || entry.configHash !== computeConfigHash(def)) {
      return null;
    }
    return cloneServerMeta(entry);
  }

  /** 连接中服务器的资源快照；未连接/未声明 resources 返回 null */
  getLiveResources(def: McpServerDef): McpResourceSnapshot | null {
    const meta = this.getLiveServerMeta(def);
    if (!meta || !meta.capabilities.resources) return null;
    return { resources: meta.resources, resourceTemplates: meta.resourceTemplates };
  }

  /** 连接中服务器的 Prompt 清单；未连接/未声明 prompts 返回 null */
  getLivePrompts(def: McpServerDef): McpPromptMeta[] | null {
    const meta = this.getLiveServerMeta(def);
    if (!meta || !meta.capabilities.prompts) return null;
    return meta.prompts;
  }

  /**
   * 确保连接并返回资源快照。离线展示优先用 mcp-cache；这里是“要最新”的路径。
   */
  async listResources(def: McpServerDef): Promise<McpResourceSnapshot> {
    const entry = await this.readyEntry(def);
    return {
      resources: entry.resources.map((r) => ({ ...r })),
      resourceTemplates: entry.resourceTemplates.map((r) => ({ ...r })),
    };
  }

  /**
   * 读取一个资源。URI 由调用方/服务器提供，不在这里做协议白名单；输出防护与
   * 密钥脱敏由调用方 + 本方法共同负责。
   */
  async readResource(
    def: McpServerDef,
    uri: string,
    signal?: AbortSignal,
    context?: Omit<McpCallContext, "server" | "operation">,
  ): Promise<unknown> {
    const target = uri.trim();
    if (!target) throw new Error("MCP resource uri is required");
    const entry = await this.readyEntry(def);
    if (!entry.capabilities.resources) {
      throw new Error(`MCP 服务器 "${def.name}" 未声明 resources 能力`);
    }
    entry.lastUsedAt = Date.now();
    const t0 = Date.now();
    try {
      const result = await runInCallContext(entry, context, "resource", () =>
        entry.client!.readResource(
          { uri: target },
          { timeout: def.callTimeout ?? MCP_CALL_TIMEOUT_MS, signal },
        ),
      );
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "resource_read",
        ok: true,
        ms: Date.now() - t0,
        detail: auditTarget(target),
      });
      return redactMcpSecretValue(result, entry.secretValues ?? []);
    } catch (err) {
      const message = redactMcpSecretText(describeError(err), entry.secretValues ?? []);
      const code = (err as { code?: unknown } | null)?.code;
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "resource_read",
        ok: false,
        ms: Date.now() - t0,
        detail: `${auditTarget(target)}：${message}`,
      });
      const safe = new Error(message);
      if (code !== undefined) (safe as Error & { code?: unknown }).code = code;
      throw safe;
    }
  }

  /** 确保连接并返回 Prompt 清单 */
  async listPrompts(def: McpServerDef): Promise<McpPromptMeta[]> {
    const entry = await this.readyEntry(def);
    return entry.prompts.map((p) => ({
      ...p,
      ...(p.arguments ? { arguments: p.arguments.map((a) => ({ ...a })) } : {}),
    }));
  }

  /**
   * 取一条 prompt。只接受服务器已广播的名字（防幻觉/缓存残留）；参数由调用方
   * 按 prompts/list 的 arguments 声明生成。
   */
  async getPrompt(
    def: McpServerDef,
    name: string,
    args: Record<string, string> = {},
    signal?: AbortSignal,
    context?: Omit<McpCallContext, "server" | "operation">,
  ): Promise<unknown> {
    const target = name.trim();
    if (!target) throw new Error("MCP prompt name is required");
    const entry = await this.readyEntry(def);
    if (!entry.capabilities.prompts) {
      throw new Error(`MCP 服务器 "${def.name}" 未声明 prompts 能力`);
    }
    if (!entry.prompts.some((p) => p.name === target)) {
      throw new Error(
        `MCP 服务器 "${def.name}" 未提供 prompt "${target}"：先用 mcp prompts 查看可用项`,
      );
    }
    entry.lastUsedAt = Date.now();
    const t0 = Date.now();
    try {
      const result = await runInCallContext(entry, context, "prompt", () =>
        entry.client!.getPrompt(
          { name: target, arguments: args },
          { timeout: def.callTimeout ?? MCP_CALL_TIMEOUT_MS, signal },
        ),
      );
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "prompt_get",
        ok: true,
        ms: Date.now() - t0,
        detail: target,
      });
      return redactMcpSecretValue(result, entry.secretValues ?? []);
    } catch (err) {
      const message = redactMcpSecretText(describeError(err), entry.secretValues ?? []);
      const code = (err as { code?: unknown } | null)?.code;
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "prompt_get",
        ok: false,
        ms: Date.now() - t0,
        detail: `${target}：${message}`,
      });
      const safe = new Error(message);
      if (code !== undefined) (safe as Error & { code?: unknown }).code = code;
      throw safe;
    }
  }

  /** 当前连接中的服务器数（活跃上限判断） */
  get activeCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.client) n += 1;
    }
    return n;
  }

  /** 连接池里仍保留条目的服务器名（含 idle/backoff）：配置 diff 后据此清缓存 */
  entryNames(): string[] {
    return [...this.entries.keys()];
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
      entry = newEntry(def, hash);
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
    const target = entry;
    target.connecting ??= (async () => {
      if (def.transport === "stdio") {
        // 绑定解析放在 spawn 前：哈希不一致/没有绑定都返回 null，
        // 子进程只拿到配置里声明的 literal env。
        const resolved = await resolveMcpSecretEnvForSpawn(def);
        target.secretEnv = resolved?.env;
        target.secretValues = resolved?.values;
      } else {
        // HTTP：密钥请求头绑定（M2.2）。值只在内存保留到断开，用于
        // createConnection 的 header 合并与输出脱敏。
        const resolved = await resolveMcpSecretHeaders(def);
        target.secretHeaders = resolved?.headers;
        target.secretValues = resolved?.values;
      }
      return this.handshake(target);
    })();
    try {
      return await target.connecting;
    } finally {
      target.connecting = undefined;
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
    context?: Omit<McpCallContext, "server" | "operation">,
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
      const result = await runInCallContext(entry, context, "tool", () =>
        entry.client!.callTool(
          { name: toolName, arguments: args },
          undefined,
          { timeout: def.callTimeout ?? MCP_CALL_TIMEOUT_MS, signal },
        ),
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
      // 服务器可能把注入的 token 回显在结果里：先脱敏再交给输出防护/上下文
      return redactMcpSecretValue(result, entry.secretValues ?? []);
    } catch (err) {
      // 传输层死亡（服务器退出/会话失效）时 onclose 已置 idle，下次调用自动重连；
      // 业务错误（isError / 服务器返回错误）不清连接
      const message = redactMcpSecretText(describeError(err), entry.secretValues ?? []);
      const code = (err as { code?: unknown } | null)?.code;
      recordMcpAudit({
        at: Date.now(),
        server: def.name,
        kind: "call",
        ok: false,
        ms: Date.now() - t0,
        detail: `${toolName}：${message}`,
      });
      const safe = new Error(message);
      if (code !== undefined) (safe as Error & { code?: unknown }).code = code;
      throw safe;
    }
  }

  /**
   * 以 task 形态调用工具（M2.1）。分流决策在 mcp-tools（shouldUseTask）；
   * 这里负责拿 ready 连接并透传进度回调。
   * result 分支已脱敏（result 即 CallToolResult）；error/pending 原样透传。
   */
  async callToolAsTask(
    def: McpServerDef,
    toolName: string,
    args: Record<string, unknown>,
    context: Omit<McpCallContext, "server" | "operation">,
    signal?: AbortSignal,
    onProgress?: McpTaskProgress,
  ): Promise<
    { kind: "result"; result: unknown } | Exclude<McpTaskOutcome, { kind: "result" }>
  > {
    const entry = await this.readyEntry(def);
    if (!entry.capabilities.tasks) {
      throw new Error(`MCP 服务器 "${def.name}" 未声明 tasks 能力（requests.tools.call）`);
    }
    const advertised = entry.tools.find((t) => t.name === toolName);
    if (!advertised) {
      throw new Error(
        `MCP 服务器 "${def.name}" 未提供工具 "${toolName}"：先用 mcp search 查看可用工具`,
      );
    }
    entry.lastUsedAt = Date.now();
    const outcome = await runInCallContext(entry, context, "tool", () =>
      callToolViaTask({
        client: entry.client!,
        server: def.name,
        tool: toolName,
        toolArgs: args,
        threadId: context.threadId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        signal,
        onProgress,
      }),
    );
    if (outcome.kind === "result") {
      return {
        kind: "result",
        result: redactMcpSecretValue(outcome.result, entry.secretValues ?? []),
      } as { kind: "result"; result: unknown };
    }
    return outcome;
  }

  /** 任务状态查询（协议命令 / 网关 task_status） */
  async taskStatus(
    def: McpServerDef,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; task: Task } | { ok: false; message: string }> {
    const entry = await this.readyEntry(def);
    if (!entry.capabilities.tasks) {
      return { ok: false, message: `MCP 服务器 "${def.name}" 未声明 tasks 能力` };
    }
    return getTaskStatus({ client: entry.client!, server: def.name, taskId, signal });
  }

  /** 任务结果取回（任务完成后） */
  async taskResult(
    def: McpServerDef,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
    const entry = await this.readyEntry(def);
    if (!entry.capabilities.tasks) {
      return { ok: false, message: `MCP 服务器 "${def.name}" 未声明 tasks 能力` };
    }
    const outcome = await getTaskResult({
      client: entry.client!,
      server: def.name,
      taskId,
      signal,
    });
    if (outcome.ok) {
      return { ok: true, result: redactMcpSecretValue(outcome.result, entry.secretValues ?? []) };
    }
    return outcome;
  }

  /** 任务取消：Stop 兜底与协议命令共用 */
  async taskCancel(
    def: McpServerDef,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; message?: string }> {
    const entry = await this.readyEntry(def);
    return cancelTask({ client: entry.client!, server: def.name, taskId, signal });
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

  /**
   * 插件工具目录预热：Codex 插件默认 lazy，但技能里写的是 `server.tool` /
   * “discover the tool”。若从未握手，mcp-cache 里没有工具面，search 就看不到。
   * 这里只对「没有 live 连接、也没有有效缓存」的插件服务器做一次后台握手，
   * 并发 2、最多 8 台，失败交给现有退避；完成后连接仍按 lazy 空闲回收。
   */
  warmCatalog(defs: McpServerDef[], concurrency = 2, maxServers = 8): void {
    const pending = defs
      .filter(
        (def) =>
          def.layer === "plugin" &&
          !def.manifestDisabled &&
          !this.getLiveTools(def) &&
          !getValidTools(def),
      )
      .slice(0, maxServers);
    if (pending.length === 0) return;
    let cursor = 0;
    let active = 0;
    const next = (): void => {
      while (active < concurrency && cursor < pending.length) {
        const def = pending[cursor++];
        active += 1;
        void this.ensureConnected(def)
          .catch(() => {
            /* 握手失败已由连接池落退避/日志/审计 */
          })
          .finally(() => {
            active -= 1;
            next();
          });
      }
    };
    next();
  }

  /**
   * 密钥值变更/删除后踢掉受影响连接：已有子进程的环境变量是 spawn 时快照，
   * 不主动断开就会一直拿旧值。下次调用会按当前绑定重新解析。
   */
  invalidateSecretValues(names: readonly string[]): number {
    const wanted = new Set(names);
    if (wanted.size === 0) return 0;
    let n = 0;
    for (const [name, entry] of [...this.entries]) {
      if (!entry.secretValues?.some((v) => wanted.has(v.name))) continue;
      this.disconnect(name, "secret_rotated");
      n += 1;
    }
    return n;
  }

  /** 断开并移除条目（连接池权威出口）；reason 进审计日志 */
  disconnect(name: string, reason = "manual"): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
    if (entry.client) {
      recordMcpAudit({ at: Date.now(), server: name, kind: "disconnect", detail: reason });
    }
    // 活跃调用栈随连接一起失效：残留的旧上下文会让重连后到达的 elicitation
    // 投到已断开的 thread（配置变更/LRU 驱逐/断线都会走这里）。
    entry.activeCalls.length = 0;
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
      { name: "kova-agent", version: "1.0.0" },
      {
        // M1 只支持 form elicitation；URL 模式没有稳定 UI，等 M1.1 之后再声明。
        capabilities: { elicitation: { form: {} } },
      },
    );
    registerElicitationHandler(client, def.name, () => entry.activeCalls.at(-1));
    client.onclose = () => {
      // 服务器退出/会话失效：下次调用重连（保留 entry 以承载退避/状态语义）
      if (this.entries.get(def.name)?.client === client) {
        entry.client = undefined;
        entry.tools = [];
        entry.resources = [];
        entry.resourceTemplates = [];
        entry.prompts = [];
        entry.capabilities = emptyMcpCapabilities();
        // 传输死亡同样作废活跃调用栈：在飞调用会以错误收场，重连前到达的
        // elicitation 不应再投给旧 thread
        entry.activeCalls.length = 0;
        if (entry.state === "ready") entry.state = "idle";
      }
    };
    client.onerror = (err) => {
      const text = redactMcpSecretText(
        err instanceof Error ? err.message : String(err),
        entry.secretValues ?? [],
      );
      logErr(`mcp[${def.name}]:`, text);
      this.pushLog(def.name, `传输错误：${text}`);
    };
    let transport: Transport;
    let stdioTransport: StdioClientTransport | undefined;
    // env_vars / env_http_headers / bearer_token_env_var 的值来自宿主环境，
    // 服务器回显到 stdout/stderr 时同样要脱敏；这里把它们并入 secretValues。
    const envSecrets: McpResolvedSecret[] = [];
    if (def.transport === "stdio") {
      const launch = resolveStdioLaunch(def, entry.secretEnv);
      for (const name of def.envVars ?? []) {
        const value = launch.env[name];
        if (value) envSecrets.push({ name, value });
      }
      if (def.pluginDataRoot) {
        try {
          mkdirSync(def.pluginDataRoot, { recursive: true });
        } catch (err) {
          this.pushLog(
            def.name,
            `创建插件数据目录失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (launch.note) this.pushLog(def.name, launch.note);
      stdioTransport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: launch.env,
        ...(def.cwd ? { cwd: def.cwd } : {}),
        stderr: "pipe",
      });
      transport = stdioTransport;
    } else {
      // OAuth 凭据挂载策略：交互会话的 provider（授权流进行中）优先；
      // 否则仅在已存过凭据时挂静默 provider（过期自动刷新）。全新未授权的
      // 服务器不挂 provider——裸 401 由下面按状态码点亮 needsAuth。
      const provider = oauth?.provider ?? silentOAuthProvider(String(def.url ?? ""));
      // 密钥请求头绑定（M2.2）：解析出的值覆盖同名 literal header——
      // 用户配置 { Authorization: "Bearer <占位>" } 后绑定密钥是期望行为，
      // 与 stdio env 的覆盖语义一致。
      const headerMap: Record<string, string> = {
        ...(def.headers ?? {}),
        ...(entry.secretHeaders ?? {}),
      };
      // Codex env_http_headers：header 名 → 宿主环境变量名；env 派生值覆盖 literal
      for (const [header, envName] of Object.entries(def.envHttpHeaders ?? {})) {
        const value = process.env[envName];
        if (value !== undefined && value !== "") {
          headerMap[header] = value;
          envSecrets.push({ name: envName, value });
        } else {
          this.pushLog(def.name, `env_http_headers "${header}" 缺少环境变量 ${envName}`);
        }
      }
      // Codex bearer_token_env_var：没有显式 Authorization 时补 Bearer
      if (def.bearerTokenEnvVar) {
        const token = process.env[def.bearerTokenEnvVar];
        if (
          token &&
          !Object.keys(headerMap).some((key) => key.toLowerCase() === "authorization")
        ) {
          headerMap.Authorization = `Bearer ${token}`;
          envSecrets.push({ name: def.bearerTokenEnvVar, value: token });
        } else if (!token) {
          this.pushLog(
            def.name,
            `bearer_token_env_var 缺少环境变量 ${def.bearerTokenEnvVar}，请求将不带 Bearer token`,
          );
        }
      }
      let headers: Record<string, string> | undefined =
        Object.keys(headerMap).length > 0 ? headerMap : undefined;
      // SDK 的 header 合并顺序是 requestInit 覆盖 OAuth Bearer（_commonHeaders
      // 里 {...authHeaders, ...extraHeaders}），配置里残留的静态 Authorization
      // 会把授权换来的 token 顶掉——已有真凭据时以 token 为准，剥掉它。
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
    // stderr 必须被消费：SDK 的 PassThrough 只 pipe 不读，写得多的服务器会把
    // 子进程 stderr 缓冲写满并卡住。日志先脱敏（密钥可能被服务器回显）。
    stdioTransport?.stderr?.on("data", (chunk: Buffer | string) => {
      const text = redactMcpSecretText(String(chunk), entry.secretValues ?? [])
        .trim()
        .slice(0, 4000);
      if (text) {
        logErr(`mcp[${def.name}] stderr:`, text);
        // 留最后一段给失败提示用：SDK 只会报 "Connection closed"，真正原因
        // （脚本缺失、node 版本不符、依赖没装）通常只在这条 stderr 里。
        // 分块数据可能从单词中间切开：用换行连接，别把两块直接粘成错字。
        const combined = entry.lastStderr ? `${entry.lastStderr}\n${text}` : text;
        entry.lastStderr = combined.slice(-1200).trim();
      }
    });
    if (envSecrets.length) {
      const merged = [...(entry.secretValues ?? [])];
      for (const secret of envSecrets) {
        if (!merged.some((item) => item.name === secret.name && item.value === secret.value)) {
          merged.push(secret);
        }
      }
      entry.secretValues = merged;
    }
    return { client, transport };
  }

  private async handshake(entry: Entry, oauth?: InteractiveOAuthSession): Promise<McpToolMeta[]> {
    const { def } = entry;
    const t0 = Date.now();
    entry.state = "connecting";
    entry.message = undefined;
    entry.needsAuth = false;
    // 每次握手重新收集 stderr：上一次失败的尾注不能串到这一次
    entry.lastStderr = undefined;
    // 活跃连接上限：超出按 lastUsedAt 驱逐最旧的一个 ready 连接
    if (!entry.client && this.activeCount >= MAX_ACTIVE_CONNECTIONS) {
      this.evictOldest();
    }
    const connectTimeout = def.startupTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    const connectTimeoutMsg = `连接 MCP 服务器 "${def.name}" 超时（${connectTimeout / 1000}s）`;
    let conn: { client: Client; transport: Transport } | undefined;
    try {
      conn = this.createConnection(entry, oauth);
      try {
        await withTimeout(conn.client.connect(conn.transport), connectTimeout, connectTimeoutMsg);
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
        await withTimeout(conn.client.connect(conn.transport), connectTimeout, connectTimeoutMsg);
      }
      const tools = await withTimeout(
        this.listTools(conn.client),
        connectTimeout,
        `获取 MCP 服务器 "${def.name}" 工具列表超时`,
      );
      // resources/prompts 是可选能力：列表失败只降级为空并记日志，绝不把整个
      // 连接打成 backoff（tools-only 服务器/老服务器必须保持原行为）。
      const capabilityMeta = await this.loadCapabilityMeta(conn.client, def.name);
      // 发布前确认条目仍是连接池里的那一个：配置变更（applyConfig/删除）会摘除
      // 条目，而握手可能正并发进行（后台预连 prewarm、派活式的测试/展开工具），
      // 落点就成了已被顶替的旧条目——那样连接即使建好也无人可见（reaper 遍历池、
      // statusFor 按池查），只会白白挂着。就地关掉，交给下次调用按新配置重连。
      if (this.entries.get(def.name) !== entry) {
        try {
          conn.client.close();
        } catch {
          /* 关闭失败不影响语义 */
        }
        return tools;
      }
      entry.client = conn.client;
      entry.state = "ready";
      entry.tools = tools;
      entry.resources = capabilityMeta.resources;
      entry.resourceTemplates = capabilityMeta.resourceTemplates;
      entry.prompts = capabilityMeta.prompts;
      entry.capabilities = capabilityMeta.capabilities;
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
      updateServerMeta(def, {
        tools,
        resources: entry.resources,
        resourceTemplates: entry.resourceTemplates,
        prompts: entry.prompts,
        capabilities: entry.capabilities,
      });
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
        const detail = describeError(err);
        // "Connection closed" 是 SDK 的表面错误；脚本缺失、node 版本不符、
        // 依赖没装这些真实原因通常只在子进程 stderr 里。取最后几行一并给出。
        // 显式重声明属性类型：握手开头把它清成 undefined，TS 会把后续读取窄化成 never
        const stderrTail = (entry as { lastStderr?: string }).lastStderr;
        const stderr = stderrTail
          ?.trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-3)
          .join(" | ");
        entry.message =
          stderr && !detail.includes(stderr)
            ? `${detail}（服务器 stderr：${stderr.slice(0, 500)}）`
            : detail;
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
      entry.resources = [];
      entry.resourceTemplates = [];
      entry.prompts = [];
      entry.capabilities = emptyMcpCapabilities();
      try {
        conn?.client.close();
      } catch {
        /* 传输未建立时的关闭容错 */
      }
      // 有 stderr 尾注时把增强后的消息抛给调用方（工具调用/设置页重连都直接显示），
      // 否则保留原始错误类型（OAuth 401 等靠 code 判定的路径不受影响）
      if (!entry.needsAuth && entry.message !== describeError(err)) {
        throw new Error(entry.message);
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
        const taskSupport = tool.execution?.taskSupport;
        const ui = parseToolUiMeta(
          (tool as { _meta?: unknown })._meta,
        );
        collected.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          ...(taskSupport === "optional" || taskSupport === "required" || taskSupport === "forbidden"
            ? { taskSupport }
            : {}),
          ...(ui ? { ui } : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return collected;
  }

  /**
   * 拉取 resources/prompts。这两个能力都是可选的，默认降级：
   * - 服务器没声明 → 空数组 + false
   * - 声明了但列表失败/超时 → 空数组 + 保留 true，下一次重连或设置页刷新再试
   * 失败只进日志，不把工具连接打成 backoff。
   */
  private async loadCapabilityMeta(
    client: Client,
    name: string,
  ): Promise<McpCapabilityMeta> {
    const caps = client.getServerCapabilities();
    const capabilities: McpCapabilityFlags = {
      resources: Boolean(caps?.resources),
      prompts: Boolean(caps?.prompts),
      // tasks 主能力 + tools/call 子能力（SDK isToolTask 的闸门是后者）：
      // 只声明 tasks 而不接 tools/call 的服务器对我们没有 task 化价值
      tasks: Boolean(caps?.tasks?.requests?.tools?.call),
    };
    const [resourceSnapshot, prompts] = await Promise.all([
      capabilities.resources
        ? this.safeCapabilityList(name, "资源列表", () => this.listResourcesForClient(client))
        : Promise.resolve(null),
      capabilities.prompts
        ? this.safeCapabilityList(name, "Prompt 列表", () => this.listPromptsForClient(client))
        : Promise.resolve(null),
    ]);
    return {
      resources: resourceSnapshot?.resources ?? [],
      resourceTemplates: resourceSnapshot?.resourceTemplates ?? [],
      prompts: prompts ?? [],
      capabilities,
    };
  }

  private async safeCapabilityList<T>(
    server: string,
    label: string,
    load: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await withTimeout(
        load(),
        MCP_CONNECT_TIMEOUT_MS,
        `${label}获取超时`,
      );
    } catch (err) {
      this.pushLog(server, `${label}获取失败：${describeError(err)}`);
      return null;
    }
  }

  private async listResourcesForClient(client: Client): Promise<McpResourceSnapshot> {
    const resources: McpResourceMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CAPABILITY_PAGES; page += 1) {
      const result = await client.listResources(cursor ? { cursor } : undefined);
      for (const resource of result.resources ?? []) {
        if (resources.length >= MAX_RESOURCES_PER_SERVER) break;
        const uri = boundedText(resource.uri, 4_000);
        const name = boundedText(resource.name, 200);
        if (!uri || !name) continue;
        const title = boundedText(resource.title, 200);
        const description = boundedText(resource.description);
        const mimeType = boundedText(resource.mimeType, 200);
        resources.push({
          uri,
          name,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(typeof resource.size === "number" && Number.isFinite(resource.size)
            ? { size: Math.max(0, Math.floor(resource.size)) }
            : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor || resources.length >= MAX_RESOURCES_PER_SERVER) break;
    }

    const resourceTemplates: McpResourceTemplateMeta[] = [];
    cursor = undefined;
    for (let page = 0; page < MAX_CAPABILITY_PAGES; page += 1) {
      const result = await client.listResourceTemplates(cursor ? { cursor } : undefined);
      for (const template of result.resourceTemplates ?? []) {
        if (resourceTemplates.length >= MAX_RESOURCES_PER_SERVER) break;
        const uriTemplate = boundedText(template.uriTemplate, 4_000);
        const name = boundedText(template.name, 200);
        if (!uriTemplate || !name) continue;
        const title = boundedText(template.title, 200);
        const description = boundedText(template.description);
        const mimeType = boundedText(template.mimeType, 200);
        resourceTemplates.push({
          uriTemplate,
          name,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(mimeType ? { mimeType } : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor || resourceTemplates.length >= MAX_RESOURCES_PER_SERVER) break;
    }
    return { resources, resourceTemplates };
  }

  private async listPromptsForClient(client: Client): Promise<McpPromptMeta[]> {
    const prompts: McpPromptMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CAPABILITY_PAGES; page += 1) {
      const result = await client.listPrompts(cursor ? { cursor } : undefined);
      for (const prompt of result.prompts ?? []) {
        if (prompts.length >= MAX_PROMPTS_PER_SERVER) break;
        const name = boundedText(prompt.name, 200);
        if (!name) continue;
        const title = boundedText(prompt.title, 200);
        const description = boundedText(prompt.description);
        const args = (prompt.arguments ?? [])
          .map((arg) => {
            const argName = boundedText(arg.name, 200);
            if (!argName) return null;
            const argDescription = boundedText(arg.description);
            return {
              name: argName,
              ...(argDescription ? { description: argDescription } : {}),
              ...(arg.required === true ? { required: true } : {}),
            };
          })
          .filter((arg): arg is NonNullable<typeof arg> => arg !== null);
        prompts.push({
          name,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(args.length > 0 ? { arguments: args } : {}),
        });
      }
      cursor = result.nextCursor;
      if (!cursor || prompts.length >= MAX_PROMPTS_PER_SERVER) break;
    }
    return prompts;
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
