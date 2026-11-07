/**
 * 新会话欢迎语：时段问候 + 设置 → 个性化 →「称呼与身份」里的称呼和 AI 名称。
 *
 * 称呼（userName）为空时不点名，保持「夜深了，我是 Kova」的原有句式；
 * AI 名称（assistantName）为空时回落默认名 Kova。纯函数，便于单测覆盖边界。
 */

/** AI 名称缺省值（与设置里的默认展示一致） */
export const DEFAULT_ASSISTANT_NAME = "Kova";

/** 按时段给出「早上好 / 中午好 / 下午好 / 晚上好 / 夜深了」 */
export const greetingAt = (now: Date): string => {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  if (hour >= 18 && hour < 22) return "晚上好";
  return "夜深了";
};

/** CJK 起头的名字紧排（「我是扣瓦」）；拉丁/数字起头留空格（「我是 Kova」） */
const CJK_LEAD_RE = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** 自介句式：中英文名字的间距规则不同，避免「我是 扣瓦」这种多余空格 */
const selfIntro = (name: string): string =>
  CJK_LEAD_RE.test(name) ? `我是${name}` : `我是 ${name}`;

/**
 * 欢迎语：
 * - 称呼与 AI 名称都有 →「夜深了，Herther。我是扣瓦」
 * - 称呼为空 →「夜深了，我是扣瓦」
 * - AI 名称为空 →「夜深了，Herther。我是 Kova」
 * - 都为空 →「夜深了，我是 Kova」
 */
export function welcomeGreeting(
  now: Date,
  userName: string,
  assistantName: string,
): string {
  const name = userName.trim();
  const assistant = assistantName.trim() || DEFAULT_ASSISTANT_NAME;
  const time = greetingAt(now);
  // 称呼后跟句号而不是逗号：避免「夜深了，Herther，我是扣瓦」读成“我是 Herther”
  return name
    ? `${time}，${name}。${selfIntro(assistant)}`
    : `${time}，${selfIntro(assistant)}`;
}
