/**
 * 会话标题 AI 总结（参考 PI-Desktop session-title-summarize）：
 * 首轮回复完成后，用当前模型发一次独立 one-shot 请求（不进会话上下文），
 * 根据用户首条 prompt + 助手首条回复生成 25 字以内的描述性标题，替换 prompt 兜底标题。
 * 失败非致命：保留截断 fallback 标题。
 */
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { logErr } from "./log";

export const SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT =
  "You generate a short, concise, descriptive session title summarizing the conversation based on the user's initial prompt and context.\n" +
  "Rules:\n" +
  "1. Output ONLY the title text. Do NOT wrap in quotes, brackets, or backticks.\n" +
  "2. Do not include markdown formatting, trailing punctuation, or emojis.\n" +
  "3. Keep it under 25 characters (or 4-7 words).\n" +
  "4. Use the primary language of the user's prompt (e.g. Chinese for Chinese requests, English for English requests).\n" +
  "5. Focus on the key topic or action (e.g. \"Debug WebSocket reconnect\", \"重构用户认证模块\").";

const PROMPT_MAX = 1000;
const REPLY_MAX = 500;
const TITLE_MAX = 80;

/** 组装标题总结请求上下文（user 消息 = 截断的 prompt + 可选回复摘要） */
export function sessionTitleSummarizeContext(
  userPrompt: string,
  assistantReply?: string,
): Context {
  const cleanPrompt = userPrompt.trim().slice(0, PROMPT_MAX);
  const cleanReply = assistantReply ? assistantReply.trim().slice(0, REPLY_MAX) : "";
  const content = cleanReply
    ? `User Prompt:\n${cleanPrompt}\n\nAssistant Response Summary:\n${cleanReply}`
    : `User Prompt:\n${cleanPrompt}`;

  return {
    systemPrompt: SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content,
        timestamp: Date.now(),
      } as unknown as Message,
    ],
  };
}

/** 清洗模型输出：去引号/书名号/代码标记、去「Title:」前缀、折叠空白、去尾部标点、截断 */
export function cleanSummarizedTitle(raw: string): string {
  let text = raw.trim();
  text = text
    .replace(/^[`"'\u201c\u201d\u300c\u300d]+|[`"'\u201c\u201d\u300c\u300d]+$/g, "")
    .trim();
  text = text.replace(/^(Title|Session Title|会话标题|标题)\s*[:：]\s*/i, "").trim();
  text = text.replace(/\s+/g, " ");
  text = text.replace(/[.。!！?？]+$/, "").trim();
  return text.slice(0, TITLE_MAX);
}

/** streamSimple 的最小形状（catalog.streamSimple 签名的子集，测试可注入假流） */
type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: { signal?: AbortSignal },
) => AsyncIterable<unknown>;

/**
 * one-shot 标题总结：streamSimple 逐块累积非思考文本（与压缩摘要同路径，
 * 自定义端点/内置厂商统一支持），失败返回 undefined 由调用方保留 fallback。
 */
export async function summarizeSessionTitle(
  streamSimple: StreamSimpleFn,
  model: Model<Api>,
  userPrompt: string,
  assistantReply?: string,
  options?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const context = sessionTitleSummarizeContext(userPrompt, assistantReply);
  let text = "";
  try {
    for await (const event of streamSimple(model, context, {
      signal: options?.signal,
    })) {
      if (options?.signal?.aborted) return undefined;
      const type = (event as { type?: string }).type;
      if (type === "text_delta") {
        text += String((event as { delta?: string }).delta ?? "");
      } else if (type === "error") {
        logErr(
          "session title summarize stream error:",
          (event as { error?: unknown }).error,
        );
        return undefined;
      }
    }
  } catch (err) {
    logErr("session title summarize failed:", err);
    return undefined;
  }
  const cleaned = cleanSummarizedTitle(text);
  return cleaned || undefined;
}
