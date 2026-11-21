/**
 * 会话锚点刻度的选取规则（thread-preview-rail 用）：一轮对话一个刻度。
 *
 * 只锚定 user 消息（悬停预览卡会把该轮回复配成 description）。此前 user +
 * 该轮末条 assistant 各一个刻度（≈ 轮数 × 2），与“一轮一个”的预期不符。
 * 开场是 assistant 预置内容（首条 user 消息之前）时保留该连续段末条兜底，
 * 否则开场内容没有任何刻度可跳。
 *
 * 折叠轮的用户气泡照常渲染（Codex 风格只收起中间步骤），锚点因此不受
 * 折叠状态影响，两种形态下一轮恒为一个刻度。
 */
export function pickRoundAnchors<T extends { dataset: { slot?: string } }>(
  anchors: T[],
): T[] {
  const kept: T[] = [];
  let leadingAssistant: T | null = null;
  let seenUser = false;
  for (const anchor of anchors) {
    if (anchor.dataset.slot === "aui_user-message-root") {
      // 首条 user 消息落位时把开场 assistant 段的末条一并收进兜底
      if (!seenUser && leadingAssistant) kept.push(leadingAssistant);
      seenUser = true;
      kept.push(anchor);
    } else if (!seenUser) {
      leadingAssistant = anchor;
    }
  }
  if (!seenUser && leadingAssistant) kept.push(leadingAssistant);
  return kept;
}

/**
 * 刻度激活项：在「锚点中心的内容坐标」有序数组里找离 target 最近的一项。
 *
 * 滚动/流式过程中只有这套缓存坐标可用——逐锚点 getBoundingClientRect 在
 * content-visibility 下会强制每个屏外子树布局，长会话里每次滚动都是一次
 * 全量同步布局（几百轮 = 每帧几百次，直接产出秒级 long task）。
 * centers 必须非降序（文档序布局）；空数组返回 -1。
 */
export function nearestRoundAnchorIndex(
  centers: readonly number[],
  target: number,
): number {
  if (centers.length === 0) return -1;
  // 二分找最后一个 center <= target
  let lo = 0;
  let hi = centers.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (centers[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  // 与后一项比较取更近者（target 落在第 0 项之前时 lo=0 也走这里）
  const next = Math.min(lo + 1, centers.length - 1);
  return Math.abs(centers[next]! - target) < Math.abs(centers[lo]! - target)
    ? next
    : lo;
}
