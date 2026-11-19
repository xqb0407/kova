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
  useWorkspace,
  useWorkspaceProjectId,
} from "@/lib/workspace/workspace-store";
import { setProjectDisplayName } from "@/lib/projects/project-display-name";
import { setProjectAppearance } from "@/lib/projects/project-appearance";
import {
  normalizeProjectAppearance,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";
import { listCachedProjectCwds } from "@/lib/projects/project-display-name";

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
  /** 侧栏已移除（仅隐藏项目卡；设置页可恢复显示） */
  hiddenFromSidebar: boolean;
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
  hiddenFromSidebar?: boolean;
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
  // 项目（重新）占据的目录不再算残留：清掉删除标记
  forgetPurgedFolders(project.folders.map((folder) => folder.path));
  notifyRegistry();
  return project;
}

/** 连会话数据一起删可能涉及大量转录/产物：默认 30s 预算不够时用长超时，
 *  避免客户端先超时而服务端还在删（表现为“报错但实际删了一半”）。 */
const DELETE_WITH_DATA_TIMEOUT_MS = 5 * 60_000;

/** 删除项目：默认归档（可恢复）；permanent=true 彻底删除实体。
 *  deleteData=true 时项目名下会话（转录/产物/检查点/索引）一并删除。 */
export async function deleteProject(
  projectId: string,
  options: { permanent?: boolean; hide?: boolean; deleteData?: boolean } = {},
): Promise<void> {
  const permanent = options.permanent === true;
  const hide = options.hide === true && !permanent;
  const target = registryProjects.find((project) => project.id === projectId);
  await piRequest(
    {
      type: "delete_project",
      projectId,
      ...(permanent ? { permanent: true } : {}),
      ...(hide ? { hide: true } : {}),
      ...(options.deleteData ? { deleteData: true } : {}),
    },
    options.deleteData ? DELETE_WITH_DATA_TIMEOUT_MS : undefined,
  );
  if (permanent) {
    // 彻底删除要连同 localStorage 名称/外观缓存一起清掉：幂等迁移只补
    // DB 缺失字段，如果缓存还在，下次启动会把这个目录“复活”成隐藏项目。
    // 共享目录还有别的项目在用时不清理：那份缓存也是对方 cwd 分组的显示名来源。
    const stillShared = (path: string) =>
      registryProjects.some(
        (project) =>
          project.id !== projectId &&
          project.folders.some((folder) =>
            sameProjectPath(folder.path, path),
          ),
      );
    for (const folder of target?.folders ?? []) {
      if (stillShared(folder.path)) continue;
      setProjectDisplayName(folder.path, null);
      setProjectAppearance(folder.path, null);
    }
    // 残留目录标记：不解绑保留的会话不再降级成同名 cwd 分组
    //（与「从侧栏移除」同语义，会话仍可在搜索里找到）
    const orphanFolders = (target?.folders ?? [])
      .map((folder) => folder.path)
      .filter(
        (path) =>
          !registryProjects.some(
            (project) =>
              project.id !== projectId &&
              project.folders.some((folder) =>
                sameProjectPath(folder.path, path),
              ),
          ),
      );
    rememberPurgedFolders(orphanFolders);
    registryProjects = registryProjects.filter((p) => p.id !== projectId);
  } else if (hide) {
    // 仅隐藏：实体与会话归属都保留，设置页「已移除」可恢复
    registryProjects = registryProjects.map((p) =>
      p.id === projectId ? { ...p, hiddenFromSidebar: true } : p,
    );
  } else {
    registryProjects = registryProjects.map((p) =>
      p.id === projectId ? { ...p, archived: true } : p,
    );
  }
  notifyRegistry();
}

/** 从侧栏和项目选择器移除（不归档、保留项目实体，可在设置页恢复） */
export async function removeProject(
  projectId: string,
  options: { deleteData?: boolean } = {},
): Promise<void> {
  await deleteProject(projectId, {
    hide: true,
    ...(options.deleteData ? { deleteData: true } : {}),
  });
}

/** 从归档恢复项目（sidecar 同时恢复项目内归档会话） */
export async function restoreProject(
  projectId: string,
): Promise<ProjectRecord> {
  const res = asProjectResponse(
    await piRequest({ type: "restore_project", projectId }),
  );
  const project = res.project!;
  registryProjects = registryProjects.map((p) =>
    p.id === project.id ? project : p,
  );
  forgetPurgedFolders(project.folders.map((folder) => folder.path));
  notifyRegistry();
  return project;
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
  projects: readonly ProjectRecord[],
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

/* ---------------------- 已彻底删除项目的残留目录标记 ----------------------
 * 彻底删除（不删数据）时项目内会话保留但解除归属：它们会按 cwd 降级成
 * 侧栏文件夹分组，看起来就像“项目还在”。与「从侧栏移除」同语义——
 * 删除后侧栏不再出现，会话只在搜索里可见。这里记录被删项目的目录，
 * 供侧栏分组跳过；共享目录若仍被其他项目使用则不标记。 */

const PURGED_FOLDERS_KEY = "project-purged-folders.v1";
const purgedFolders = new Set<string>();
let purgedFoldersVersion = 0;

function normalizeFolderKey(path: string): string {
  return path.trim().replace(/[\\/]+$/u, "");
}

function persistPurgedFolders(): void {
  try {
    localStorage.setItem(
      PURGED_FOLDERS_KEY,
      JSON.stringify([...purgedFolders]),
    );
  } catch {
    /* 配额/隐私模式：内存标记仍生效（本次会话内） */
  }
}

function loadPurgedFolders(): void {
  try {
    const raw = localStorage.getItem(PURGED_FOLDERS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const path of parsed) {
        if (typeof path === "string")
          purgedFolders.add(normalizeFolderKey(path));
      }
    }
  } catch {
    /* 坏数据：忽略 */
  }
}

export function isPurgedFolderCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  return purgedFolders.has(normalizeFolderKey(cwd));
}

function rememberPurgedFolders(paths: readonly string[]): void {
  let changed = false;
  for (const path of paths) {
    const key = normalizeFolderKey(path);
    if (key && !purgedFolders.has(key)) {
      purgedFolders.add(key);
      changed = true;
    }
  }
  if (changed) {
    persistPurgedFolders();
    purgedFoldersVersion += 1;
    notifyRegistry();
  }
}

// client bundle 加载即恢复（SSR 端无 localStorage，跳过）
if (typeof window !== "undefined") loadPurgedFolders();

function forgetPurgedFolders(paths: readonly string[]): void {
  let changed = false;
  for (const path of paths) {
    const key = normalizeFolderKey(path);
    if (key && purgedFolders.delete(key)) changed = true;
  }
  if (changed) {
    persistPurgedFolders();
    purgedFoldersVersion += 1;
    notifyRegistry();
  }
}

/** 订阅残留目录标记版本号：侧栏分组据此重算 */
export function usePurgedFoldersVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    },
    () => purgedFoldersVersion,
    () => 0,
  );
}

/** 拉取项目列表并更新注册表缓存 */
export async function refreshRegistry(): Promise<ProjectRecord[]> {
  const projects = await fetchProjects(true);
  registryProjects = projects;
  registryLoaded = true;
  // 自愈旧数据：项目已被彻底删除（标记缺失的旧删除）但 localStorage 名称/
  // 外观缓存还在的目录 → 记为残留目录，侧栏不再降级成同名分组。仍有项目
  // 占用的目录不标记。
  const orphanCached = listCachedProjectCwds().filter(
    (cwd) => !projects.some((project) => projectHasPath(project, cwd)),
  );
  rememberPurgedFolders(orphanCached);
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

/**
 * 工作空间级设置（MCP/Subagent/Skill/命令/插件/市场安装）使用的目录：
 * 当前会话属于项目时返回项目主目录，否则回退当前 workspace。
 * 与 sidecar 的 configCwdFor 同口径，避免“界面显示附加目录、实际写主目录”。
 */
export function useProjectWorkspaceDir(): string | null {
  const workspace = useWorkspace();
  const projectId = useWorkspaceProjectId();
  const projects = useProjectRegistry();
  const project = projectId
    ? projects.find((candidate) => candidate.id === projectId)
    : undefined;
  return (project ? projectPrimaryPath(project) : "") || workspace;
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
