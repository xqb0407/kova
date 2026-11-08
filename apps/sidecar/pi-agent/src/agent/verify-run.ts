/**
 * autoVerify（run 结束自动验证）：本轮转录里出现成功落地的 write/edit 时，
 * 在 agent_end 结算点注入一条 followUp，让模型在下一轮跑只读验证（测试/
 * lint/build），失败则修复。借鉴 pi-durable 的 afterRun hook，但按 kova 现有
 * 架构走 followUp 队列（同 auto-continue 的注入模式）而非独立子代理——
 * launchSubagentRun 需要 Task 委派的 record 上下文，verify 不是委派；
 * followUp 天然复用审批链/沙箱/loop-guard/工具预算，Stop 钩子直接杀整链。
 *
 * 防护三重：verify 轮的编辑不再触发下一轮（触发集只认 write/edit 成功且
 * 轮次计数上限）；automation 线程强制 off；goal 模式有自己的验收闭环，互斥
 * 跳过。默认 off（设置项），灰度。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Running } from "../types";
import { logAt, logErr } from "../log";
import { getAutomationPolicy } from "../automation/policy";

/** 上限：同一用户轮内 verify 注入次数（防验证→修复→再验证死循环） */
export const AUTO_VERIFY_MAX_CONTINUES = 2;

/** verify 注入消息的哨兵前缀：单源在 pi-protocol（isAutoContinueText 同口径
 *  隐藏，与 AUTO_CONTINUE_PREFIX 并列——两端各写一份前缀判定就会漏） */
import { AUTO_VERIFY_PREFIX as AUTO_VERIFY_PREFIX_SENTINEL } from "pi-protocol";
export { AUTO_VERIFY_PREFIX_SENTINEL as AUTO_VERIFY_PREFIX };

export interface AutoVerifyConfig {
  enabled: boolean;
}

const DEFAULT_AUTO_VERIFY_CONFIG: AutoVerifyConfig = { enabled: false };

const AUTO_VERIFY_KV_KEY = "pi.autoVerify";

let current: AutoVerifyConfig = { ...DEFAULT_AUTO_VERIFY_CONFIG };

export function getAutoVerifyConfig(): AutoVerifyConfig {
  return current;
}

/** 测试辅助：仅改内存（kv 由 apply 走） */
export function setAutoVerifyConfig(next: AutoVerifyConfig): void {
  current = { enabled: next.enabled === true };
}

/** 启动恢复：kv 载入内存；失败保持默认 off（不阻断启动） */
export async function initAutoVerifyConfig(): Promise<void> {
  try {
    const { kvGet } = await import("../storage/hostdb");
    const row = await kvGet(AUTO_VERIFY_KV_KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { enabled?: unknown };
      current = { enabled: parsed.enabled === true };
    }
  } catch (error) {
    logErr("auto-verify-config: load failed (staying off):", error);
  }
}

/** 设置面板写侧：落 kv + 内存即时生效 */
export async function applyAutoVerifyConfig(next: AutoVerifyConfig): Promise<AutoVerifyConfig> {
  current = { enabled: next.enabled === true };
  try {
    const { kvSet } = await import("../storage/hostdb");
    await kvSet(AUTO_VERIFY_KV_KEY, JSON.stringify(current));
  } catch (error) {
    logErr("auto-verify-config: persist failed (memory only):", error);
  }
  return current;
}

/** 测试辅助：恢复默认（off） */
export function resetAutoVerifyConfigForTest(): void {
  current = { ...DEFAULT_AUTO_VERIFY_CONFIG };
}

/**
 * agent_end 结算点调用。返回要注入的 verify followUp 消息（调用方
 * `run.agent.followUp(...)`），不触发时返回 undefined。
 *
 * 触发条件（全部满足）：
 * - 设置开启
 * - 非 goal（goal 有验收闭环）/ 非 automation（无人值守不叠加后台轮）
 * - 本轮转录存在成功返回的 write/edit toolResult（isError=false）
 * - 本用户轮内注入次数未达上限（run.verifyContinues）
 */
export function maybeVerifyFollowUp(
  run: Running,
  messages: readonly AgentMessage[],
): AgentMessage | undefined {
  const config = getAutoVerifyConfig();
  if (!config.enabled) return undefined;
  if (run.mode === "goal") return undefined; // goal 有验收闭环，互斥
  if (getAutomationPolicy(run.threadId)) return undefined; // 无人值守强制 off
  if (run.stopRequested) return undefined; // 用户 Stop：不得违背中断意图（接线层另查尾部 stopReason 过滤失败/中止轮）
  const continues = run.verifyContinues ?? 0;
  if (continues >= AUTO_VERIFY_MAX_CONTINUES) return undefined;

  // 触发集：本轮（从最后一次用户消息起）成功返回的 write/edit
  const edited = editedFilesThisTurn(messages);
  if (edited.size === 0) return undefined;

  run.verifyContinues = continues + 1;
  const files = [...edited].slice(0, 6).map((f) => `- ${f}`).join("\n");
  const text =
    AUTO_VERIFY_PREFIX_SENTINEL +
    `上一轮修改了以下文件：\n${files}\n\n` +
    "现在做只读验证：运行受影响的测试/lint/build（bash 只跑只读检查命令），" +
    "确认没有引入错误。结果正常就简要报告通过；发现错误就先修复再验证。" +
    "不要修改任何与修复这些错误无关的文件。";
  logAt("event", `auto-verify #${run.verifyContinues}: ${edited.size} file(s) edited, injecting verify follow-up`);
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

/** 本轮（最后一次用户消息之后）成功返回的 write/edit 的 file_path 集合 */
export function editedFilesThisTurn(messages: readonly AgentMessage[]): Set<string> {
  const edited = new Set<string>();
  // 先定位本轮起点（最后一条真实用户消息；verify 注入本身也是 user 角色，
  // 靠哨兵前缀排除），再正向收集其后的成功 write/edit
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (!text.startsWith(AUTO_VERIFY_PREFIX_SENTINEL)) {
        turnStart = i;
        break;
      }
    }
  }
  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i] as { toolCallId?: string; role?: string; toolName?: string; isError?: boolean; content?: unknown };
    if (m?.role !== "toolResult") continue;
    if (
      (m.toolName === "write" || m.toolName === "edit") &&
      m.isError !== true
    ) {
      // 路径从结果文本兜底抽取；抽不到用 toolCallId 占位——触发判定看的是
      // 「有没有成功编辑」而非「路径清单是否完整」
      edited.add(fileOfResult(m.content) || `toolCall:${m.toolCallId ?? i}`);
    }
  }
  return edited;
}

/** 从 toolResult 内容块抽数组里的 file_path（hostTool 结果 details 不回传参数，
 *  这里从结果文本兜底：write/edit 成功文案含路径）——取不到就返回空串占位，
 *  指令里仍列「有文件被修改」但不含具体路径 */
function fileOfResult(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content as { type?: string; text?: string }[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      const match =
        /(?:^|\s)(?:[A-Za-z]:)?(?:\/|\\)[^\s'"`]+/.exec(block.text) ??
        /^(?:Wrote|Edited)[^\n]*?(\S+)$/m.exec(block.text);
      if (match?.[0]) return match[0].trim();
    }
  }
  return "";
}
