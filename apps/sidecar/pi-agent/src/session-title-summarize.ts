/**
 * 会话标题 AI 总结（参考 PI-Desktop session-title-summarize）：
 * 首轮回复完成后，用当前模型发一次独立 one-shot 请求（不进会话上下文），
 * 根据用户首条 prompt + 助手首条回复生成 25 字以内的描述性标题，替换 prompt 兜底标题。
 * 失败非致命：保留截断 fallback 标题。
 */
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { logErr } from "./log";

export const SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT =
`你需要根据用户初始提问和助手首条回复，生成简短会话标题。严格遵守所有规则：
1. 仅输出标题文本，禁止任何额外解释、前言后语。
2. 严禁输出 Markdown、反引号、引号、括号、换行、emoji。
3. 标题中文不超过25个汉字，英文不超过25个字符。
4. 使用用户提问的语言。
5. 只提炼核心任务/主题，不要冗余描述。
禁止输出任何格式标记，不要分段，不要加任何装饰符号。`;

const PROMPT_MAX = 1000;
const REPLY_MAX = 500;
const TITLE_RULE_MAX = 25;
const TITLE_MAX = 80;

/**
 * 剥掉 composer 指令芯片的序列化文本（`:type[标签]{name=id}`，如
 * `:skill[anxin-ppt]{name=skill:anxin-ppt}`）——芯片原文会随 prompt 进模型
 * 与转录（模型凭标签定位技能，前端气泡渲染回芯片），但标题路径不该带这串
 * 格式噪音。整段芯片替换为其标签（技能名对标题有信息量），随后折叠多余空白。
 * 正则与桌面端 cm-composer-input.tsx 的 DIRECTIVE_RE 保持一致。
 */
const DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
export function stripDirectiveTokens(text: string): string {
  return text.replace(DIRECTIVE_RE, (_m, _type, label: string) => label).replace(/[ \t]{2,}/g, " ");
}

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

  const msg: Message = {
    role: "user",
    content,
    timestamp: Date.now(),
  };

  return {
    systemPrompt: SESSION_TITLE_SUMMARIZE_SYSTEM_PROMPT,
    messages: [msg],
  };
}

/** 清洗模型输出：去引号/书名号/代码标记、去「Title:」前缀、折叠空白、去标点、过滤markdown标记 */
export function cleanSummarizedTitle(raw: string): string {
  let text = raw.trim();
  // 移除反引号
  text = text.replace(/`+/g, "");
  // 移除粗体斜体标记
  text = text.replace(/[*_]/g, "");
  // 移除首尾各类引号书名号
  text = text.replace(/^[`"'\u201c\u201d\u300c\u300d]+|[`"'\u201c\u201d\u300c\u300d]+$/g, "");
  // 清除标题前缀
  text = text.replace(/^(Title|Session Title|会话标题|标题)\s*[:：]\s*/i, "");
  // 空白压缩
  text = text.replace(/\s+/g, " ");
  // 去除尾部标点
  text = text.replace(/[.。!！?？；;：:]+$/, "");
  text = text.trim();
  // 强制截断到规则上限
  text = text.slice(0, TITLE_RULE_MAX);
  return text;
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
      const ev = event as { type?: string; delta?: string; error?: unknown };
      if (ev.type === "text_delta") {
        text += String(ev.delta ?? "");
      } else if (ev.type === "error") {
        logErr(
          "session title summarize stream error:",
          ev.error,
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
