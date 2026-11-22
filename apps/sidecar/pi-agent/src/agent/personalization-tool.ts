/**
 * 个性化设置管理工具：personalization_get / personalization_update。
 *
 * 设置页写个性化走协议 set_personalization；AI 之前只能 write/edit 手写
 * ~/.kova/soul.md、rules.md，绕过了字段级合并与活动会话提示词热重排，也容易
 * 被设置页的旧快照覆盖。本工具把同一套 applyPersonalization 语义暴露给模型：
 * - get：读当前全局设置（含身份文件路径），修改前先看现值；
 * - update：只提交传入的字段；persona/customInstructions 支持 append，避免
 *   整段覆盖；落盘后由 sessions 注入的 onUpdated 重排所有活动会话的提示词。
 *
 * 管理工具挂在 Task 组旁（run.subagentTools），不在 baseTools 里；delegate
 * 按定义取基础目录时结构性拿不到它们。update 在 APPROVAL_REQUIRED_TOOLS 里，
 * 与 skills_save / subagents_save 同款逐次审批；get 只读，不进审批。
 */
import { arr, bool, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logErr } from "../log";
import {
  applyPersonalization,
  CUSTOM_STYLE_ID_MAX_CHARS,
  CUSTOM_STYLE_ID_PREFIX,
  CUSTOM_STYLES_MAX,
  getPersonalization,
  PERSONALIZATION_STYLES,
  rulesFilePath,
  soulFilePath,
  type Personalization,
  type PersonalizationField,
} from "./personalization";

export const PERSONALIZATION_TOOL_NAMES = {
  get: "personalization_get",
  update: "personalization_update",
} as const;

/** update 的单字段文本改动：replace = 整体替换（text 空串 = 清空）；
 *  append = 在现有内容后追加（text 不能为空）。 */
const textUpdateSchema = obj({
  mode: opt(
    union([lit("replace"), lit("append")], {
      description: '"replace"（默认）整体替换；"append" 追加到现有内容之后',
    }),
  ),
  text: str({
    description: "要写入的完整 Markdown/纯文本；replace 模式传空串即清空",
  }),
});

const customStyleSchema = obj({
  id: str({ description: "自定义风格 id（沿用现值；新建时由前端生成）" }),
  name: opt(str({ description: "展示名，≤24 字符" })),
  prompt: opt(str({ description: "原样注入系统提示词的风格描述，≤4000 字符" })),
});

const styleOverrideSchema = obj({
  id: str({
    description:
      '内置档位 id：default / professional / friendly / imaginative / blunt / guiding',
  }),
  name: opt(str({ description: "覆盖展示名；空 = 用内置标签" })),
  prompt: opt(str({ description: "覆盖提示词；空 = 用内置文案" })),
  hidden: opt(bool({ description: "true = 在设置页隐藏该内置档（仍可被选中注入）" })),
});

function textResult(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${text}` }],
    details: { error: text },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 长文本预览：设置页的注入预算分别为 4k/8k，get 回显 12k 足够；超出部分
 *  明确提示用 read 读文件，避免模型误以为看到的就是全文。 */
const MAX_ECHO_CHARS = 12_000;

function echo(text: string): string {
  if (!text.trim()) return "（空）";
  return text.length <= MAX_ECHO_CHARS
    ? text
    : `${text.slice(0, MAX_ECHO_CHARS)}\n…（已截断 ${text.length - MAX_ECHO_CHARS} 字符；完整内容用 read 读取对应文件）`;
}

function promptPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

function renderSettings(
  settings: Personalization,
  includeStylePrompts: boolean,
  /** update 回执不回显整段人设/规则正文（模型刚写的，不需要再读一遍）；get 才回显 */
  includeIdentityText = true,
): string {
  const lines: string[] = [
    "当前全局个性化设置：",
    `- 回复风格：${settings.style}`,
    `- 用户称呼：${settings.userName || "（未设置）"}`,
    `- AI 称呼：${settings.assistantName || "（未设置）"}`,
    `- 自定义风格：${settings.styles.length} 个`,
  ];
  for (const style of settings.styles) {
    lines.push(
      `  - ${style.id} | ${style.name} | ${
        includeStylePrompts
          ? echo(style.prompt).replace(/\n/g, "\n    ")
          : promptPreview(style.prompt)
      }`,
    );
  }
  lines.push(`- 内置档覆盖：${settings.styleOverrides.length} 条`);
  for (const override of settings.styleOverrides) {
    lines.push(
      `  - ${override.id} | name=${override.name || "（内置）"} | hidden=${
        override.hidden ? "true" : "false"
      } | ${
        includeStylePrompts
          ? echo(override.prompt).replace(/\n/g, "\n    ")
          : promptPreview(override.prompt)
      }`,
    );
  }
  if (includeIdentityText) {
    lines.push(
      "",
      `人设（soul.md，${settings.persona.length} 字符）：`,
      echo(settings.persona),
      "",
      `自定义指令（rules.md，${settings.customInstructions.length} 字符）：`,
      echo(settings.customInstructions),
    );
  } else {
    lines.push(
      "",
      `人设（soul.md）：${settings.persona.length} 字符`,
      `自定义指令（rules.md）：${settings.customInstructions.length} 字符`,
    );
  }
  lines.push(
    "",
    `身份文件：soul=${soulFilePath()} rules=${rulesFilePath()}`,
  );
  return lines.join("\n");
}

/** append 语义：去掉现有内容尾部空白后空一行追加；空 base 直接写新内容。 */
function appendText(base: string, text: string): string {
  const head = base.replace(/\s+$/, "");
  return head ? `${head}\n\n${text}` : text;
}

type TextUpdate = { mode?: unknown; text?: unknown };

function resolveTextUpdate(
  label: string,
  update: TextUpdate,
  base: string,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof update.text !== "string") {
    return { ok: false, error: `${label}.text 必须是字符串` };
  }
  if (update.mode === "append") {
    if (!update.text.trim()) {
      return { ok: false, error: `${label}.text 在 append 模式下不能为空` };
    }
    return { ok: true, text: appendText(base, update.text) };
  }
  if (update.mode === undefined || update.mode === "replace") {
    return { ok: true, text: update.text };
  }
  return {
    ok: false,
    error: `${label}.mode 只能是 "replace" 或 "append"（收到 ${String(update.mode)}）`,
  };
}

/** styles 整表替换前的形状校验：normalize 会静默丢弃缺 id/重复 id 的条目，
 *  工具层先把这类输入挡成明确错误，避免模型"以为替换成功、实际丢了几条"。 */
function validateStyleList(raw: unknown): string | null {
  if (!Array.isArray(raw)) return "styles 必须是数组";
  if (raw.length > CUSTOM_STYLES_MAX) {
    return `自定义风格最多 ${CUSTOM_STYLES_MAX} 个`;
  }
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `styles[${i}] 必须是对象`;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim()) {
      return `styles[${i}].id 必须是非空字符串`;
    }
    const id = r.id.slice(0, CUSTOM_STYLE_ID_MAX_CHARS).trim();
    if (seen.has(id)) return `styles 里 id 重复：${id}`;
    seen.add(id);
    if (r.name !== undefined && typeof r.name !== "string") {
      return `styles[${i}].name 必须是字符串`;
    }
    if (r.prompt !== undefined && typeof r.prompt !== "string") {
      return `styles[${i}].prompt 必须是字符串`;
    }
  }
  return null;
}

function validateOverrideList(raw: unknown): string | null {
  if (!Array.isArray(raw)) return "styleOverrides 必须是数组";
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `styleOverrides[${i}] 必须是对象`;
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      !(PERSONALIZATION_STYLES as readonly string[]).includes(r.id)
    ) {
      return `styleOverrides[${i}].id 必须是内置档位：${PERSONALIZATION_STYLES.join(" / ")}`;
    }
    if (seen.has(r.id)) return `styleOverrides 里 id 重复：${r.id}`;
    seen.add(r.id);
    if (r.name !== undefined && typeof r.name !== "string") {
      return `styleOverrides[${i}].name 必须是字符串`;
    }
    if (r.prompt !== undefined && typeof r.prompt !== "string") {
      return `styleOverrides[${i}].prompt 必须是字符串`;
    }
    if (r.hidden !== undefined && typeof r.hidden !== "boolean") {
      return `styleOverrides[${i}].hidden 必须是布尔值`;
    }
  }
  return null;
}

function validateStyleValue(
  style: string,
  styles: readonly { id: string }[],
): string | null {
  if ((PERSONALIZATION_STYLES as readonly string[]).includes(style)) return null;
  if (style.startsWith(CUSTOM_STYLE_ID_PREFIX)) {
    const id = style.slice(CUSTOM_STYLE_ID_PREFIX.length);
    if (id && styles.some((entry) => entry.id === id)) return null;
    return `style 引用的自定义风格不存在：${style}`;
  }
  return `style 必须是内置档位（${PERSONALIZATION_STYLES.join(" / ")}）或 custom:<id>`;
}

export type PersonalizationToolDeps = {
  /** 更新成功后重排所有活动会话的系统提示词（由 sessions 注入，避免模块环）。 */
  onUpdated: () => void;
};

export function buildPersonalizationTools({
  onUpdated,
}: PersonalizationToolDeps): AgentTool[] {
  const getTool: AgentTool = {
    name: PERSONALIZATION_TOOL_NAMES.get,
    label: "查看个性化设置",
    description: [
      "读取用户的全局个性化设置（设置 → 个性化）：回复风格、自定义风格、内置档覆盖、用户/AI 称呼、人设（soul.md）、自定义指令（rules.md），以及两个身份文件的绝对路径。",
      "修改前先调用它拿现值；styles/styleOverrides 是整表替换，替换前必须先用它拿完整条目（includeStylePrompts=true 会附带每条的完整 prompt）。",
      "返回的长文本最多回显 12000 字符；需要全文时用 read 读取路径。",
    ].join("\n\n"),
    parameters: obj({
      includeStylePrompts: opt(
        bool({
          description:
            "true = 附带自定义风格与内置覆盖的完整 prompt（默认只给一行摘要）",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { includeStylePrompts?: boolean };
      return textResult(
        renderSettings(
          getPersonalization(),
          p.includeStylePrompts === true,
        ),
      );
    },
  };

  const updateTool: AgentTool = {
    name: PERSONALIZATION_TOOL_NAMES.update,
    label: "修改个性化设置",
    description: [
      "修改用户的全局个性化设置（设置 → 个性化），字段级合并：只写传入的字段，没传的规则/人设保持磁盘现值。",
      "persona / customInstructions 用 { mode, text }：追加规则用 mode=append（自动空一行拼接）；整体重写用 mode=replace；清空传 replace + 空字符串。",
      "styles / styleOverrides 是整表替换：改前先 personalization_get（includeStylePrompts=true）拿完整条目，再传完整数组，否则会丢条目。",
      "不要再用 write/edit 手写 ~/.kova/soul.md 或 rules.md——本工具会做字段合并、落 SQLite/身份文件，并立即重排所有活动会话的系统提示词。",
      "这是全局设置，会影响所有会话；改完设置页下次打开/聚焦会刷新。",
    ].join("\n\n"),
    parameters: obj({
      userName: opt(str({ description: "用户称呼；空串 = 清除" })),
      assistantName: opt(str({ description: "AI 的称呼；空串 = 清除" })),
      style: opt(
        str({
          description:
            '回复风格：default / professional / friendly / imaginative / blunt / guiding，或 "custom:<id>" 引用自定义风格',
        }),
      ),
      styles: opt(
        arr(customStyleSchema, {
          description:
            "自定义风格整表（替换现有列表）；id/name/prompt 全量提供",
        }),
      ),
      styleOverrides: opt(
        arr(styleOverrideSchema, {
          description: "内置档覆盖整表（替换现有列表）；无覆盖传空数组",
        }),
      ),
      persona: opt(textUpdateSchema),
      customInstructions: opt(textUpdateSchema),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as {
        userName?: unknown;
        assistantName?: unknown;
        style?: unknown;
        styles?: unknown;
        styleOverrides?: unknown;
        persona?: TextUpdate;
        customInstructions?: TextUpdate;
      };
      const current = getPersonalization();
      const next: Partial<Personalization> = {};
      const changed: PersonalizationField[] = [];
      const set = <K extends keyof Personalization>(
        key: K,
        value: Personalization[K],
      ) => {
        next[key] = value;
        changed.push(key as PersonalizationField);
      };

      if (p.userName !== undefined && typeof p.userName !== "string") {
        return errorResult("userName 必须是字符串");
      }
      if (p.assistantName !== undefined && typeof p.assistantName !== "string") {
        return errorResult("assistantName 必须是字符串");
      }
      if (p.userName !== undefined) set("userName", p.userName);
      if (p.assistantName !== undefined) set("assistantName", p.assistantName);

      // styles 先校验再定 style：同一次调用里同时传两者时，style 的白名单要
      // 包含本次新增的自定义条目
      let stylePool: readonly { id: string }[] = current.styles;
      if (p.styles !== undefined) {
        const error = validateStyleList(p.styles);
        if (error) return errorResult(error);
        const styles = p.styles as Array<{ id: string }>;
        stylePool = styles.map((entry) => ({
          id: entry.id.slice(0, CUSTOM_STYLE_ID_MAX_CHARS).trim(),
        }));
        set("styles", styles as Personalization["styles"]);
      }
      if (p.style !== undefined) {
        if (typeof p.style !== "string") return errorResult("style 必须是字符串");
        const error = validateStyleValue(p.style, stylePool);
        if (error) return errorResult(error);
        set("style", p.style as Personalization["style"]);
      }
      if (p.styleOverrides !== undefined) {
        const error = validateOverrideList(p.styleOverrides);
        if (error) return errorResult(error);
        set(
          "styleOverrides",
          p.styleOverrides as Personalization["styleOverrides"],
        );
      }
      if (p.persona !== undefined) {
        const resolved = resolveTextUpdate("persona", p.persona, current.persona);
        if (!resolved.ok) return errorResult(resolved.error);
        set("persona", resolved.text);
      }
      if (p.customInstructions !== undefined) {
        const resolved = resolveTextUpdate(
          "customInstructions",
          p.customInstructions,
          current.customInstructions,
        );
        if (!resolved.ok) return errorResult(resolved.error);
        set("customInstructions", resolved.text);
      }

      if (changed.length === 0) {
        return errorResult(
          "没有提供要修改的字段。至少传 userName / assistantName / style / styles / styleOverrides / persona / customInstructions 之一。",
        );
      }

      try {
        const settings = await applyPersonalization(
          { ...current, ...next },
          changed,
        );
        try {
          onUpdated();
        } catch (err) {
          // 提示词重排失败不影响已落盘的设置；下一轮 syncRunPrompt 会自愈
          logErr("personalization-tool: prompt refresh failed:", errorMessage(err));
        }
        return textResult(
          [
            `已更新：${changed.join(", ")}`,
            "",
            renderSettings(settings, false, false),
            "",
            "活动会话的系统提示词已重排；设置页下次打开或窗口聚焦时会刷新。",
          ].join("\n"),
          { changed, settings },
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  return [getTool, updateTool];
}
