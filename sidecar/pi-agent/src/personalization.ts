/**
 * 个性化（设置 → 个性化）：回复风格 / 称呼与身份 / 人设 / 自定义指令。
 * 结构化字段（style / 双向称呼）整包存 SQLite kv（key = KV_KEY），Rust 宿主是唯一
 * 写入方，本侧经 host_query 读写；人设与自定义指令是 Markdown 长文本，事实源在全局
 * 目录身份文件 ~/.xulux/soul.md 与 ~/.xulux/rules.md（PI_IDENTITY_DIR 可覆盖，测试用），
 * 可用任意编辑器外部修改——get 与提示词合成时实时读盘，外部改动在下一个合成点
 * （新会话 / 模式切换 / set_*）生效。旧版 kv 整包里的这两个字段在启动时一次性迁移到
 * 文件（文件已存在则文件优先），kv 随即收敛为仅结构化字段。
 * 前端经协议 get/set_personalization 访问，set 时由 protocol.ts 热替换全部活动会话的
 * 系统提示词。注入点在 modes.ts composeModeSystemPrompt：静态核心与模式段之后、cwd
 * 行之前——全部字段为默认值时块为空串，默认提示词字节级不变（缓存友好）。
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** 个性化设置整包（协议与前端镜像共用同一形状；persona/customInstructions 实质存于身份文件） */
export type Personalization = {
  style: PersonalizationStyle;
  /** AI 对用户的称呼（空 = 不注入） */
  userName: string;
  /** AI 的名称（空 = 不注入） */
  assistantName: string;
  /** 人设 / 人格描述：事实源 ~/.xulux/soul.md（空/文件缺失 = 不注入） */
  persona: string;
  /** 自定义指令：每次对话都携带，事实源 ~/.xulux/rules.md（空/文件缺失 = 不注入） */
  customInstructions: string;
};

export const PERSONALIZATION_KV_KEY = "pi.personalization";

/* --------------------------------- 身份文件 --------------------------------- */

export const SOUL_FILE_NAME = "soul.md";
export const RULES_FILE_NAME = "rules.md";

/** 协议防御上限：远端可经 WS 下发任意长字符串，落盘前收口（非注入预算） */
export const PROTOCOL_TEXT_MAX_CHARS = 200_000;

/** 身份文件目录（~/.xulux；PI_IDENTITY_DIR 可覆盖，测试用） */
export function identityDir(): string {
  if (process.env.PI_IDENTITY_DIR) return resolve(process.env.PI_IDENTITY_DIR);
  return join(homedir(), ".xulux");
}

export const soulFilePath = (): string => join(identityDir(), SOUL_FILE_NAME);
export const rulesFilePath = (): string => join(identityDir(), RULES_FILE_NAME);

/** 注入预算：超出从头部截断（与旧版 kv 存储时代的 normalize 上限一致；文件本身不截断） */
const PERSONA_MAX_CHARS = 4_000;
const INSTRUCTIONS_MAX_CHARS = 8_000;

/** 读身份文件：不存在/不可读返回空串（文件即事实源，删文件 = 清空该字段） */
function readIdentityFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function writeIdentityFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** kv 持久化形状：仅结构化字段（persona/自定义指令在身份文件） */
const structuredSettings = (p: Personalization) => ({
  style: p.style,
  userName: p.userName,
  assistantName: p.assistantName,
});

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

/** 取当前设置：persona/自定义指令每次从身份文件实时读，外部编辑即时可见 */
export function getPersonalization(): Personalization {
  return {
    ...current,
    persona: readIdentityFile(soulFilePath()),
    customInstructions: readIdentityFile(rulesFilePath()),
  };
}

/** 任意来源（kv JSON / 协议消息）的宽松规整：未知档位回落默认，称呼去空白，
 *  persona/自定义指令仅做防御性收口（写文件不截断，注入时另有预算） */
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
    persona: text(r.persona, PROTOCOL_TEXT_MAX_CHARS),
    customInstructions: text(r.customInstructions, PROTOCOL_TEXT_MAX_CHARS),
  };
}

/** 启动恢复：kv 装结构化字段，并把旧版整包里的 persona/自定义指令迁移到身份文件；
 *  失败保持默认（不阻断启动） */
export async function initPersonalization(): Promise<void> {
  try {
    const row = await kvGet(PERSONALIZATION_KV_KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      current = normalizePersonalization(parsed);
      await migrateLegacyKv(parsed);
    }
  } catch (err) {
    logErr("personalization: load failed:", err);
  }
}

/** 旧版 kv 整包迁移：文件缺失时写出（文件优先，不覆盖外部已有文件），
 *  随后 kv 收敛为仅结构化字段，旧字段不再残留 */
async function migrateLegacyKv(parsed: Record<string, unknown>): Promise<void> {
  const persona = typeof parsed.persona === "string" ? parsed.persona : "";
  const instructions =
    typeof parsed.customInstructions === "string" ? parsed.customInstructions : "";
  let migrated = false;
  if (persona.trim() && !existsSync(soulFilePath())) {
    await writeIdentityFile(soulFilePath(), persona);
    migrated = true;
  }
  if (instructions.trim() && !existsSync(rulesFilePath())) {
    await writeIdentityFile(rulesFilePath(), instructions);
    migrated = true;
  }
  if (migrated) {
    await kvSet(PERSONALIZATION_KV_KEY, JSON.stringify(structuredSettings(current)));
  }
}

/** 测试辅助：仅清内存不落 kv（模拟进程重启后内存为空的起点） */
export function resetPersonalizationForTest(): void {
  current = { ...DEFAULT_PERSONALIZATION };
}

/** 应用新设置：内存即时生效；persona/自定义指令写身份文件（事实源），kv 只落
 *  结构化字段；持久化失败仅记日志（下次启动回落） */
export async function applyPersonalization(raw: unknown): Promise<Personalization> {
  const next = normalizePersonalization(raw);
  current = next;
  try {
    await writeIdentityFile(soulFilePath(), next.persona);
    await writeIdentityFile(rulesFilePath(), next.customInstructions);
    await kvSet(PERSONALIZATION_KV_KEY, JSON.stringify(structuredSettings(next)));
  } catch (err) {
    logErr("personalization: persist failed:", err);
  }
  return next;
}

/** 系统提示词的个人化段：persona/自定义指令实时读身份文件（外部编辑在下一个合成
 *  点生效）；全默认/文件缺失时为空串（composeModeSystemPrompt 过滤空段） */
export function personalizationPromptBlock(): string {
  const parts: string[] = [];
  const stylePrompt = STYLE_PROMPTS[current.style];
  if (stylePrompt) parts.push(stylePrompt);
  const names = [
    current.assistantName ? `Your name is "${current.assistantName}".` : "",
    current.userName ? `The user goes by "${current.userName}".` : "",
  ].filter(Boolean);
  if (names.length > 0) parts.push(names.join(" "));
  const persona = readIdentityFile(soulFilePath()).trim().slice(0, PERSONA_MAX_CHARS);
  if (persona) parts.push(`Persona: ${persona}`);
  const instructions = readIdentityFile(rulesFilePath())
    .trim()
    .slice(0, INSTRUCTIONS_MAX_CHARS);
  if (instructions) {
    parts.push(`The user's custom instructions (always apply): ${instructions}`);
  }
  return parts.join("\n");
}
