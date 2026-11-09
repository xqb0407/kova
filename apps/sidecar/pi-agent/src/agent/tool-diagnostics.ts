/**
 * 工具结果诊断码：把宿主已算出的失败类别（策略拒绝、审批拒绝、用户中断、
 * 超时转后台、沙箱拒绝）从自由文本升级为稳定标记，供模型侧策略调整与测试
 * 断言共用。
 *
 * 两个通道，互为冗余：
 * - 文本尾部标签 ` [diagnostic: <code>]`：模型直接读；幂等（重复打不叠加）。
 *   放尾部避免打乱首行语义与 UI 已有的首行渲染。
 * - `details.diagnostic`：结构化字段，UI/测试用；合并进现有 details，不整块替换。
 *
 * 宿主数据 → 码的判定见 `hostDiagnostic`（优先级递减）；应用见
 * `applyHostDiagnostic`。effect-free 工具集合是 `repairDanglingToolCalls`
 * 崩溃修复文案分流的唯一事实源，与测试共用；未归类工具默认按有副作用处理。
 */

export type ToolDiagnosticCode =
  | "policy_denied"
  | "approval_rejected"
  | "interrupted_by_user"
  | "timeout_backgrounded"
  | "timeout_killed"
  | "sandbox_write_denied";

/**
 * 无副作用工具：崩溃中断后可安全重试（repairDanglingToolCalls 用）。
 *
 * 事实源正在从本名单迁移到工具定义的 `replay: "safe"` 元数据（pi-agent-core
 * 1.5.0 原生字段）——新增工具请直接在定义点标 replay，别往这里加。本名单保留
 * 作 restore 时点的兜底（resolveSession 装配工具表之前就要修转录，拿不到定义），
 * 有工具表的调用方应改用 `effectFreeToolNamesOf(tools)`。
 */
export const EFFECT_FREE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "WebFetch",
  "WebSearch",
  "kb_search",
  "kb_read",
  "task_output",
  "Question",
]);

/** 从工具定义收集 replay: "safe" 的名字（消债：名单漂移收敛到定义点） */
export function effectFreeToolNamesOf(
  tools: readonly { name?: string; replay?: "never" | "safe" }[],
): ReadonlySet<string> {
  return new Set(tools.filter((t) => t.replay === "safe").map((t) => t.name as string));
}

/** 文本末尾追加诊断标签；幂等——已有标签（同码或不同码）不重复追加 */
export function tagDiagnostic(text: string, code: ToolDiagnosticCode): string {
  if (text.includes(`[diagnostic: ${code}]`)) return text;
  // 已有其他诊断码时替换成最新码：一个结果只有一个最终类别，首个判定
  // （如 timeout_backgrounded）不会比后续判定（如 timeout_killed）更准
  const stripped = text.replace(/\s*\[diagnostic: \w+\]$/g, "");
  // 空文本只回标签本身，不带前导空格
  return stripped ? `${stripped} [diagnostic: ${code}]` : `[diagnostic: ${code}]`;
}

/** 从文本尾部剥掉诊断标签（UI 投影用；转录不动） */
export function stripDiagnostic(text: string): string {
  return text.replace(/\s*\[diagnostic: \w+\]$/g, "");
}

/**
 * 宿主返回数据 → 诊断码。优先级递减：
 * cancelled（用户中断）> 超时转后台（进程还活着）> 超时杀掉 > 沙箱写拒绝。
 * 不给 truncated 打码：截断不是错误，文本已有 `…[output truncated]`。
 */
export function hostDiagnostic(
  data: Record<string, unknown>,
): ToolDiagnosticCode | undefined {
  if (data.cancelled === true) return "interrupted_by_user";
  if (data.timedOut === true) {
    return data.running === true ? "timeout_backgrounded" : "timeout_killed";
  }
  const sandbox = data.sandbox as { denied?: unknown } | undefined;
  if (sandbox?.denied === "write") return "sandbox_write_denied";
  return undefined;
}

type ToolResultLike = {
  content: unknown[];
  details?: unknown;
};

/**
 * 把宿主数据判定的诊断码应用到工具结果：
 * - `details.diagnostic` 合并（details 非 object 时新建，不整块覆盖其余字段）
 * - 每个 text 块尾部追加标签；image 等其他块类型不动
 * - 无可判定码时原样返回同一对象
 */
export function applyHostDiagnostic<T extends ToolResultLike>(
  result: T,
  data: Record<string, unknown>,
): T {
  const code = hostDiagnostic(data);
  if (!code) return result;

  const details =
    result.details && typeof result.details === "object" && !Array.isArray(result.details)
      ? { ...(result.details as Record<string, unknown>), diagnostic: code }
      : { diagnostic: code };

  const content = result.content.map((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return { ...block, text: tagDiagnostic((block as { text: string }).text, code) };
    }
    return block;
  });

  return { ...result, content, details };
}
