/**
 * Claude Code 式生命周期钩子（hooks）：
 * 用户在设置里登记外部命令（command + args + 事件 + matcher），sidecar 在
 * 对应事件点以子进程执行命令，JSON 负载经 stdin 传入（不拼 argv，杜绝注入）。
 * 决策语义（仅 PreToolUse / PermissionRequest 生效）：
 *   exit 2                     → block（stderr 为 reason）
 *   exit 0 + stdout {"decision":"approve"|"block","reason"} → 对应决策
 *   exit 0 + Claude hookSpecificOutput（permissionDecision / decision.behavior）→ 对应决策
 *   spawn 失败 / 其他非零 / 超时 → 静默放行（仅记日志）
 * 配置事实源在 sidecar kv（键 pi.hooks），桌面端经 set_hooks/get_hooks 推拉
 * （同 memory 链路）；sidecar 重启自动恢复。
 *
 * 安全边界：钩子是用户/插件显式配置的本机命令，按 Claude Code 语义**不经过**
 * bash 工具的沙箱（sandbox 档位只约束 agent 工具调用）；只应启用可信插件。 */
import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { activePluginHooks } from "../plugins/plugins";
import { kvGet, kvSet } from "../storage/hostdb";
import { sessionPath, sessionsDirRoot } from "../storage/storage";
import { resolveShellCommand } from "../local-host/shell-resolve";
import { logErr } from "../log";
import type { ApprovalLevel, SessionMode } from "../types";

/** 事件名与 Claude Code 官方清单对齐 */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreModelRequest"
  | "PostModelRequest"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "Interrupt";

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
   * 匹配目标按事件取：tool 类按工具名；SessionStart 按 source（startup 兼容
   * create）；SubagentStop 按子代理名；PreCompact 按 manual/auto；Notification
   * 按 kind。两种写法：
   *  - 含逗号 → 逗号分隔的精确值列表（"Write, Edit, Bash"）
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
  /** Codex commandWindows：Windows 上替代 command 的命令串 */
  commandWindows?: string;
  /** Codex onFailure：非零退出时是否阻断（默认 continue） */
  onFailure?: "continue" | "block";
  /** Codex statusMessage：运行中给用户看的状态文案（详情页展示） */
  statusMessage?: string;
  /** 插件钩子的进程 cwd（Codex 插件以插件根为 cwd） */
  cwd?: string;
  /** 插件根/数据根：注入 PLUGIN_ROOT / PLUGIN_DATA 环境变量 */
  pluginRoot?: string;
  pluginDataRoot?: string;
  enabled: boolean;
}

export interface HookPayload {
  event: HookEventName;
  sessionId: string;
  threadId?: string;
  thread_id?: string;
  timestamp: string;
  /** Claude Code 兼容别名（= event） */
  hook_event_name?: HookEventName;
  /** Claude Code 兼容别名（= sessionId） */
  session_id?: string;
  /** Codex hooks：当前轮 id（= prompt reqId） */
  turnId?: string;
  /** Codex hooks 扁平别名（= turnId） */
  turn_id?: string;
  /** Codex hooks：模型标识 / 权限档 / 会话 JSONL（由 hookRunOptions 补） */
  model?: string;
  permissionMode?: string;
  permission_mode?: string;
  transcriptPath?: string;
  transcript_path?: string;
  /** only Pre/PostModelRequest */
  attemptNumber?: number;
  attempt_number?: number;
  requestId?: string;
  request_id?: string;
  kind?: "sampling" | "foreground_compaction" | "background_compaction";
  /** only PostModelRequest */
  status?: "completed" | "failed" | "cancelled";
  response_id?: string | null;
  error?: string | null;
  token_usage?: Record<string, number> | null;
  /** 会话工作区（runHooks 有 workspace 上下文时补上） */
  cwd?: string;
  /** 仅 SessionStart：create = 新建，resume = 恢复历史会话 */
  source?: "create" | "resume";
  /** 仅 UserPromptSubmit */
  prompt?: string;
  /** 仅 tool 类事件 */
  tool?: { name: string; args?: unknown };
  /** 仅 tool 类事件：Claude Code 兼容扁平别名 */
  tool_name?: string;
  tool_input?: unknown;
  /** 仅 PostToolUse / PostToolUseFailure */
  result?: { isError: boolean; summary?: string };
  /** 仅 SubagentStop */
  subagent?: { id: string; name?: string; status?: string };
  /** 仅 PreCompact */
  compaction?: { trigger: string; tokensBefore?: number };
  /** 仅 Notification：permission = 即将弹审批，question = 向用户提问 */
  notification?: { kind: "permission" | "question"; message?: string };
}

export interface HookDecision {
  decision: "block" | "approve";
  reason?: string;
  /** Claude `continue: false`：block 时提示调用方本批工具后终止循环 */
  stop?: boolean;
  /** Claude `systemMessage`：给用户看的提示（当前记录日志） */
  systemMessage?: string;
}

/** 单条钩子的原始输出：决策字段都可选，SessionStart 等事件可能只给 context */
export interface HookOutput {
  decision?: "block" | "approve";
  reason?: string;
  stop?: boolean;
  systemMessage?: string;
  /** Claude `hookSpecificOutput.additionalContext`（SessionStart 注入上下文） */
  context?: string;
}

/** 一次事件全部钩子的汇总：决策 + 合并后的注入上下文 */
export interface HookRunResult {
  decision?: HookDecision;
  context?: string;
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

/** 全量覆盖（桌面端 set_hooks 推送）；非法条目剔除，空 id 补 uuid。
 *  返回是否已持久化：先落 kv 再提交内存，失败时内存保持旧配置，
 *  协议层据 false 回错误帧，避免 UI 显示保存成功而重启后丢失。 */
export async function setHookConfigs(list: unknown): Promise<boolean> {
  const next = Array.isArray(list)
    ? list.filter(isHookConfig).map((h, i) => ({
        ...h,
        id: h.id || `hook-${i}-${Date.now().toString(36)}`,
      }))
    : [];
  try {
    await kvSet(HOOKS_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("hooks save:", err instanceof Error ? err.message : String(err));
    return false;
  }
  configs = next;
  return true;
}

export function getHookConfigs(): HookConfig[] {
  return configs.map((h) => ({ ...h }));
}

/** 钩子执行前的解析结果：手配钩子仅 HookConfig，插件钩子额外带展开元数据 */
export type ResolvedHook = HookConfig & {
  /** 展开时命中 ${BUN}：spawn 需补 BUN_BE_BUN=1（编译态 sidecar 充当 bun CLI） */
  usedBun?: boolean;
  /** 插件根：spawn 时注入 CLAUDE_PLUGIN_ROOT（兼容 `$CLAUDE_PLUGIN_ROOT` 写法） */
  pluginRoot?: string;
};

/** 运行时上下文：通知/决策事件都按当前会话工作区展开插件钩子占位符 */
export type HookRunOptions = {
  workspace?: string;
  /** Codex 通用 payload 字段（runHooksCollect 统一补进 payload） */
  model?: string;
  permissionMode?: string;
  transcriptPath?: string;
  attemptNumber?: number;
  requestId?: string;
  samplingKind?: "sampling" | "foreground_compaction" | "background_compaction";
  /** only PostModelRequest */
  status?: "completed" | "failed" | "cancelled";
  responseId?: string | null;
  error?: string | null;
  tokenUsage?: Record<string, number> | null;
};

function permissionModeForRun(
  mode: SessionMode | undefined,
  approvalLevel: ApprovalLevel | undefined,
): string {
  if (mode === "plan") return "plan";
  switch (approvalLevel) {
    case "auto":
      return "bypassPermissions";
    case "auto-edit":
    case "workspace-write":
      return "acceptEdits";
    default:
      return "default";
  }
}

/** 从活动 run 生成 Codex 兼容的 hook 运行时上下文（模型/权限档/transcript）。 */
export function hookRunOptions(
  run: {
    cwd: string;
    sessionId: string;
    mode?: SessionMode;
    approvalLevel?: ApprovalLevel;
    agent?: { state?: { model?: { id?: string } | null } };
  },
  extra?: Partial<
    Pick<
      HookRunOptions,
      | "attemptNumber"
      | "requestId"
      | "samplingKind"
      | "status"
      | "responseId"
      | "error"
      | "tokenUsage"
      | "model"
    >
  >,
): HookRunOptions {
  const model = extra?.model ?? run.agent?.state?.model?.id;
  const transcriptRoot = sessionsDirRoot();
  return {
    workspace: run.cwd,
    ...(model ? { model } : {}),
    permissionMode: permissionModeForRun(run.mode, run.approvalLevel),
    ...(transcriptRoot
      ? { transcriptPath: sessionPath(run.sessionId) }
      : {}),
    ...extra,
  };
}

/** 钩子输出 systemMessage 时的 UI 通知（由 sidecar 入口注入协议 send 实现） */
export interface HookSystemMessage {
  sessionId: string;
  threadId?: string;
  event: HookEventName;
  hookName: string;
  text: string;
}
let systemMessageSink: ((message: HookSystemMessage) => void) | undefined;

/** 注册 systemMessage 出口（协议层转发为 hook_message 自发帧；传 undefined 注销） */
export function setHookSystemMessageSink(
  sink: ((message: HookSystemMessage) => void) | undefined,
): void {
  systemMessageSink = sink;
}

/** 事件 + matcher 过滤后的启用钩子（手配 kv 钩子 + 启用插件的 hooks 组件垫底）。
 *  matchTargets 为 undefined 表示该事件没有匹配目标（UserPromptSubmit/Stop 等），
 *  matcher 不参与过滤；SessionStart 传 source 的候选值（create 兼容 startup）。 */
export function matchingHooks(
  event: HookEventName,
  matchTargets?: string | readonly string[],
  workspace?: string,
): ResolvedHook[] {
  const targets =
    typeof matchTargets === "string"
      ? [matchTargets]
      : matchTargets === undefined
        ? undefined
        : [...matchTargets];
  const accepts = (matcher: string | undefined) =>
    targets === undefined || targets.some((target) => matches(matcher, target));
  const manual = configs.filter((h) => h.enabled && h.event === event && accepts(h.matcher));
  const plugin = activePluginHooks(workspace).filter(
    (h) => h.event === event && accepts(h.matcher),
  );
  return [...manual, ...plugin];
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

/** 工具结果 content 块 → 文本摘要（PostToolUse 通知用；截断交给 buildHookPayload） */
export function hookResultSummary(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function buildHookPayload(base: {
  event: HookEventName;
  sessionId: string;
  threadId?: string;
  turnId?: string;
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
    // Claude 生态脚本按 hook_event_name / session_id / tool_name / tool_input
    // 取字段；保留本项目驼峰字段的同时给一份扁平别名。
    hook_event_name: base.event,
    session_id: base.sessionId,
  };
  if (base.threadId) {
    payload.threadId = base.threadId;
    payload.thread_id = base.threadId;
  }
  if (base.turnId) {
    payload.turnId = base.turnId;
    payload.turn_id = base.turnId;
  }
  if (base.source) payload.source = base.source;
  const prompt = truncateHookText(base.prompt);
  if (prompt) payload.prompt = prompt;
  if (base.toolName && TOOL_EVENTS.has(base.event)) {
    payload.tool = { name: base.toolName, args: base.toolArgs };
    payload.tool_name = base.toolName;
    payload.tool_input = base.toolArgs;
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
export function fireHookEvent(
  event: HookEventName,
  payload: HookPayload,
  options?: HookRunOptions,
): void {
  void runHooks(event, payload, options).catch((err) => {
    logErr(`hooks ${event}:`, err instanceof Error ? err.message : String(err));
  });
}

/** 决策类事件（PreToolUse / PermissionRequest）：匹配钩子并行执行（对齐 Claude
 *  Code，避免 N 个慢钩子叠加延迟）；任一 block 生效（按配置顺序取第一个），
 *  无 block 时返回首个 approve（供调用方跳过审批）。纯通知事件忽略返回值 */
export async function runHooks(
  event: HookEventName,
  payload: HookPayload,
  options?: HookRunOptions,
): Promise<HookDecision | undefined> {
  return (await runHooksCollect(event, payload, options)).decision;
}

/** 执行匹配钩子并汇总决策 + additionalContext（SessionStart 注入用）。 */
export async function runHooksCollect(
  event: HookEventName,
  payload: HookPayload,
  options?: HookRunOptions,
): Promise<HookRunResult> {
  // matcher 目标按事件取：tool 类按工具名；SessionStart 按 source（CC 的
  // startup 等同本项目 create）；SubagentStop 按子代理名；PreCompact 按
  // manual/auto（threshold/overflow 归 auto）；Notification 按 kind。
  const matchTargets = (() => {
    if (payload.tool?.name !== undefined) return payload.tool.name;
    if (event === "SessionStart" && payload.source) {
      return payload.source === "create" ? [payload.source, "startup"] : [payload.source];
    }
    if ((event === "SubagentStart" || event === "SubagentStop") && payload.subagent?.name) {
      return payload.subagent.name;
    }
    if (event === "PreCompact" && payload.compaction) {
      return payload.compaction.trigger === "manual"
        ? ["manual"]
        : [payload.compaction.trigger, "auto"];
    }
    if (event === "Notification" && payload.notification) {
      // CC 生态常用 permission_prompt 作为该通知类型名
      return payload.notification.kind === "permission"
        ? ["permission", "permission_prompt"]
        : [payload.notification.kind];
    }
    return undefined;
  })();
  let hooks: ResolvedHook[];
  try {
    hooks = matchingHooks(event, matchTargets, options?.workspace);
  } catch (err) {
    // 插件扫描/读盘异常不能让工具调用或整轮 prompt 失败：钩子是旁路
    logErr("hooks matching:", err instanceof Error ? err.message : String(err));
    return {};
  }
  // 工作区既作为 spawn cwd，也作为 payload.cwd / CLAUDE_PROJECT_DIR 暴露给
  // 钩子——Claude 生态的插件脚本普遍依赖 CLAUDE_PROJECT_DIR 找项目根。
  // Codex 兼容字段在 runHooksCollect 统一补齐（模型/权限档/transcript/模型请求
  // 的 request/attempt/status 等），避免每个触发点重复拼。
  const effectivePayload: HookPayload = {
    ...payload,
    ...(options?.workspace ? { cwd: payload.cwd ?? options.workspace } : {}),
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.permissionMode
      ? {
          permissionMode: options.permissionMode,
          permission_mode: options.permissionMode,
        }
      : {}),
    ...(options?.transcriptPath
      ? {
          transcriptPath: options.transcriptPath,
          transcript_path: options.transcriptPath,
        }
      : {}),
    ...(options?.attemptNumber !== undefined
      ? {
          attemptNumber: options.attemptNumber,
          attempt_number: options.attemptNumber,
        }
      : {}),
    ...(options?.requestId
      ? { requestId: options.requestId, request_id: options.requestId }
      : {}),
    ...(options?.samplingKind ? { kind: options.samplingKind } : {}),
    ...(options?.status ? { status: options.status } : {}),
    ...(options?.responseId !== undefined
      ? { response_id: options.responseId }
      : {}),
    ...(options?.error !== undefined ? { error: options.error } : {}),
    ...(options?.tokenUsage !== undefined
      ? { token_usage: options.tokenUsage }
      : {}),
  };
  // 并行执行：总延迟由最慢的钩子决定，而不是逐个叠加。Promise.all 保持结果
  // 顺序 = 配置顺序，block 覆盖 approve。
  const results = await Promise.all(
    hooks.map((hook) =>
      callExecHook(hook, effectivePayload, options).catch((err) => {
        logErr(`hooks ${hook.name}:`, err instanceof Error ? err.message : String(err));
        return undefined;
      }),
    ),
  );
  const contexts = results
    .map((output) => output?.context?.trim())
    .filter((text): text is string => Boolean(text));
  const picked =
    results.find((output) => output?.decision === "block") ??
    results.find((output) => output?.decision === "approve");
  const decision: HookDecision | undefined = picked?.decision
    ? {
        decision: picked.decision,
        ...(picked.reason ? { reason: picked.reason } : {}),
        ...(picked.stop ? { stop: true } : {}),
        ...(picked.systemMessage ? { systemMessage: picked.systemMessage } : {}),
      }
    : undefined;
  return {
    ...(decision ? { decision } : {}),
    ...(contexts.length ? { context: contexts.join("\n\n") } : {}),
  };
}

/** 显式 shell 的调用参数：Windows cmd/PowerShell 不认 `-c`，按可执行名分流。
 *  纯函数便于测试（不依赖当前平台）。 */
export function shellArgsFor(shell: string, command: string): string[] {
  // 反斜杠先归一：测试/配置里可能给 Windows 路径，而运行主机不一定是 Windows
  const base = basename(shell.replace(/\\/g, "/")).toLowerCase();
  if (base === "cmd" || base === "cmd.exe") return ["/d", "/s", "/c", command];
  if (base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe") {
    return ["-Command", command];
  }
  return ["-c", command];
}

async function execHook(
  hook: ResolvedHook,
  payload: HookPayload,
  options?: HookRunOptions,
): Promise<HookOutput | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    /** 只兑现 promise（可重复调用）；后台钩子提前 settle 后定时器仍保留 */
    const settle = (d?: HookOutput) => {
      if (settled) return;
      settled = true;
      resolve(d);
    };
    /** 终态收口：兑现并撤销定时器（子进程已退出 / 启动失败） */
    const finish = (d?: HookOutput) => {
      clearTimeout(timer);
      settle(d);
    };
    const timeout = Math.min(
      Math.max(hook.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const timer = setTimeout(() => {
      logErr(`hooks ${hook.name}: timeout after ${timeout}ms, killed`);
      // 后台钩子早已 settle，但超时仍必须杀进程树：否则后台命令永远残留。
      killHookTree(child?.pid);
      settle();
    }, timeout);
    timer.unref?.();
    // 插件钩子命中 ${BUN} 时补 BUN_BE_BUN=1：编译态 sidecar 二进制由此充当
    // 完整 bun CLI（真实 bun 上该变量无副作用）；手配钩子继承原环境。
    // 有工作区时注入 CLAUDE_PROJECT_DIR；插件钩子再注入 CLAUDE_PLUGIN_ROOT，
    // 兼容脚本里不带花括号的 `$CLAUDE_PLUGIN_ROOT` 写法（Claude 宿主约定）。
    if (hook.pluginDataRoot) {
      try {
        mkdirSync(hook.pluginDataRoot, { recursive: true });
      } catch (err) {
        logErr(
          `hooks ${hook.name}: create plugin data dir failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const hookEnv =
      hook.usedBun || hook.pluginRoot || hook.pluginDataRoot || options?.workspace
        ? {
            ...process.env,
            ...(hook.usedBun ? { BUN_BE_BUN: "1" } : {}),
            ...(hook.pluginRoot
              ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot, PLUGIN_ROOT: hook.pluginRoot }
              : {}),
            ...(hook.pluginDataRoot ? { PLUGIN_DATA: hook.pluginDataRoot } : {}),
            ...(options?.workspace ? { CLAUDE_PROJECT_DIR: options.workspace } : {}),
          }
        : undefined;
    // 无目录任务会话的 cwd 是惰性创建的（见 ensureTaskSessionDir）：目录还不
    // 存在时 spawn 会直接 ENOENT，钩子被静默跳过。Codex 插件钩子优先用插件根；
    // 其余退回会话工作区，环境里的 CLAUDE_PROJECT_DIR 仍指向工作区。
    const hookCwd = hook.cwd && existsSync(hook.cwd)
      ? hook.cwd
      : options?.workspace && existsSync(options.workspace)
        ? options.workspace
        : undefined;
    const hookCommand =
      process.platform === "win32" && hook.commandWindows ? hook.commandWindows : hook.command;
    const spawnOptions = {
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      ...(hookCwd ? { cwd: hookCwd } : {}),
      // 非 Windows 建独立进程组：超时时按 -pid 杀整棵树（见 killHookTree）
      detached: process.platform !== "win32",
      // Windows 不弹控制台窗口（钩子可能在每次工具调用时都跑）
      windowsHide: true,
      ...(hookEnv ? { env: hookEnv } : {}),
    };
    try {
      if (hook.type === "process") {
        // Windows 的 .cmd/.bat/.ps1 不能由 CreateProcess 直接执行：给出可操作
        // 的诊断，而不是让 spawn 以 ENOENT/EINVAL 静默失败
        if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(hookCommand)) {
          logErr(`hooks ${hook.name}: ${hookCommand} needs type "shell" on Windows`);
          return finish();
        }
        // 显式 process：argv 直接执行，不经 shell
        child = spawn(hookCommand, hook.args ?? [], spawnOptions);
      } else if (hook.shell?.trim()) {
        // shell 类型：整串命令交指定 shell 解释（cmd.exe 需要 /c，PowerShell -Command）
        const shell = hook.shell.trim();
        child = spawn(shell, shellArgsFor(shell, hookCommand), spawnOptions);
      } else if (process.platform === "win32") {
        // Windows 没有 $SHELL / /bin/sh：复用 bash 工具的解析链
        // （Git Bash → cmd.exe；cmd 需要 /d /s /c 前缀）
        const shell = resolveShellCommand();
        child = spawn(shell.file, [...shell.prefixArgs, hookCommand], spawnOptions);
      } else {
        // shell 类型默认：$SHELL / 兜底 /bin/sh
        const shell = process.env.SHELL || "/bin/sh";
        child = spawn(shell, ["-c", hookCommand], spawnOptions);
      }
    } catch (err) {
      logErr(`hooks ${hook.name}:`, err instanceof Error ? err.message : String(err));
      return finish();
    }
    // 后台运行：不等结果（决策类视为无决策）。**不能 finish**——finish 会撤销
    // 超时定时器，后台命令就再也没人杀了；子进程正常退出时 close 分支会撤销。
    if (hook.background) settle();
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
      finish();
    });
    child.on("close", (code) => {
      if (code === 2) {
        finish({ decision: "block", reason: truncateHookText(stderr.trim()) ?? "Blocked by hook" });
        return;
      }
      if (code !== 0) {
        logErr(`hooks ${hook.name}: exit ${code ?? "signal"}`);
        if (hook.onFailure === "block") {
          return finish({
            decision: "block",
            reason: truncateHookText(stderr.trim()) ?? "Blocked by hook failure",
          });
        }
        return finish();
      }
      const decision = parseDecision(stdout);
      if (decision?.systemMessage) {
        logErr(`hooks ${hook.name}: system message:`, decision.systemMessage);
        try {
          systemMessageSink?.({
            sessionId: payload.sessionId,
            ...(payload.threadId ? { threadId: payload.threadId } : {}),
            event: payload.event,
            hookName: hook.name,
            text: decision.systemMessage,
          });
        } catch (err) {
          logErr("hooks message sink:", err instanceof Error ? err.message : String(err));
        }
      }
      finish(decision);
    });
    // 钩子不读 stdin（如 `true`）时，write/end 触发的 EPIPE 是异步 error 事件，
    // 不是同步异常：没有监听会升级成未捕获异常，直接带走 sidecar 进程。
    child.stdin?.on("error", () => {
      /* 进程已退出：close 分支兜底，无决策 */
    });
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      /* 同步失败（流已销毁）：close 分支兜底 */
    }
    child.unref();
  });
}

/**
 * 超时杀整棵进程树：shell 型钩子会 fork 子进程，只 kill 直接子进程会留下
 * 孤儿继续改工作区。非 Windows 按独立进程组（-pid）杀；Windows 用 taskkill /T。
 * 与 local-host/tool-exec.ts 的 killTree 同语义——那边绑在工具执行器模块里，
 * 这里不引入整条工具链依赖，保持 hooks 的轻量执行路径。
 */
function killHookTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* 进程组已空 */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

function parseDecision(stdout: string): HookOutput | undefined {
  const raw = stdout.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      decision?: unknown;
      reason?: unknown;
      /** Claude 通用字段：false = 本轮停止继续处理 */
      continue?: unknown;
      /** Claude 通用字段：给用户看的提示 */
      systemMessage?: unknown;
      /** 部分实现把 additionalContext 放顶层 */
      additionalContext?: unknown;
      /** Claude Code 新版输出：PreToolUse 的 permissionDecision / PermissionRequest 的 decision */
      hookSpecificOutput?: {
        permissionDecision?: unknown;
        permissionDecisionReason?: unknown;
        decision?: { behavior?: unknown; message?: unknown } | unknown;
        additionalContext?: unknown;
      };
    };
    const output =
      parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === "object"
        ? parsed.hookSpecificOutput
        : undefined;
    const systemMessage = reasonOf(parsed.systemMessage);
    const context = reasonOf(output?.additionalContext) ?? reasonOf(parsed.additionalContext);
    const extras: Pick<HookOutput, "stop" | "systemMessage" | "context"> = {
      ...(parsed.continue === false ? { stop: true } : {}),
      ...(systemMessage ? { systemMessage } : {}),
      ...(context ? { context } : {}),
    };
    const decisionOf = (
      decision: "block" | "approve" | undefined,
      reason?: string,
    ): HookOutput | undefined => {
      // 只有 continue:false 没有决策：按终止处理（block，保留顶层 reason）
      const resolved =
        decision ?? (extras.stop ? ("block" as const) : undefined);
      if (!resolved) {
        const onlyExtras: HookOutput = { ...extras };
        return Object.keys(onlyExtras).length ? onlyExtras : undefined;
      }
      return { decision: resolved, ...(reason ? { reason } : {}), ...extras };
    };
    // 1) 本项目简化 schema：{"decision":"block"|"approve","reason"}
    if (parsed.decision === "block" || parsed.decision === "approve") {
      return decisionOf(parsed.decision, reasonOf(parsed.reason));
    }
    if (output) {
      // 2) Claude Code PreToolUse：permissionDecision allow/deny/ask
      const permissionDecision = output.permissionDecision;
      if (permissionDecision === "allow" || permissionDecision === "deny") {
        return decisionOf(
          permissionDecision === "allow" ? "approve" : "block",
          reasonOf(output.permissionDecisionReason),
        );
      }
      // "ask" = 交回正常审批链（除非同时 continue:false）
      if (permissionDecision === "ask") {
        return decisionOf(undefined, reasonOf(output.permissionDecisionReason));
      }
      // 3) Claude Code PermissionRequest：decision.behavior allow/deny
      const decision = output.decision;
      if (decision && typeof decision === "object") {
        const behavior = (decision as { behavior?: unknown }).behavior;
        if (behavior === "allow" || behavior === "deny") {
          return decisionOf(
            behavior === "allow" ? "approve" : "block",
            reasonOf((decision as { message?: unknown }).message),
          );
        }
      }
    }
    return decisionOf(undefined, reasonOf(parsed.reason));
  } catch {
    /* 非 JSON stdout：通知式输出，无决策 */
  }
  return undefined;
}

function reasonOf(value: unknown): string | undefined {
  return typeof value === "string" ? truncateHookText(value) : undefined;
}

/** 测试钩子：替换真实 spawn（仿 mcp-oauth 的 setBrowserOpenerForTest） */
export function setHooksExecutorForTest(fn: typeof execHook): void {
  execHookOverride = fn;
}
let execHookOverride: typeof execHook | undefined;

// runHooks 内经此间接调用 execHook，测试可注入
function callExecHook(hook: HookConfig, payload: HookPayload, options?: HookRunOptions) {
  return (execHookOverride ?? execHook)(hook, payload, options);
}

/** 测试钩子：清空配置与 kv 装载缓存 */
export function resetHooksForTest(): void {
  configs = [];
  stateLoad = undefined;
  execHookOverride = undefined;
  systemMessageSink = undefined;
}
