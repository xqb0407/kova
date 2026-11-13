"use client";

import { useEffect, useSyncExternalStore } from "react";
import { piRequest, type PiSkillEntry, type PiSkillScope, type PiSkillsResponse } from "@/lib/pi/pi-bridge";
import { addPiChannelListener } from "@/lib/pi/pi-channel";
import { isRemoteMode } from "@/lib/remote";
import { getWorkspace } from "@/lib/workspace/workspace-store";

/**
 * 技能（设置 → 技能）：前端镜像 store。
 * 事实源在 sidecar——可写层 .md 文档（<cwd>/.kova/skills、应用数据 skills/、
 * 生态用户目录 ~/.agents/skills）+ 只读生态发现层 + kv 里的启用开关；这里只做
 * 清单镜像与变更动作。所有变更命令的应答都是刷新后的清单，改后即见；活动会话
 * 的系统提示词热替换由 sidecar 完成，轮中经 loopContext 立即生效。
 */
export type SkillEntry = PiSkillEntry;
export type SkillScope = PiSkillScope;

/** 可写技能层：系统（应用数据）/ 工作区 / 生态用户目录（~/.agents/skills） */
export type SkillSaveScope = "system" | "workspace" | "compat";

/** 技能层优先级：数字越小越优先（与 sidecar mergeLayers 同序）。 */
export const SKILL_SCOPE_RANK: Record<SkillScope, number> = {
  workspace: 0,
  "compat-workspace": 1,
  external: 2,
  system: 3,
  compat: 4,
  plugin: 5,
};

/** scope 展示名的 i18n key（设置页与市场共用） */
export const SKILL_SCOPE_LABEL_KEY: Record<SkillScope, string> = {
  workspace: "settings.skills.scopeWorkspace",
  "compat-workspace": "settings.skills.scopeCompatWorkspace",
  external: "settings.skills.scopeExternal",
  system: "settings.skills.scopeSystem",
  compat: "settings.skills.scopeCompatUser",
  plugin: "settings.skills.scopePlugin",
};

/** 表单草稿（frontmatter 三字段 + 正文） */
export type SkillDraft = {
  name: string;
  description: string;
  content: string;
  disableModelInvocation?: boolean;
};

export type SkillsSnapshot = {
  loading: boolean;
  error: string | null;
  skills: SkillEntry[];
  /** scope "plugin" 的条目（技能设置页不渲染；`/` 菜单与插件详情消费） */
  pluginSkills: SkillEntry[];
  /** 本次清单对应的工作区 cwd */
  workspaceCwd: string | null;
  /** 加载诊断（坏文件等），不致命 */
  diagnostics: string[];
};

const EMPTY: SkillsSnapshot = {
  loading: false,
  error: null,
  skills: [],
  pluginSkills: [],
  workspaceCwd: null,
  diagnostics: [],
};

// 清单按 cwd 分桶（与 MCP/命令清单同款）：设置页可以浏览与当前会话不同的
// 工作区，市场与输入框也可能各自用不同 cwd。共用一个 snapshot 会互相覆盖——
// 表现为「市场里装完技能，回到对话 `/` 菜单看不到工作区技能」。
const snapshots = new Map<string, SkillsSnapshot>();
// 每个 cwd 的请求代次：慢的 list 响应不能覆盖后发的变更结果
const snapshotSeq = new Map<string, number>();
const listeners = new Set<() => void>();

const keyOf = (cwd?: string | null): string => cwd ?? "";

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function fromResponse(res: PiSkillsResponse): SkillsSnapshot {
  return {
    loading: false,
    error: null,
    skills: res.skills,
    pluginSkills: res.pluginSkills ?? [],
    workspaceCwd: res.workspaceCwd,
    diagnostics: res.diagnostics,
  };
}

function setSnapshot(key: string, snapshot: SkillsSnapshot) {
  snapshots.set(key, snapshot);
  emit();
}

function bumpSeq(key: string): number {
  const next = (snapshotSeq.get(key) ?? 0) + 1;
  snapshotSeq.set(key, next);
  return next;
}

/** 拉取某个 cwd 的清单（写回各自桶；sidecar 不可用时保留旧镜像并记录错误） */
export async function refreshSkills(cwd?: string | null): Promise<void> {
  const key = keyOf(cwd);
  const seq = bumpSeq(key);
  setSnapshot(key, { ...(snapshots.get(key) ?? EMPTY), loading: true });
  try {
    const res = await piRequest<PiSkillsResponse>({
      type: "list_skills",
      ...(cwd ? { cwd } : {}),
    });
    if (snapshotSeq.get(key) !== seq) return;
    setSnapshot(key, fromResponse(res));
  } catch (err) {
    if (snapshotSeq.get(key) !== seq) return;
    setSnapshot(key, {
      ...(snapshots.get(key) ?? EMPTY),
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 变更命令统一出口：应答即新清单，写回发起命令的 cwd 桶。
 *  viewCwd 用于「命令自身不带 cwd（系统层），但调用方正在看某个工作区视图」：
 *  此时响应只含系统/插件层，需要补拉该视图的完整清单，否则视图/`/` 菜单
 *  看不到刚装好的工作区技能。 */
async function mutate(
  payload: Record<string, unknown>,
  viewCwd?: string | null,
): Promise<void> {
  const key = keyOf(typeof payload.cwd === "string" ? payload.cwd : null);
  // 作废该桶在飞的 list 响应，避免旧清单把变更结果盖回去
  bumpSeq(key);
  try {
    const res = await piRequest<PiSkillsResponse>(payload);
    setSnapshot(key, fromResponse(res));
    const viewKey = viewCwd === undefined ? null : keyOf(viewCwd);
    if (viewKey !== null && viewKey !== key) {
      await refreshSkills(viewCwd);
    }
    if (key === "") {
      // 系统层命令没带 cwd：当前活动工作区视图也要感知（开关/删除是全局的）
      const active = getWorkspace();
      if (active && keyOf(active) !== viewKey) void refreshSkills(active);
    }
  } catch (err) {
    setSnapshot(key, {
      ...(snapshots.get(key) ?? EMPTY),
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** 附属文件（市场多文件技能）：相对技能目录的安全相对路径 + 文本内容 */
export type SkillAuxFile = { path: string; content: string };

/**
 * 保存（新建/编辑）。raw 为 SKILL.md 原文模式（导入路径，frontmatter 以 sidecar
 * 解析为准，fallbackName 用文件名 stem 兜底）；name 传编辑前的原名（改名时 sidecar 清旧文件）。
 * files 非空时按目录式技能落盘（<slug>/SKILL.md + files），附属文件与正文同目录。
 */
export function saveSkill(args: {
  scope: SkillSaveScope;
  cwd?: string | null;
  name?: string;
  draft?: SkillDraft;
  raw?: string;
  fallbackName?: string;
  files?: SkillAuxFile[];
  /** 调用方正在浏览的工作区（系统层保存后补拉该视图清单；市场安装用） */
  viewCwd?: string | null;
}): Promise<void> {
  return mutate(
    {
      type: "save_skill",
      scope: args.scope,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.fallbackName ? { fallbackName: args.fallbackName } : {}),
      ...(args.files?.length ? { files: args.files } : {}),
      ...(args.raw !== undefined ? { raw: args.raw } : { definition: args.draft }),
    },
    args.viewCwd,
  );
}

export function deleteSkill(
  scope: SkillSaveScope,
  name: string,
  cwd?: string | null,
): Promise<void> {
  return mutate({
    type: "delete_skill",
    scope,
    name,
    ...(cwd ? { cwd } : {}),
  });
}

export function setSkillEnabled(
  scope: SkillScope,
  name: string,
  enabled: boolean,
  cwd?: string | null,
  pluginId?: string,
): Promise<void> {
  return mutate({
    type: "set_skill_enabled",
    scope,
    name,
    enabled,
    ...(pluginId ? { pluginId } : {}),
    ...(cwd ? { cwd } : {}),
  });
}

/** 批量开关：targets 整表置为目标状态（设置页「全部启用 / 全部关闭」快捷） */
export function setSkillsEnabled(
  targets: Array<{ scope: SkillScope; name: string }>,
  enabled: boolean,
  cwd?: string | null,
): Promise<void> {
  return mutate({
    type: "set_skills_enabled",
    targets,
    enabled,
    ...(cwd ? { cwd } : {}),
  });
}

/** 订阅某个 cwd 的清单快照（按桶隔离；首次订阅该 cwd 时自动拉取） */
export function useSkills(cwd: string | null): SkillsSnapshot {
  const key = keyOf(cwd);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => snapshots.get(key) ?? EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    const existing = snapshots.get(key);
    // 首次挂载，或上一次拉取失败且没有可展示的数据：补拉一次。
    // 已有清单（包括别处变更命令写回的）直接复用，不重复请求。
    const emptyFailure =
      existing != null &&
      existing.error != null &&
      existing.skills.length === 0 &&
      !existing.loading;
    if (!existing || emptyFailure) void refreshSkills(cwd);
  }, [key, cwd]);
  return snapshot;
}

/**
 * 新建技能的起始模板：打开编辑器看到的就是一份"填了就能用"的技能——
 * When to use / Steps / Notes 是每份好技能的通用骨架，空编辑器什么都教不了。
 */
export function skillTemplate(name: string): string {
  const title = name.trim() || "New skill";
  return `# ${title}

## When to use this
Describe the situation that should make the model reach for this skill.

## Steps
1. ...
2. ...

## Notes
Anything the model would otherwise guess wrong.
`;
}

// client bundle 加载即按当前工作区水合（SSR 端返回空快照，不请求）
if (typeof window !== "undefined") void refreshSkills(getWorkspace());

// 远程模式：上面的首帧水合发生在 WS 通道注册之前（落到 桌面壳 兜底通道失败，
// 镜像停在错误态且无人重试），通道换代时按当前工作区重拉一次
// （与 pi-sessions-sync 同款思路；桌面端走 桌面通道既有路径无需重拉，
// 测试/预览环境的假通道由 isRemoteMode 挡掉）
addPiChannelListener((ch) => {
  if (ch?.kind === "ws" && isRemoteMode()) void refreshSkills(getWorkspace());
});
