/**
 * 设置页分区 id（URL/深链接与导航共用）。
 *
 * 单独放 lib：设置搜索索引和 settings-page 都要引用，避免组件反向 import。
 * 新增分区时同时更新这里、settings-page 的 GROUPS 和 settings-search 的映射。
 */
export type SettingsSection =
  | "models"
  | "appearance"
  | "about"
  | "changelog"
  | "general"
  | "archive"
  | "projects"
  | "worktrees"
  | "personalization"
  | "pet"
  | "memory"
  | "artifacts"
  | "backup"
  | "shortcuts"
  | "webhooks"
  | "inbox-sources"
  | "hooks"
  | "agent-config"
  | "uhp"
  | "websearch"
  | "secrets"
  | "access-accel"
  | "network-proxy"
  | "ssh-hosts";

/** 分区 → 左侧导航 label key。合并分区仍然各有页内标签。 */
export const SETTINGS_SECTION_LABEL_KEYS: Record<SettingsSection, string> = {
  general: "settings.sections.general",
  appearance: "settings.sections.appearance",
  personalization: "settings.sections.personalization",
  pet: "settings.sections.pet",
  shortcuts: "settings.sections.shortcuts",
  archive: "settings.sections.archive",
  projects: "settings.sections.projects",
  worktrees: "settings.sections.worktrees",
  backup: "settings.sections.backup",
  models: "settings.sections.models",
  "agent-config": "settings.sections.agentConfig",
  uhp: "settings.sections.uhp",
  websearch: "settings.sections.webSearch",
  memory: "settings.sections.memory",
  artifacts: "settings.sections.artifacts",
  hooks: "settings.sections.hooks",
  secrets: "settings.sections.secrets",
  "access-accel": "settings.sections.accessAccel",
  "network-proxy": "settings.sections.networkProxy",
  "ssh-hosts": "settings.sections.sshHosts",
  "inbox-sources": "settings.sections.inboxSources",
  webhooks: "settings.sections.webhooks",
  about: "settings.sections.about",
  changelog: "settings.changelog.title",
};

/**
 * 左侧导航的合并分组：primary 是唯一留在菜单里的分区，其余分区通过页内
 * 标签切换。这样菜单变短，但每个配置页仍只承载一个主题，不会把内容硬堆
 * 进同一屏。
 */
export const SETTINGS_SECTION_GROUPS: ReadonlyArray<{
  primary: SettingsSection;
  /** 左侧唯一入口的菜单文案 */
  labelKey: string;
  sections: readonly SettingsSection[];
}> = [
  // 网页搜索是模型/Agent 的联网后端，跟随模型一起配置
  {
    primary: "models",
    labelKey: "settings.sections.models",
    sections: ["models", "websearch"],
  },
  // 访问加速、网络代理、SSH 主机都是这台机器的出网路径
  {
    primary: "access-accel",
    labelKey: "settings.sections.networkGroup",
    sections: ["access-accel", "network-proxy", "ssh-hosts"],
  },
  // 收件箱来源与 Webhook 都是外部事件进入/离开本机的通道
  {
    primary: "inbox-sources",
    labelKey: "settings.sections.inboxGroup",
    sections: ["inbox-sources", "webhooks"],
  },
];

/** 分区所属的合并组；未合并的分区返回 undefined。 */
export function getSectionGroup(section: SettingsSection) {
  return SETTINGS_SECTION_GROUPS.find((group) => group.sections.includes(section));
}

/** 分区在左侧导航里实际高亮/对应的条目 id。 */
export function getSectionNavId(section: SettingsSection): SettingsSection {
  return getSectionGroup(section)?.primary ?? section;
}
