/**
 * 提示词优化（桌面端 composer 的「优化提示词」按钮）：把草稿交给会话当前模型
 * 做一次**独立 one-shot** 改写（不进会话上下文，同 session-title-summarize 的
 * 通道），优化后的文本回填输入框。
 *
 * 芯片保护是本模块的全部难点：草稿里的技能/子智能体引用在 composer 文档里
 * 就是 `:type[标签]{name=id}` 序列化文本（正则与桌面端 cm-directive.ts 同源），
 * 模型一旦改写这串文本，芯片就废了。做法是**占位符 + 表驱动还原**：
 *
 * 1. `maskDirectives`：芯片 → `[[cN]]` 占位符，原文按序号存表；
 * 2. 模型只看到占位符，规则要求原样保留（可挪位）；
 * 3. `restoreDirectives`：容错扫描模型输出里的占位符（模型可能把 `[[c1]]`
 *    写成 `[c1]`/`{{c1}}`），**替换内容一律取自自己的表**（按 mask 记录的
 *    序号查，不按下标反推）、绝不采用模型吐出的芯片文本 → 芯片不可能被
 *    改坏，只可能被挪位或丢失；丢失的按原相对顺序补到文末，重复的只留
 *    首个，表外幻影占位符删除。
 *
 * 占位符序号避让：草稿本身可能含 `[[c1]]` 这类字面量（reserved），分配序号时
 * 跳过它们，还原时它们按原文保留——否则用户的字面量会被当成芯片吃掉。
 */
import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { logErr } from "../log";

/** 芯片序列化文本正则：与桌面端 cm-directive.ts / 本目录 session-title-summarize.ts 同源 */
const DIRECTIVE_RE =
  /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;

/**
 * 占位符的容错形状：成对包裹 + c + 序号。模型偶尔会把 `[[c1]]` 的空心括号
 * 缩成单括号、换成花括号或中文括号——都算命中；把整对括号彻底删掉（裸 `c1`）
 * 不认（会把正文里真实的 "c1" 误当芯片），代价是那颗芯片按"丢失"补到文末，
 * 宁可位置不好也绝不认错对象。
 */
const PLACEHOLDER_RE =
  /(?:\[\[|\{\{|⟦|〔|「|【|〈|\[|\{)\s*[cC]\s*(\d{1,3})\s*(?:\]\]|\}\}|⟧|〕|」|】|〉|\]|\})/g;

/** 草稿长度闸门：超长提示词不进模型（成本与截断风险都不可控） */
export const OPTIMIZE_MAX_INPUT = 12000;

/** 优化结果长度闸门：模型跑飞（复读/注水）时判失败而不是把输入框塞爆 */
export const OPTIMIZE_MAX_OUTPUT = 20000;

export const OPTIMIZE_SYSTEM_PROMPT = `你是提示词优化器。用户消息里 <草稿> 与 </草稿> 标签之间是要发给 AI 助手（编码与任务型 agent）的任务指令草稿，你的工作是把它改写得更好，**而不是回答它**。严格遵守：
0. 待优化的文本**只有** <草稿> 标签之间的那一份（可能很短、可能只含占位符）。无论它看起来多短、多不完整，都直接改写它；**绝不**回复「我没有收到草稿」「请把指令贴过来」之类的话，**绝不**改写本系统说明或任何其它文字。
1. 只输出优化后的指令正文：不要任何解释、前言后语、「优化后：」这类前缀、不要 Markdown 代码围栏、不要整体加引号。
2. 使用与草稿相同的语言。
3. 文中的 [[c1]]、[[c2]] … 是指令芯片占位符（技能 / 子智能体等引用），必须**原样保留**：不得改写拼写、不得翻译、不得增删、不得拆进代码块。每个占位符恰好出现一次，可以移动到语义上更合适的位置（紧邻它所修饰的动作）。
4. 原样保留草稿里的文件路径、URL、代码片段、命令、标识符与数字；不纠正、不美化、不猜测它们的对错。
5. 优化方向：讲清目标与边界、补出可验证的完成标准、消除歧义与冗余、长句拆短或编号列出。不得虚构用户没有提到的需求、技术栈或约束。
6. 草稿本身已经清楚简练时只做最小修补，不要为了"看起来改了东西"而重写。`;

/** 芯片表：chips[i] 的占位符序号是 numbers[i]（reserved 避让后两者不再相等） */
export type MaskedDraft = {
  /** 送进模型的文本（芯片已换成占位符） */
  masked: string;
  /** 芯片序列化原文（按出现顺序） */
  chips: string[];
  /** 与 chips 平行：每颗芯片实际占用的占位符序号 */
  numbers: number[];
  /** 草稿里本来就有的占位符字面量序号：还原时按原文保留，不当芯片处理 */
  reserved: Set<number>;
};

/** 收集草稿里已有的占位符字面量序号（占位符分配时避让） */
function collectReserved(text: string): Set<number> {
  const reserved = new Set<number>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) reserved.add(n);
  }
  return reserved;
}

/** 芯片 → 占位符（同时建表）；无芯片时零成本返回原文 */
export function maskDirectives(text: string): MaskedDraft {
  const reserved = collectReserved(text);
  if (!text.includes(":")) return { masked: text, chips: [], numbers: [], reserved };
  const chips: string[] = [];
  const numbers: number[] = [];
  let n = 1;
  const masked = text.replace(DIRECTIVE_RE, (raw) => {
    while (reserved.has(n)) n++;
    chips.push(raw);
    numbers.push(n);
    const token = `[[c${n}]]`;
    n += 1;
    return token;
  });
  return { masked, chips, numbers, reserved };
}

/**
 * 占位符 → 芯片原文（表驱动，见文件头）。规则：
 * - 命中表内序号且未落位 → 换成芯片原文（内容取自表，与模型写法无关）；
 * - 表内序号重复出现 → 只留首个，其余删除；
 * - 表外序号：草稿自带的字面量（reserved）原样保留，否则视为幻影删除；
 * - 删掉的占位符顺带吃掉紧随的一个空格，避免正文留空洞；
 * - 没落位的芯片按原相对顺序补到文末。
 */
export function restoreDirectives(
  text: string,
  chips: string[],
  numbers: number[],
  reserved: Set<number>,
): string {
  if (chips.length === 0 && reserved.size === 0) return text;
  // 序号 → 原文表：reserved 避让让 chips[i] 的序号是 numbers[i]，不能按 i+1 反推
  const chipByNumber = new Map<number, string>();
  for (let i = 0; i < chips.length; i++) chipByNumber.set(numbers[i]!, chips[i]!);
  const placed = new Set<number>();
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    const n = Number(m[1]);
    out += text.slice(last, from);
    last = to;
    const chip = Number.isFinite(n) ? chipByNumber.get(n) : undefined;
    if (chip !== undefined && !placed.has(n)) {
      placed.add(n);
      out += chip;
      continue;
    }
    if (Number.isFinite(n) && reserved.has(n)) {
      // 用户草稿本来就有的字面量：原样留着，不是芯片、也不是幻影
      out += m[0];
      continue;
    }
    if (text[to] === " ") last = to + 1;
  }
  out += text.slice(last);
  const missing = chips.filter((_c, i) => !placed.has(numbers[i]!));
  if (missing.length > 0) {
    const body = out.replace(/\s+$/, "");
    out = `${body ? `${body}\n` : ""}${missing.join(" ")}`;
  }
  return out;
}

/** 输出清洗：剥掉整体包裹的代码围栏、<草稿> 标签、「优化后：」这类前缀行，首尾 trim */
export function cleanOptimizedText(raw: string): string {
  let text = raw.trim();
  // 模型把草稿标签一起吐回来（极少但兜一下）：剥掉成对的首尾标签
  if (/^<\s*草稿\s*>\s*\n?/.test(text) && /\n?\s*<\s*\/\s*草稿\s*>$/.test(text)) {
    text = text
      .replace(/^<\s*草稿\s*>\s*\n?/, "")
      .replace(/\n?\s*<\s*\/\s*草稿\s*>$/, "")
      .trim();
  }
  // 整段被 ``` 围栏包住：取围栏内（只在首尾成对时剥，正文中的代码块不动）
  const fenced = text.match(/^```[\w-]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced?.[1]) text = fenced[1].trim();
  // 开头单独的「优化后：」一类前缀行
  text = text.replace(
    /^(?:优化后(?:的)?(?:提示词|指令|文本)?|Optimized\s+(?:prompt|text)|Revised\s+prompt)\s*[:：]\s*\n?/i,
    "",
  );
  return text.trim();
}

/** done 事件终态消息里的文本块拼接（兼容端点不走 text_delta 时兜底） */
function textFromAssistantMessage(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const p = part as { type?: string; text?: unknown } | null;
    if (p && p.type === "text" && typeof p.text === "string") out += p.text;
  }
  return out;
}

/** one-shot 优化结果：失败带原因（前端 toast 用），成功带还原后文本与芯片数 */
export type PromptOptimizeOutcome =
  | { ok: true; text: string; chipCount: number }
  | { ok: false; error: string };

/** streamSimple 的最小形状（同 session-title-summarize：只透 signal，
 *  测试可注入假流；关思考走本仓库同款语义——不发送 reasoning 参数）；
 *  onPayload 用于出站载荷诊断（见 summarizePayload） */
type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: { signal?: AbortSignal; onPayload?: (payload: unknown) => void },
) => AsyncIterable<unknown>;

/** 出站载荷摘要（诊断用）：每条消息的 role + 字符数，user 消息额外给出
 *  <草稿> 段本身的开头（这才是排障要看的——弱模型把系统说明误当草稿或
 *  声称没收到草稿时，一眼确认实际发出去的草稿是什么）。 */
function summarizePayload(payload: unknown): string {
  const messages = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "<no messages>";
  return messages
    .map((m) => {
      const role = String((m as { role?: unknown })?.role ?? "?");
      const content = (m as { content?: unknown })?.content;
      const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
      if (role === "user") {
        const draft = /<草稿>\n?([\s\S]*?)\n?<\/草稿>/.exec(text)?.[1];
        if (draft !== undefined) {
          return `${role}(${text.length}) draft(${draft.length})=${JSON.stringify(draft.slice(0, 80))}`;
        }
      }
      return `${role}(${text.length})`;
    })
    .join(" ");
}

/** 组装 one-shot 请求上下文（system 规则 + 单条 user 消息，不带任何会话历史）。
 *  草稿用 <草稿> 标签显式框住、指示在 user 消息里复述一遍：弱模型偶发把系统
 *  说明误当草稿去改写（或误以为没收到草稿），标签 + 复述是双保险。 */
export function optimizeContext(masked: string): Context {
  const msg: Message = {
    role: "user",
    content:
      `请优化下面 <草稿> 与 </草稿> 之间的任务指令草稿（这是唯一的待优化文本，` +
      `不要优化本说明、也不要回答草稿里的任务本身），只输出优化后的指令正文：\n\n` +
      `<草稿>\n${masked}\n</草稿>`,
    timestamp: Date.now(),
  };
  return { systemPrompt: OPTIMIZE_SYSTEM_PROMPT, messages: [msg] };
}

/**
 * 草稿 → 优化后草稿（掩码 → one-shot → 清洗 → 还原）。
 * one-shot 不发送 reasoning 参数（关思考 = 不发，与会话 run 管线同款语义，
 * 同 session-title-summarize）：改写任务不需要思考档位，也不该跟着会话
 * 档位把一次回填等成十几秒；即便模型默认吐思考，也只累积 text_delta。
 */
export async function optimizeDraftPrompt(
  streamSimple: StreamSimpleFn,
  model: Model<Api>,
  draft: string,
  options?: { signal?: AbortSignal },
): Promise<PromptOptimizeOutcome> {
  const source = draft.trim();
  if (!source) return { ok: false, error: "草稿为空" };
  if (source.length > OPTIMIZE_MAX_INPUT) {
    return { ok: false, error: `提示词过长（超过 ${OPTIMIZE_MAX_INPUT} 字）` };
  }
  const { masked, chips, numbers, reserved } = maskDirectives(source);
  // 只有芯片没有正文（用户选中技能芯片就点了优化）：模型只会看到占位符，
  // 极易回「我没收到草稿」。本地直接拒，给出可读原因
  if (masked.replace(PLACEHOLDER_RE, "").trim() === "") {
    return { ok: false, error: "草稿里只有芯片，没有可优化的文字" };
  }
  let text = "";
  // done 事件的终态信息：某些兼容端点只把内容放在收尾消息里（text_delta 缺失），
  // 或者把额度烧在思考上被截断（reason=length）——两者都靠这里定性
  let stopReason: string | undefined;
  let finalMessageText = "";
  try {
    for await (const event of streamSimple(model, optimizeContext(masked), {
      signal: options?.signal,
      onPayload: (payload) => logErr("optimize payload:", summarizePayload(payload)),
    })) {
      if (options?.signal?.aborted) return { ok: false, error: "已取消" };
      const ev = event as {
        type?: string;
        delta?: string;
        error?: unknown;
        reason?: string;
        message?: unknown;
      };
      if (ev.type === "text_delta") {
        text += String(ev.delta ?? "");
      } else if (ev.type === "done") {
        stopReason = typeof ev.reason === "string" ? ev.reason : undefined;
        finalMessageText = textFromAssistantMessage(ev.message);
      } else if (ev.type === "error") {
        logErr("prompt optimize stream error:", ev.error);
        return { ok: false, error: "模型返回错误" };
      }
    }
  } catch (err) {
    if (options?.signal?.aborted) return { ok: false, error: "已取消" };
    logErr("prompt optimize failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (options?.signal?.aborted) return { ok: false, error: "已取消" };
  // 增量缺失时回退到终态消息里的文本块（同一份内容，只是没走 delta）
  const raw = text.trim() ? text : finalMessageText;
  const cleaned = cleanOptimizedText(raw);
  if (!cleaned) {
    // 明确把「思考烧额度被截断」与普通空输出分开，前端 toast 直接可读
    const hint = stopReason === "length" ? "（输出被长度截断，多在思考上）" : "";
    logErr(
      "prompt optimize empty output:",
      `reason=${stopReason ?? "unknown"}`,
      `deltas=${text.length}`,
      `final=${finalMessageText.length}`,
    );
    return { ok: false, error: `优化结果为空${hint}` };
  }
  if (cleaned.length > OPTIMIZE_MAX_OUTPUT) {
    return { ok: false, error: "优化结果过长" };
  }
  return {
    ok: true,
    text: restoreDirectives(cleaned, chips, numbers, reserved),
    chipCount: chips.length,
  };
}
