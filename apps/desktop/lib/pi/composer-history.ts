"use client";

import { splitPromptNotices } from "@/lib/pi/prompt-notices";

/**
 * composer 的终端式输入历史（↑ 回翻已发送的输入，↓ 翻回草稿）。
 *
 * 数据源就是当前会话转录里的用户消息，不另存一份：
 * - 投影层已剥掉并入哨兵前缀（`[[queued-steer]]`）与资料库上下文隐藏块，
 *   这里再剥「给模型看的注记行」，并丢弃发送端追加的附件说明行
 *   （`[用户附件：…]`）——那不是用户敲进去的文本，回填进输入框只会变成噪音。
 * - 纯图片/纯文档消息没有可回填的正文，跳过。
 * - 只回填正文：引用块在投影层收进 metadata、附件在 attachments，均不在
 *   历史条目里（↑ 是找回「上次敲的话」，不是完整重放一条消息）。
 *
 * `createPromptHistoryCursor` 只负责「第几次 ↑/↓ 对应哪条目」：
 * 首次 ↑ 记住浏览前的草稿（终端语义），从最新一条往回翻；↓ 一路翻回
 * 草稿并退出浏览。被改写过的历史条目不回流（与 shell 一致）。
 */

type HistoryContentPart = {
  type?: string;
  text?: string;
  /** 其它 part（image/file/tool-call…）原样透传，只按 type 过滤 */
  [key: string]: unknown;
};

/** 只用到的最小消息形状；调用方直接传 assistant-ui 的 ThreadMessage[]。 */
export type HistoryMessage = {
  role?: string;
  content?: readonly HistoryContentPart[];
};

/** 一次发送最多回翻的条数：长会话不必把整段转录都变成历史，够用即可 */
export const PROMPT_HISTORY_LIMIT = 100;

/** 发送端追加的文档附件说明行（`[用户附件：name（PDF…）位于 …]`） */
const ATTACHMENT_NOTICE_RE = /^\[用户附件：.*\]$/;

/** 单条用户消息可回填的正文；null = 这条消息没有可当输入的文本。 */
export function promptHistoryText(message: HistoryMessage): string | null {
  if (message.role !== "user" || !Array.isArray(message.content)) return null;
  const raw = message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  if (!raw) return null;
  const text = splitPromptNotices(raw)
    .text.split("\n")
    .filter((line) => !ATTACHMENT_NOTICE_RE.test(line.trim()))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * 会话消息 → 历史条目（最新在前）。连续重复只留一条：连发两次同一句话，
 * ↑ 一下回到它即可，不必再按一次；中间夹了别的消息的同文消息保留。
 */
export function collectPromptHistory(
  messages: readonly HistoryMessage[],
  maxEntries = PROMPT_HISTORY_LIMIT,
): string[] {
  const entries: string[] = [];
  for (let i = messages.length - 1; i >= 0 && entries.length < maxEntries; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    const text = promptHistoryText(message);
    if (text === null) continue;
    if (entries.length === 0 || entries[entries.length - 1] !== text) {
      entries.push(text);
    }
  }
  return entries;
}

export type PromptHistoryCursor = {
  /** 更早一条；null = 没有历史（调用方放行默认光标移动） */
  prev(draft: string): string | null;
  /** 更新一条；翻过最新一条时返回浏览开始前的草稿（不是 null） */
  next(): string | null;
  reset(): void;
  /** 是否正在浏览历史（↓ 只在这个状态下接管） */
  readonly browsing: boolean;
};

/**
 * ↑/↓ 的浏览游标。`readEntries` 在首次 ↑ 时才调用（快照式）：
 * - 不在浏览时不能 ↓（返回 null，放行默认光标移动）；
 * - 到最旧一条再 ↑ 停在原地，不循环；
 * - ↓ 越过最新一条 = 回到浏览前的草稿并退出浏览。
 */
export function createPromptHistoryCursor(
  readEntries: () => readonly string[],
): PromptHistoryCursor {
  let entries: readonly string[] | null = null;
  let index = 0;
  let draft = "";

  const reset = () => {
    entries = null;
    index = 0;
    draft = "";
  };

  return {
    prev(currentDraft) {
      if (entries === null) {
        const snapshot = readEntries();
        if (snapshot.length === 0) return null;
        entries = snapshot;
        index = 0;
        draft = currentDraft;
      } else if (index < entries.length - 1) {
        index += 1;
      }
      return entries[index] ?? null;
    },
    next() {
      const list = entries;
      if (list === null) return null;
      if (index <= 0) {
        const restored = draft;
        reset();
        return restored;
      }
      index -= 1;
      return list[index] ?? null;
    },
    reset,
    get browsing() {
      return entries !== null;
    },
  };
}
