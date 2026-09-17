/**
 * Claude Code 式生命周期钩子（hooks）：
 * 用户在设置里登记外部命令（command + args + 事件 + matcher），sidecar 在
 * 对应事件点以子进程执行命令，JSON 负载经 stdin 传入（无 shell、无 argv 拼接，
 * 杜绝注入）。决策语义（仅 PreToolUse / PermissionRequest 生效）：
 *   exit 2                     → block（stderr 为 reason）
 *   exit 0 + stdout {"decision":"approve"|"block","reason"} → 对应决策
 *   spawn 失败 / 其他非零 / 超时 → 静默放行（仅记日志）
 * 配置事实源在 sidecar kv（键 pi.hooks），桌面端经 set_hooks/get_hooks 推拉
 * （同 memory 链路）；sidecar 重启自动恢复。
 */
import { spawn } from "node:child_process";
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

/** 事件名与 Claude Code 官方清单 1:1 对齐 */
export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

export interface HookConfig {
  id: string;
  name: string;
  command: string;
  /** shell 命令类型的解释器，空 = $SHELL ?? /bin/sh；仅 type="shell" 生效 */
  shell?: string;
  args?: string[];
  /** "shell"（整串交 shell 解释，默认）| "process"（argv 直接执行） */
  type?: "process" | "shell";
  event: HookEventName;
  /**
   * 工具名匹配；仅 tool 类事件生效。两种写法：
   *  - 含逗号 → 逗号分隔的精确工具名列表（"Write, Edit, Bash"）
   *  - 不含逗号 → 按正则解释（"^bash$"）；空 = 全部
   */
  matcher?: string;
  /** 单命令超时 ms，默认 10s，钳制 [1s, 120s] */
  timeoutMs?: number;
  /**
   * 后台运行：不等待命令结束（决策类事件视为无决策，仅通知效果）；
   * 超时仍会 kill，防止僵尸进程
   */
  background?: boolean;
  enabled: boolean;
}

export interface HookPayload {
  event: HookEventName;
  sessionId: string;
  threadId?: string;
  timestamp: string;
  /** 仅 SessionStart：create = 新建，resume = 恢复历史会话 */
  source?: "create" | "resume";
  /** 仅 UserPromptSubmit */
  prompt?: string;
  /** 仅 tool 类事件 */
  tool?: { name: string; args?: unknown };
  /** 仅 PostToolUse / PostToolUseFailure */
  result?: { isError: boolean; summary?: string };
}

export interface HookDecision {
  decision: "block" | "approve";
  reason?: string;
}

const HOOKS_KV_KEY = "pi.hooks";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const TEXT_LIMIT = 2_000;
/** stdout/stderr 累积上限，防失控命令把内存吃穿 */
const PIPE_CAP = 64 * 1024;

const TOOL_EVENTS: ReadonlySet<HookEventName> = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
]);

let configs: HookConfig[] = [];
let stateLoad: Promise<void> | undefined;

/** 启动装配调一次（index.ts 闸门内）；幂等（同 skills 的 stateLoad 模式） */
export function initHooks(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(HOOKS_KV_KEY);
      if (!row?.value) return;
      const parsed = JSON.parse(row.value) as HookConfig[];
      configs = Array.isArray(parsed) ? parsed.filter(isHookConfig) : [];
    } catch (err) {
      logErr("hooks:", err instanceof Error ? err.message : String(err));
    }
  })();
  return stateLoad;
}

function isHookConfig(v: unknown): v is HookConfig {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Partial<HookConfig>;
  return (
    typeof h.id === "string" &&
    typeof h.command === "string" &&
    typeof h.event === "string" &&
    typeof h.enabled === "boolean"
  );
}

/** 全量覆盖（桌面端 set_hooks 推送）；非法条目剔除，id 缺失补 uuid */
export async function setHookConfigs(list: unknown): Promise<void> {
  configs = Array.isArray(list)
    ? list.filter(isHookConfig).map((h, i) => ({
        ...h,
        id: h.id || `hook-${i}-${Date.now().toString(36)}`,
      }))
    : [];
  try {
    await kvSet(HOOKS_KV_KEY, JSON.stringify(configs));
  } catch (err) {
    logErr("hooks save:", err instanceof Error ? err.message : String(err));
  }
}

export function getHookConfigs(): HookConfig[] {
  return configs.map((h) => ({ ...h }));
}

/** 事件 + matcher 过滤后的启用钩子 */
export function matchingHooks(event: HookEventName, toolName?: string): HookConfig[] {
  return configs.filter((h) => {
    if (!h.enabled || h.event !== event) return false;
    if (toolName !== undefined) return matches(h.matcher, toolName);
    return true;
  });
}

function matches(matcher: string | undefined, toolName: string): boolean {
  const m = matcher?.trim();
  if (!m) return true;
  // 含逗号：逗号分隔的精确工具名列表（对 UI 更友好，"Write, Edit, Bash"）
  if (m.includes(",")) {
    return m
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(toolName);
  }
  try {
    return new RegExp(m).test(toolName);
  } catch {
    return m === toolName;
  }
}

export function truncateHookText(text: unknown): string | undefined {
  if (text === null || text === undefined) return undefined;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  if (!s) return undefined;
  return s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT)}…[truncated]` : s;
}

export function buildHookPayload(base: {
  event: HookEventName;
  sessionId: string;
  threadId?: string;
  source?: "create" | "resume";
  prompt?: unknown;
  toolName?: string;
  toolArgs?: unknown;
  isError?: boolean;
  resultSummary?: unknown;
}): HookPayload {
  const payload: HookPayload = {
    event: base.event,
    sessionId: base.sessionId,
    timestamp: new Date().toISOString(),
  };
  if (base.threadId) payload.threadId = base.threadId;
  if (base.source) payload.source = base.source;
  const prompt = truncateHookText(base.prompt);
  if (prompt) payload.prompt = prompt;
  if (base.toolName && TOOL_EVENTS.has(base.event)) {
    payload.tool = { name: base.toolName, args: base.toolArgs };
  }
  if (base.isError !== undefined || base.resultSummary !== undefined) {
    payload.result = {
      isError: base.isError ?? false,
      summary: truncateHookText(base.resultSummary),
    };
  }
  return payload;
}

/** 通知类事件：fire-and-forget，决策结果丢弃 */
export function fireHookEvent(event: HookEventName, payload: HookPayload): void {
  void runHooks(event, payload).catch((err) => {
    logErr(`hooks ${event}:`, err instanceof Error ? err.message : String(err));
  });
}

/** 决策类事件（PreToolUse / PermissionRequest）：顺序执行，首个 block 立即生效；
 * 无 block 时返回首个 approve（供调用方跳过审批）。纯通知事件忽略返回值 */
export async function runHooks(
  event: HookEventName,
  payload: HookPayload,
): Promise<HookDecision | undefined> {
  const hooks = matchingHooks(event, payload.tool?.name);
  let approved: HookDecision | undefined;
  for (const hook of hooks) {
    const decision = await callExecHook(hook, payload);
    if (decision?.decision === "block") return decision;
    if (decision?.decision === "approve" && !approved) approved = decision;
  }
  return approved;
}

async function execHook(hook: HookConfig, payload: HookPayload): Promise<HookDecision | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const done = (d?: HookDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(d);
    };
    const timeout = Math.min(
      Math.max(hook.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const timer = setTimeout(() => {
      logErr(`hooks ${hook.name}: timeout after ${timeout}ms, killed`);
      try {
        child?.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      done();
    }, timeout);
    timer.unref?.();
    try {
      if (hook.type === "shell") {
        // shell 类型：整串命令交 shell 解释（$SHELL / 指定 shell / 兜底 /bin/sh）
        const shell = hook.shell?.trim() || process.env.SHELL || "/bin/sh";
        child = spawn(shell, ["-c", hook.command], { stdio: ["pipe", "pipe", "pipe"] });
      } else {
        // 默认 process：argv 直接执行，不经 shell
        child = spawn(hook.command, hook.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
      }
    } catch (err) {
      logErr(`hooks ${hook.name}:`, err instanceof Error ? err.message : String(err));
      return done();
    }
    // 后台运行：不等结果（决策类视为无决策）；超时 kill 与错误日志照常生效
    if (hook.background) done();
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < PIPE_CAP) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < PIPE_CAP) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      logErr(`hooks ${hook.name}:`, err.message);
      done();
    });
    child.on("close", (code) => {
      if (code === 2) {
        done({ decision: "block", reason: stderr.trim() || "Blocked by hook" });
        return;
      }
      if (code !== 0) {
        logErr(`hooks ${hook.name}: exit ${code ?? "signal"}`);
        return done();
      }
      done(parseDecision(stdout));
    });
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      /* 进程已退出，close 分支兜底 */
    }
    child.unref();
  });
}

function parseDecision(stdout: string): HookDecision | undefined {
  const raw = stdout.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { decision?: unknown; reason?: unknown };
    if (parsed.decision === "block" || parsed.decision === "approve") {
      return {
        decision: parsed.decision,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    }
  } catch {
    /* 非 JSON stdout：通知式输出，无决策 */
  }
  return undefined;
}

/** 测试钩子：替换真实 spawn（仿 mcp-oauth 的 setBrowserOpenerForTest） */
export function setHooksExecutorForTest(fn: typeof execHook): void {
  execHookOverride = fn;
}
let execHookOverride: typeof execHook | undefined;

// runHooks 内经此间接调用 execHook，测试可注入
function callExecHook(hook: HookConfig, payload: HookPayload) {
  return (execHookOverride ?? execHook)(hook, payload);
}

/** 测试钩子：清空配置与 kv 装载缓存 */
export function resetHooksForTest(): void {
  configs = [];
  stateLoad = undefined;
  execHookOverride = undefined;
}
