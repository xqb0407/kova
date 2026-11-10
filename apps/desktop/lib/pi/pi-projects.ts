/**
 * 项目实体（项目 id + folders）的前端 API + 响应式注册表。
 *
 * 事实源在 sidecar（Host SQLite projects/project_folders）。注册表用
 * useSyncExternalStore 模式（同 project-appearance）：模块级 Map + 版本号，
 * 侧栏/胶囊/项目卡同步读取。变更后 refreshRegistry 重拉并广播。
 */
import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import { isMacPlatform, isWindowsPlatform } from "@/lib/desktop-env";
import {
  normalizeProjectAppearance,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";

export type ProjectFolder = {
  path: string;
  sortOrder: number;
  isPrimary: boolean;
};

export type ProjectRecord = {
  id: string;
  displayName: string | null;
  nameIsCustom: boolean;
  appearanceJson: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  showWhenEmpty: boolean;
  folders: ProjectFolder[];
};

export type SaveProjectInput = {
  id?: string;
  name?: string | null;
  nameIsCustom?: boolean;
  appearanceJson?: string | null;
  /** 不传时 sidecar 保留已有 folders */
  folders?: string[];
  primaryPath?: string;
  archived?: boolean;
  showWhenEmpty?: boolean;
};

type ProjectResponse = {
  sessionId?: string;
  type: string;
  projects?: ProjectRecord[];
  project?: ProjectRecord;
  projectId?: string;
};

function asProjectResponse(data: unknown): ProjectResponse {
  return data as ProjectResponse;
}

/** 项目列表（含 folders）；默认不含归档项目 */
export async function fetchProjects(
  includeArchived = false,
): Promise<ProjectRecord[]> {
  const res = asProjectResponse(
    await piRequest({ type: "list_projects", includeArchived }),
  );
  return res.projects ?? [];
}

/** 创建/更新项目（名称/folders/primary/外观）；保存后刷新注册表 */
export async function saveProject(
  input: SaveProjectInput,
): Promise<ProjectRecord> {
  const res = asProjectResponse(
    await piRequest({ type: "save_project", project: input }),
  );
  const project = res.project!;
  // 更新注册表缓存：始终换新数组，保证 useSyncExternalStore 的快照引用变化
  const idx = registryProjects.findIndex((p) => p.id === project.id);
  registryProjects =
    idx >= 0
      ? registryProjects.map((p, i) => (i === idx ? project : p))
      : [...registryProjects, project];
  notifyRegistry();
  return project;
}

/** 归档项目（软删除；会话历史保留）；删除后刷新注册表 */
export async function deleteProject(projectId: string): Promise<void> {
  await piRequest({ type: "delete_project", projectId });
  const idx = registryProjects.findIndex((p) => p.id === projectId);
  if (idx >= 0) {
    registryProjects = registryProjects.map((p, i) =>
      i === idx ? { ...p, archived: true } : p,
    );
    notifyRegistry();
  }
}

/** 显式改会话的项目归属（项目移动/迁移用） */
export async function setSessionProject(
  sessionId: string,
  projectId: string | null,
): Promise<void> {
  await piRequest({ type: "set_session_project", sessionId, projectId });
}

/** 主文件夹路径；无 folders 回退空串 */
export function projectPrimaryPath(
  project: ProjectRecord | null | undefined,
): string {
  if (!project) return "";
  return (
    project.folders.find((folder) => folder.isPrimary)?.path ??
    project.folders[0]?.path ??
    ""
  );
}

/** 项目显示名：自定义名优先，回落主文件夹 basename；无 folders 回退 id */
export function projectDisplayName(
  project: ProjectRecord | null | undefined,
): string {
  if (!project) return "";
  const custom = project.displayName?.trim();
  if (custom) return custom;
  const primary = projectPrimaryPath(project);
  if (!primary) return project.id;
  const parts = primary.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? primary;
}

/** 侧栏项目卡片的稳定键：项目实体优先，旧 cwd 分组兜底。
 *  UI 折叠/分页状态用它，不能再用 cwd（共享 primary 的两个项目会串）。 */
export function projectGroupKey(
  projectId: string | null | undefined,
  cwd: string | null | undefined,
): string {
  return projectId ? `project:${projectId}` : `cwd:${cwd ?? ""}`;
}

/** 项目外观：DB 里的 appearance_json 解析（localStorage 缓存缺失时兜底） */
export function projectAppearanceOf(
  project: ProjectRecord | null | undefined,
): ProjectAppearance | null {
  if (!project?.appearanceJson) return null;
  try {
    return normalizeProjectAppearance(JSON.parse(project.appearanceJson));
  } catch {
    return null;
  }
}

/** 路径收口：去首尾空白与尾部重复分隔符（不做 I/O） */
function normalizeProjectPath(value: string): string {
  const trimmed = value.trim();
  const stripped = trimmed.replace(/[\\/]+$/u, "");
  return stripped || trimmed;
}

/**
 * 项目路径相等判断：Windows / macOS 默认不区分大小写（macOS 常见文件系统
 * 如此），Linux 保持大小写敏感。桌面端拿不到 realpath，先按平台折叠大小写。
 */
export function sameProjectPath(a: string, b: string): boolean {
  const left = normalizeProjectPath(a);
  const right = normalizeProjectPath(b);
  if (left === right) return true;
  return isMacPlatform() || isWindowsPlatform()
    ? left.toLowerCase() === right.toLowerCase()
    : false;
}

/** 判断某路径是否属于项目 folders（共享目录/会话归属判断用） */
export function projectHasPath(
  project: ProjectRecord | null | undefined,
  path: string,
): boolean {
  if (!project || !path.trim()) return false;
  return project.folders.some((folder) => sameProjectPath(folder.path, path));
}

/** 迁移用：把 cwd 映射到已有项目（primary/folder 精确匹配） */
export function findProjectByPath(
  projects: ProjectRecord[],
  cwd: string,
): ProjectRecord | null {
  return projects.find((project) => projectHasPath(project, cwd)) ?? null;
}

/* --------------------------- 项目注册表（响应式） --------------------------- */

let registryProjects: ProjectRecord[] = [];
let registryVersion = 0;
let registryLoaded = false;
const registryListeners = new Set<() => void>();

function notifyRegistry(): void {
  registryVersion += 1;
  for (const listener of registryListeners) listener();
}

/** 拉取项目列表并更新注册表缓存 */
export async function refreshRegistry(): Promise<ProjectRecord[]> {
  const projects = await fetchProjects(true);
  registryProjects = projects;
  registryLoaded = true;
  notifyRegistry();
  return projects;
}

/** 启动闸门内调用一次（幂等）；侧车未就绪时退避重试，最终仍失败则侧栏降级为 cwd 分组 */
let registryLoad: Promise<void> | undefined;

export function initProjectRegistry(attempt = 0): Promise<void> {
  if (registryLoaded) return Promise.resolve();
  registryLoad ??= refreshRegistry()
    .then(() => undefined)
    .catch(() => {
      // 失败允许下次挂载重试
      registryLoad = undefined;
      if (attempt < 5) {
        const delay = [500, 1_500, 4_000, 8_000, 15_000][attempt] ?? 15_000;
        setTimeout(() => {
          void initProjectRegistry(attempt + 1);
        }, delay);
      }
    });
  return registryLoad;
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function getRegistrySnapshot(): ProjectRecord[] {
  return registryProjects;
}

function getRegistryServerSnapshot(): ProjectRecord[] {
  return registryProjects;
}

/** React hook：同步读项目注册表（含空项目；不含归档） */
export function useProjectRegistry(): ProjectRecord[] {
  useSyncExternalStore(subscribeRegistry, getRegistrySnapshot, getRegistryServerSnapshot);
  return registryProjects;
}

/** 当前项目 id → 实体显示名；注册表未就绪/无此项目时返回 null（调用方回退） */
export function useProjectEntityLabel(
  projectId: string | null | undefined,
): string | null {
  const projects = useProjectRegistry();
  if (!projectId) return null;
  const project = projects.find((candidate) => candidate.id === projectId);
  return project ? projectDisplayName(project) : null;
}

/** 非 React 场景读注册表 */
export function getRegistryProjects(): ProjectRecord[] {
  return registryProjects;
}

export function isRegistryLoaded(): boolean {
  return registryLoaded;
}

/** 乐观更新注册表中的外观：本地编辑立即反映到侧栏，后端写入仍走防抖 */
export function patchRegistryAppearance(
  projectId: string,
  appearanceJson: string | null,
): void {
  const index = registryProjects.findIndex((project) => project.id === projectId);
  if (index < 0) return;
  registryProjects = registryProjects.map((project, at) =>
    at === index ? { ...project, appearanceJson } : project,
  );
  notifyRegistry();
}
