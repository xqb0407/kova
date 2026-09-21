/**
 * 会话锚点刻度的选取规则（thread-preview-rail 用）：一轮对话一个刻度。
 *
 * 只锚定 user 消息（悬停预览卡会把该轮回复配成 description）。此前 user +
 * 该轮末条 assistant 各一个刻度（≈ 轮数 × 2），与“一轮一个”的预期不符。
 * 开场是 assistant 预置内容（首条 user 消息之前）时保留该连续段末条兜底，
 * 否则开场内容没有任何刻度可跳。
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
