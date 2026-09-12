/**
 * 个性化（设置 → 个性化）：回复风格 / 称呼与身份 / 人设 / 自定义指令。
 * 整包 JSON 持久化在 SQLite kv 表（key = KV_KEY），Rust 宿主是唯一写入方，
 * 本侧经 host_query 读写；前端经协议 get/set_personalization 访问，set 时由
 * protocol.ts 热替换全部活动会话的系统提示词。
 * 提示词注入点在 modes.ts composeModeSystemPrompt：静态核心与模式段之后、cwd
 * 行之前——全部字段为默认值时块为空串，默认提示词字节级不变（缓存友好）。
 */
import { kvGet, kvSet } from "./hostdb";
import { logErr } from "./log";

/** 回复风格档位（前端设置页同名单；提示词文案见 STYLE_PROMPTS） */
export type PersonalizationStyle =
  | "default"
  | "professional"
  | "friendly"
  | "imaginative"
  | "blunt"
  | "guiding";

/** 个性化设置整包（kv 与协议共用同一形状） */
export type Personalization = {
  style: PersonalizationStyle;
  /** AI 对用户的称呼（空 = 不注入） */
  userName: string;
  /** AI 的名称（空 = 不注入） */
  assistantName: string;
  /** 人设 / 人格描述（空 = 不注入） */
  persona: string;
  /** 自定义指令：每次对话都携带（空 = 不注入） */
  customInstructions: string;
};

export const PERSONALIZATION_KV_KEY = "pi.personalization";

export const PERSONALIZATION_STYLES: readonly PersonalizationStyle[] = [
  "default",
  "professional",
  "friendly",
  "imaginative",
  "blunt",
  "guiding",
];

export const DEFAULT_PERSONALIZATION: Personalization = {
  style: "default",
  userName: "",
  assistantName: "",
  persona: "",
  customInstructions: "",
};

/** 风格附加提示（默认档不注入任何文本；用词与 SYSTEM_PROMPT_CORE 同为英文指令体） */
const STYLE_PROMPTS: Record<PersonalizationStyle, string> = {
  default: "",
  professional:
    "Reply style - professional: be precise, structured and to the point. Lead with the conclusion, keep a neutral businesslike tone, and skip filler and pleasantries.",
  friendly:
    "Reply style - warm and approachable: keep a friendly conversational tone, acknowledge the user's context, and stay encouraging without being saccharine.",
  imaginative:
    "Reply style - imaginative: bring creative angles, analogies and bold ideas into the discussion; explore unconventional options before settling on the pragmatic one. Say clearly when you are brainstorming versus giving a firm recommendation.",
  blunt:
    "Reply style - direct: say what you actually think without hedging or softening. Point out flaws, risks and bad ideas plainly; no filler praise. Stay respectful but never sugarcoat.",
  guiding:
    "Reply style - guiding: prefer short well-aimed questions and options with trade-offs over handing over complete answers, so the user reaches conclusions themselves. When the user asks for a direct answer, give it first and explain the reasoning briefly after.",
};

let current: Personalization = { ...DEFAULT_PERSONALIZATION };

export function getPersonalization(): Personalization {
  return current;
}

/** 任意来源（kv JSON / 协议消息）的宽松规整：未知档位回落默认，字段截断到合理长度 */
export function normalizePersonalization(raw: unknown): Personalization {
  const r = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";
  return {
    style: PERSONALIZATION_STYLES.includes(r.style as PersonalizationStyle)
      ? (r.style as PersonalizationStyle)
      : "default",
    userName: text(r.userName, 60).trim(),
    assistantName: text(r.assistantName, 60).trim(),
    persona: text(r.persona, 4000),
    customInstructions: text(r.customInstructions, 8000),
  };
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initPersonalization(): Promise<void> {
  try {
    const row = await kvGet(PERSONALIZATION_KV_KEY);
    if (row?.value) current = normalizePersonalization(JSON.parse(row.value));
  } catch (err) {
    logErr("personalization: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv（模拟进程重启后内存为空的起点） */
export function resetPersonalizationForTest(): void {
  current = { ...DEFAULT_PERSONALIZATION };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyPersonalization(raw: unknown): Promise<Personalization> {
  const next = normalizePersonalization(raw);
  current = next;
  try {
    await kvSet(PERSONALIZATION_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("personalization: persist failed:", err);
  }
  return next;
}

/** 系统提示词的个人化段：全默认时为空串（composeModeSystemPrompt 过滤空段） */
export function personalizationPromptBlock(): string {
  const p = current;
  const parts: string[] = [];
  const stylePrompt = STYLE_PROMPTS[p.style];
  if (stylePrompt) parts.push(stylePrompt);
  const names = [
    p.assistantName ? `Your name is "${p.assistantName}".` : "",
    p.userName ? `The user goes by "${p.userName}".` : "",
  ].filter(Boolean);
  if (names.length > 0) parts.push(names.join(" "));
  const persona = p.persona.trim();
  if (persona) parts.push(`Persona: ${persona}`);
  const instructions = p.customInstructions.trim();
  if (instructions) {
    parts.push(`The user's custom instructions (always apply): ${instructions}`);
  }
  return parts.join("\n");
}
