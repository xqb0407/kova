/**
 * 排队条的展示文本解析：把 prompt 原文拆成「引用」与「真正正文」。
 *
 * 「询问」发送时，引用文本以 Markdown 引用块前置进正文（见 ThreadController
 * 的 buildPiSendInput）；sidecar 的队列项 text 就是这段给模型看的原文。队列条
 * 不该把 `>` 前缀和隐藏上下文块原样展示，这里统一剥一层：
 * - [[library-refs]] / [[library-notes]] 与图片注记：splitPromptNotices；
 * - 前导引用块：splitLeadingQuoteBlock（与消息气泡投影同一口径）。
 *
 * 队列条只用 quote 判断是否出「询问」徽标，不展示引用正文；编辑回填时再把
 * quote 还原成 composer 的引用预览。
 */

import { stripImGroupPrompt } from "pi-protocol";
import { splitPromptNotices } from "./prompt-notices";
import { splitLeadingQuoteBlock } from "./pi-runtime/runtime/messageProjection";

export type QueueContentPreview = {
  /** 前导引用文本（无引用或空引用为 null） */
  quote: string | null;
  /** 剥掉引用块与隐藏块后的正文 */
  text: string;
  /** 需要让用户知道的告警（图片被省略等）；队列行不展示，编辑回填保留 */
  warnings: string[];
};

export function previewQueueContent(content: string): QueueContentPreview {
  // 注记/隐藏块总在正文末尾；先剥掉再做前导引用解析，避免块内容干扰。
  // warnings 单独保留：队列行可以不展示，但编辑回填不能把“图片没发出去”吞掉。
  // IM 群聊发言人哨兵同理：只给模型看，队列行/编辑回填都按用户原文展示。
  const notices = splitPromptNotices(stripImGroupPrompt(content));
  const cleaned = notices.text;
  const split = splitLeadingQuoteBlock(cleaned);
  if (!split || split.quote.trim() === "") {
    return { quote: null, text: cleaned, warnings: notices.warnings };
  }
  return { quote: split.quote, text: split.rest, warnings: notices.warnings };
}
