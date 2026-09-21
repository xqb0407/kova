"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { piRequest, type PiSkillEntry, type PiSkillScope, type PiSkillsResponse } from "@/lib/pi/pi-bridge";
import { getWorkspace } from "@/lib/workspace/workspace-store";

/**
 * 技能（设置 → 技能）：前端镜像 store。
 * 事实源在 sidecar——托管层 .md 文档（<cwd>/.xulux/skills 与应用数据 skills/）
 * + 生态兼容层（.agents/skills，只读发现）+ kv 里的启用开关；这里只做清单镜像
 * 与变更动作。所有变更命令的应答都是刷新后的清单，改后即见；活动会话的系统
 * 提示词热替换由 sidecar 完成，轮中经 loopContext 立即生效。
 */
export type SkillEntry = PiSkillEntry;
export type SkillScope = PiSkillScope;

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

let current: SkillsSnapshot = EMPTY;
const listeners = new Set<() => void>();

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

/** 拉取清单（sidecar 不可用则保持旧镜像并记录错误） */
export async function refreshSkills(cwd?: string | null): Promise<void> {
  current = { ...current, loading: true };
  emit();
  try {
    const res = await piRequest<PiSkillsResponse>({
      type: "list_skills",
      ...(cwd ? { cwd } : {}),
    });
    current = fromResponse(res);
    emit();
  } catch (err) {
    current = { ...current, loading: false, error: err instanceof Error ? err.message : String(err) };
    emit();
  }
}

/** 变更命令统一出口：应答即新清单 */
async function mutate(payload: Record<string, unknown>): Promise<void> {
  try {
    const res = await piRequest<PiSkillsResponse>(payload);
    current = fromResponse(res);
    emit();
  } catch (err) {
    current = { ...current, loading: false, error: err instanceof Error ? err.message : String(err) };
    emit();
    throw err;
  }
}

/**
 * 保存（新建/编辑）。raw 为 SKILL.md 原文模式（导入路径，frontmatter 以 sidecar
 * 解析为准，fallbackName 用文件名 stem 兜底）；name 传编辑前的原名（改名时 sidecar 清旧文件）。
 */
export function saveSkill(args: {
  scope: "system" | "workspace";
  cwd?: string | null;
  name?: string;
  draft?: SkillDraft;
  raw?: string;
  fallbackName?: string;
}): Promise<void> {
  return mutate({
    type: "save_skill",
    scope: args.scope,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.name ? { name: args.name } : {}),
    ...(args.fallbackName ? { fallbackName: args.fallbackName } : {}),
    ...(args.raw !== undefined ? { raw: args.raw } : { definition: args.draft }),
  });
}

export function deleteSkill(
  scope: "system" | "workspace",
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

/** 订阅清单快照；cwd 变化时自动重取（工作区层随所选工作区呈现） */
export function useSkills(cwd: string | null): SkillsSnapshot {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
  const lastCwd = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastCwd.current === cwd) return;
    lastCwd.current = cwd;
    void refreshSkills(cwd);
  }, [cwd]);
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
