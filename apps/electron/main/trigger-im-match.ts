/**
 * IM 触发器条件匹配（L1c，纯函数，无 Electron 依赖）。
 *
 * config: `{ platform, chatId?, pattern? }`
 * - platform 必填，与入站消息平台精确匹配；
 * - chatId 缺省 = 该平台任意聊天；
 * - pattern 缺省 = 任意文本；给了就按不区分大小写的正则匹配源文本，
 *   非法正则整条跳过（不让坏配置拦住消息处理）。
 */

export type ImTriggerLike = {
  id: string;
  type: string;
  taskId: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type ImMessageKey = {
  platform: string;
  chatId: string;
  text: string;
};

export function matchImTriggers(
  triggers: readonly ImTriggerLike[],
  msg: ImMessageKey,
): ImTriggerLike[] {
  const out: ImTriggerLike[] = [];
  for (const trigger of triggers) {
    if (!trigger.enabled || trigger.type !== "im") continue;
    const cfg = trigger.config;
    if (typeof cfg.platform !== "string" || cfg.platform !== msg.platform) continue;
    if (typeof cfg.chatId === "string" && cfg.chatId && cfg.chatId !== msg.chatId) continue;
    if (typeof cfg.pattern === "string" && cfg.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(cfg.pattern, "i");
      } catch {
        continue;
      }
      if (!re.test(msg.text)) continue;
    }
    out.push(trigger);
  }
  return out;
}

/** 触发摘要：平台 + 发送者 + 消息前 80 字（进 Inbox/会话标题） */
export function imTriggerSummary(msg: ImMessageKey & { senderId?: string }): string {
  const who = msg.senderId ? ` ${msg.senderId}` : "";
  const text = msg.text.replace(/\s+/g, " ").trim().slice(0, 80);
  return `im ${msg.platform}${who}: ${text}`;
}
