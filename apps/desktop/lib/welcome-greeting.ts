/**
 * 新会话欢迎语：时段问候 + 设置 → 个性化 →「称呼与身份」里的称呼和 AI 名称。
 *
 * 称呼（userName）为空时不点名，保持「夜深了，我是 Kova」的原有句式；
 * AI 名称（assistantName）为空时回落默认名 Kova。纯函数，便于单测覆盖边界。
 * 文案模板在词典 chat.greeting.*；locale 由调用方传入（缺省取当前界面语言），
 * 组件经 useLocale 订阅切换，单测显式传参覆盖两种语言。
 */
import { getLocale, translateWith, type Locale } from "@/lib/i18n";

/** AI 名称缺省值（与设置里的默认展示一致） */
export const DEFAULT_ASSISTANT_NAME = "Kova";

/** 按时段给出问候词的词典 key（早上好 / 中午好 / 下午好 / 晚上好 / 夜深了） */
export const greetingKeyAt = (now: Date): string => {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return "chat.greeting.morning";
  if (hour >= 11 && hour < 13) return "chat.greeting.noon";
  if (hour >= 13 && hour < 18) return "chat.greeting.afternoon";
  if (hour >= 18 && hour < 22) return "chat.greeting.evening";
  return "chat.greeting.lateNight";
};

/** CJK 起头的名字紧排（「我是扣瓦」）；拉丁/数字起头留空格（「我是 Kova」）。
 *  只对中文模板生效——英文模板本身带空格（"I'm {name}"）。 */
const CJK_LEAD_RE = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

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
  locale: Locale = getLocale(),
): string {
  const name = userName.trim();
  const assistant = assistantName.trim() || DEFAULT_ASSISTANT_NAME;
  // 自介句式：中英文名字的间距规则不同，避免「我是 扣瓦」这种多余空格
  const intro =
    locale === "zh" && CJK_LEAD_RE.test(assistant)
      ? `我是${assistant}`
      : translateWith(locale, "chat.greeting.selfIntro", { name: assistant });
  const time = translateWith(locale, greetingKeyAt(now));
  // 称呼后跟句号而不是逗号：避免「夜深了，Herther，我是扣瓦」读成“我是 Herther”
  return name
    ? translateWith(locale, "chat.greeting.withUserName", { time, name, intro })
    : translateWith(locale, "chat.greeting.withoutUserName", { time, intro });
}
