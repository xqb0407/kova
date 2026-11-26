/**
 * 斜杠菜单的纯数据与过滤逻辑（不 import React/编辑器实现，单测直接覆盖）。
 *
 * label/description 用 i18n key 而不是写死文案：菜单项在组件里按当前语言翻译，
 * 中英文都能按「标题 / heading / h1 / 大标题」命中。
 */

export type SlashItemId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "divider"
  | "table"
  | "image"
  | "callout"
  | "toggle"
  | "columns";

export type SlashSection = "basic" | "media" | "advanced";

export interface SlashItemDef {
  id: SlashItemId;
  /** i18n key（library.editor.block.*） */
  labelKey: string;
  /** i18n key（library.editor.slash.desc.*） */
  descriptionKey: string;
  section: SlashSection;
  /** 参与搜索的别名（英文/拼音/快捷键式写法） */
  keywords: readonly string[];
  /** 只有原生笔记编辑器支持（Markdown 兼容模式不显示） */
  nativeOnly?: boolean;
}

export const SLASH_SECTIONS: readonly SlashSection[] = [
  "basic",
  "media",
  "advanced",
];

export const SLASH_ITEM_DEFS: readonly SlashItemDef[] = [
  {
    id: "paragraph",
    labelKey: "library.editor.block.paragraph",
    descriptionKey: "library.editor.slash.desc.paragraph",
    section: "basic",
    keywords: ["text", "body", "正文", "段落", "p"],
  },
  {
    id: "heading1",
    labelKey: "library.editor.block.heading1",
    descriptionKey: "library.editor.slash.desc.heading1",
    section: "basic",
    keywords: ["h1", "title", "标题", "一级", "大标题"],
  },
  {
    id: "heading2",
    labelKey: "library.editor.block.heading2",
    descriptionKey: "library.editor.slash.desc.heading2",
    section: "basic",
    keywords: ["h2", "subtitle", "标题", "二级", "中标题"],
  },
  {
    id: "heading3",
    labelKey: "library.editor.block.heading3",
    descriptionKey: "library.editor.slash.desc.heading3",
    section: "basic",
    keywords: ["h3", "标题", "三级", "小标题"],
  },
  {
    id: "bulletList",
    labelKey: "library.editor.block.bulletList",
    descriptionKey: "library.editor.slash.desc.bulletList",
    section: "basic",
    keywords: ["ul", "list", "bullet", "无序", "列表", "圆点"],
  },
  {
    id: "orderedList",
    labelKey: "library.editor.block.orderedList",
    descriptionKey: "library.editor.slash.desc.orderedList",
    section: "basic",
    keywords: ["ol", "list", "number", "有序", "编号", "列表"],
  },
  {
    id: "taskList",
    labelKey: "library.editor.block.taskList",
    descriptionKey: "library.editor.slash.desc.taskList",
    section: "basic",
    keywords: ["todo", "task", "check", "待办", "任务", "清单"],
  },
  {
    id: "blockquote",
    labelKey: "library.editor.block.blockquote",
    descriptionKey: "library.editor.slash.desc.blockquote",
    section: "basic",
    keywords: ["quote", "引用", "引述"],
  },
  {
    id: "image",
    labelKey: "library.editor.block.image",
    descriptionKey: "library.editor.slash.desc.image",
    section: "media",
    keywords: ["img", "picture", "photo", "图片", "照片", "上传"],
  },
  {
    id: "table",
    labelKey: "library.editor.block.table",
    descriptionKey: "library.editor.slash.desc.table",
    section: "media",
    keywords: ["grid", "表格", "行列"],
  },
  {
    id: "codeBlock",
    labelKey: "library.editor.block.codeBlock",
    descriptionKey: "library.editor.slash.desc.codeBlock",
    section: "advanced",
    keywords: ["code", "fence", "代码", "代码块"],
  },
  {
    id: "divider",
    labelKey: "library.editor.block.divider",
    descriptionKey: "library.editor.slash.desc.divider",
    section: "advanced",
    keywords: ["hr", "rule", "line", "分割线", "分隔线", "横线"],
  },
  {
    id: "callout",
    labelKey: "library.editor.block.callout",
    descriptionKey: "library.editor.slash.desc.callout",
    section: "advanced",
    nativeOnly: true,
    keywords: ["callout", "note", "tip", "提示", "高亮", "卡片"],
  },
  {
    id: "toggle",
    labelKey: "library.editor.block.toggle",
    descriptionKey: "library.editor.slash.desc.toggle",
    section: "advanced",
    nativeOnly: true,
    keywords: ["toggle", "fold", "collapse", "折叠", "展开"],
  },
  {
    id: "columns",
    labelKey: "library.editor.block.columns",
    descriptionKey: "library.editor.slash.desc.columns",
    section: "advanced",
    nativeOnly: true,
    keywords: ["columns", "layout", "分栏", "双栏", "布局"],
  },
];

export interface SlashFilterItem {
  id: string;
  label: string;
  description?: string;
  keywords: readonly string[];
}

/** 空查询返回全部；否则按「标签前缀 > 标签包含 > 描述/关键词」打分并稳定排序 */
export function filterSlashItems<T extends SlashFilterItem>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().replace(/^\/+/, "").toLowerCase();
  if (!needle) return [...items];

  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const description = (item.description ?? "").toLowerCase();
    let score = 0;
    if (label.startsWith(needle)) score = 7;
    else if (label.includes(needle)) score = 6;
    else if (item.id.toLowerCase().startsWith(needle)) score = 5;
    else if (description.includes(needle)) score = 4;
    else if (
      item.keywords.some((keyword) => keyword.toLowerCase().startsWith(needle))
    )
      score = 3;
    else if (item.keywords.some((keyword) => keyword.includes(needle)))
      score = 2;
    if (score > 0) scored.push({ item, score, index });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((row) => row.item);
}

/* ------------------------------ 最近使用 ------------------------------ */

const RECENT_KEY = "kova.richEditor.slashRecent";
const RECENT_MAX = 4;

/** 最近使用的块 id（localStorage 不可用/损坏时返回空） */
export function readRecentSlashIds(): SlashItemId[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const known = new Set(SLASH_ITEM_DEFS.map((item) => item.id));
    return parsed
      .filter(
        (id): id is SlashItemId =>
          typeof id === "string" && known.has(id as SlashItemId),
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 记录一次使用；返回最新列表（失败静默降级） */
export function rememberSlashId(id: SlashItemId): SlashItemId[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const next = [id, ...readRecentSlashIds().filter((item) => item !== id)]
      .slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [];
  }
}
