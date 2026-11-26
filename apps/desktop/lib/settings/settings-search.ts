/**
 * 设置页全局搜索索引。
 *
 * 数据源是 settings 词典：按「页面命名空间 → 页面分区」映射，把每个词条
 * （设置行的标题/说明/选项文案）变成一条可搜索记录。索引静态构建，未打开的
 * 设置页不需要挂载 DOM；命中的条目通过 `settings.<namespace>.<path>` 的
 * 词典 key 在目标页渲染后按 `t(key)` 找到对应 SettingRow（见 data-setting-label）。
 */
import {
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTION_LABEL_KEYS,
  type SettingsSection,
} from "./settings-sections";
import { zhSettings } from "@/lib/i18n/locales/zh/settings";
import { enSettings } from "@/lib/i18n/locales/en/settings";

/** 词典顶层命名空间 → 设置页分区。没列出的命名空间不进设置搜索。 */
const NAMESPACE_TO_SECTION: Record<string, SettingsSection> = {
  general: "general",
  appearance: "appearance",
  personalization: "personalization",
  pet: "pet",
  shortcuts: "shortcuts",
  models: "models",
  webSearch: "websearch",
  agentConfig: "agent-config",
  subagentConcurrency: "agent-config",
  ptc: "agent-config",
  toolProfile: "agent-config",
  computerControl: "agent-config",
  autoReview: "agent-config",
  contextBudget: "agent-config",
  sandbox: "agent-config",
  memory: "memory",
  memoryHistory: "memory",
  artifacts: "artifacts",
  uhp: "uhp",
  hooks: "hooks",
  secrets: "secrets",
  projects: "projects",
  projectScope: "projects",
  worktrees: "worktrees",
  archive: "archive",
  backup: "backup",
  networkProxy: "network-proxy",
  accessAccel: "access-accel",
  sshHosts: "ssh-hosts",
  sshConnection: "ssh-hosts",
  inboxSources: "inbox-sources",
  webhooks: "webhooks",
  about: "about",
};

export type SettingsSearchEntry = {
  /** 稳定 id：section + 词典 key */
  id: string;
  section: SettingsSection;
  /** 命中条目本身的 label key（页面条目 = 分区 label） */
  labelKey: string;
  /** 所属页面的 label key（结果的二级面包屑） */
  pageLabelKey: string;
  /** 页面本身（点击只切页，不找行） */
  isPage: boolean;
  /** 中英文原文：跨语言搜索 + 结果排序用 */
  zh: string;
  en: string;
  /** 词典 key 路径与页面名，供英文关键字/开发者写法搜索 */
  keywords: string[];
};

function getValueAt(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function getAt(obj: unknown, path: readonly string[]): string | undefined {
  const value = getValueAt(obj, path);
  return typeof value === "string" ? value : undefined;
}

function flattenStrings(
  obj: unknown,
  path: string[],
  out: Array<{ path: string[]; value: string }>,
): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value.trim()) out.push({ path: [...path, key], value });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenStrings(value, [...path, key], out);
    }
  }
}

function buildIndex(): SettingsSearchEntry[] {
  const entries = new Map<string, SettingsSearchEntry>();
  const add = (entry: SettingsSearchEntry) => {
    // 同一分区里同文案的多个 key（例如多个"系统"选项）只留一条
    const dedupe = `${entry.section}\u0000${entry.zh}\u0000${entry.en}`;
    if (!entries.has(dedupe)) entries.set(dedupe, entry);
  };

  for (const [namespace, section] of Object.entries(NAMESPACE_TO_SECTION)) {
    const pageLabelKey = SETTINGS_SECTION_LABEL_KEYS[section];
    const zhPage = getValueAt(zhSettings, [namespace]);
    const enPage = getValueAt(enSettings, [namespace]);
    // 页面条目本身：搜"模型/代理/Webhooks"能直接命中页面
    const zhPageLabel = getAt(zhSettings, pageLabelKey.split(".").slice(1));
    const enPageLabel = getAt(enSettings, pageLabelKey.split(".").slice(1));
    add({
      id: `page:${section}`,
      section,
      labelKey: pageLabelKey,
      pageLabelKey,
      isPage: true,
      zh: zhPageLabel ?? "",
      en: enPageLabel ?? "",
      keywords: [namespace, section, pageLabelKey],
    });

    const leaves: Array<{ path: string[]; value: string }> = [];
    flattenStrings(zhPage, [], leaves);
    for (const leaf of leaves) {
      const enValue = getAt(enPage, leaf.path);
      const labelKey = `settings.${namespace}.${leaf.path.join(".")}`;
      add({
        id: `${section}:${labelKey}`,
        section,
        labelKey,
        pageLabelKey,
        isPage: false,
        zh: leaf.value,
        en: enValue ?? "",
        keywords: [
          namespace,
          ...leaf.path,
          ...leaf.path.map((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2")),
        ],
      });
    }
  }

  // 合并分组的菜单名本身也要能搜到（如「网络与 SSH」）：成员页的标题
  // 只覆盖各自的名字，不包含合并后的入口文案。primary 与成员页同文案时
  // 会被上面的去重合并掉（如「模型」），不会出现重复页面条目。
  for (const group of SETTINGS_SECTION_GROUPS) {
    const path = group.labelKey.split(".").slice(1);
    const zh = getAt(zhSettings, path) ?? "";
    const en = getAt(enSettings, path) ?? "";
    add({
      id: `group:${group.primary}`,
      section: group.primary,
      labelKey: group.labelKey,
      pageLabelKey: group.labelKey,
      isPage: true,
      zh,
      en,
      // 紧凑写法（去掉空格）让「网络与SSH」也能命中
      keywords: [group.labelKey, zh.replace(/\s+/g, ""), en.replace(/\s+/g, "")],
    });
  }

  return [...entries.values()];
}

const INDEX = buildIndex();

/** 可搜索的页面分区（不含隐藏的 changelog） */
export const SETTINGS_SEARCH_PAGE_SECTIONS: SettingsSection[] = [
  ...new Set(Object.values(NAMESPACE_TO_SECTION)),
];

/** 搜索设置：多关键词 AND；中英文原文、词典 key、页面名都参与匹配 */
export function searchSettings(query: string, limit = 40): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: SettingsSearchEntry; score: number }> = [];

  for (const entry of INDEX) {
    const zh = entry.zh.toLowerCase();
    const en = entry.en.toLowerCase();
    const key = entry.labelKey.toLowerCase();
    const hay = `${zh} ${en} ${key} ${entry.keywords.join(" ").toLowerCase()}`;
    if (!tokens.every((token) => hay.includes(token))) continue;

    let score = entry.isPage ? 20 : 0;
    if (zh === q || en === q) score += 120;
    else if (zh.startsWith(q) || en.startsWith(q)) score += 80;
    else if (zh.includes(q) || en.includes(q)) score += 50;
    if (entry.keywords.some((k) => k.toLowerCase() === q)) score += 30;
    if (key.includes(q)) score += 10;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.isPage !== b.entry.isPage) return a.entry.isPage ? -1 : 1;
    return a.entry.labelKey.localeCompare(b.entry.labelKey);
  });

  return scored.slice(0, Math.max(1, limit)).map((item) => item.entry);
}
