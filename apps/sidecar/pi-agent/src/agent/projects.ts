/**
 * 项目实体（项目 id + folders）的服务层。
 *
 * 事实源：Host SQLite 的 projects/project_folders 表（通过 hostdb 的 project_*
 * 查询读写）。会话归属由 sessions.project_id 决定，不再按 cwd 猜；同一文件夹
 * 可被多个项目引用（共享目录）。
 *
 * 兼容：旧上下文没有 project_id 时会话仍走 cwd 推导；项目表不可用（旧宿主/
 * 迁移失败）时回退旧 pi.projectDirs 路径 map，保证可启动。
 */
import { realpathSync } from "node:fs";
import type { HostProject, SaveHostProjectInput } from "../storage/hostdb";
import {
  kvGet,
  projectDelete as hostProjectDelete,
  projectList as hostProjectList,
  projectSave as hostProjectSave,
} from "../storage/hostdb";
import {
  externalDirExists,
  externalDirLabel,
  externalDirsOverlap,
  resolveExternalPath,
  validateExternalDir,
  MAX_EXTERNAL_DIRS,
} from "./external-dirs";
import {
  allProjectDirs as legacyAllProjectDirs,
  effectiveProjectDirs as legacyEffectiveProjectDirs,
  initProjectDirs,
  projectCwdFor as legacyProjectCwdFor,
  projectRootsFor as legacyProjectRootsFor,
} from "./project-dirs";
import { logErr } from "../log";
import type { ExternalDir } from "pi-protocol";

export type Project = HostProject;

let projects = new Map<string, Project>();
let initialized = false;
let registryAvailable = false;
let load: Promise<void> | undefined;

function pathKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function samePath(a: string, b: string): boolean {
  if (pathKey(a) === pathKey(b)) return true;
  try {
    return pathKey(realpathSync(a)) === pathKey(realpathSync(b));
  } catch {
    return false;
  }
}

function folderPaths(project: Project): string[] {
  return project.folders.map((folder) => folder.path);
}

export function projectLabel(project: Project | null | undefined): string {
  if (!project) return "";
  const custom = project.displayName?.trim();
  if (custom) return custom;
  const primary = project.folders.find((folder) => folder.isPrimary);
  const path = primary?.path ?? project.folders[0]?.path ?? "";
  return path ? externalDirLabel(path) : "项目";
}

export function primaryFolder(project: Project | null | undefined): string {
  if (!project) return "";
  return (
    project.folders.find((folder) => folder.isPrimary)?.path ??
    project.folders[0]?.path ??
    ""
  );
}

export function projectFolderDirs(
  project: Project | null | undefined,
): ExternalDir[] {
  if (!project) return [];
  // 主目录永远排第一：旧协议/弹层把 roots[0] 当主目录（且协议不携带
  // isPrimary）；projectSave 允许 primary 不在 folders[0]，不能靠下标假设。
  const ordered = [...project.folders].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
  );
  return ordered.map((folder) => ({
    path: folder.path,
    label: externalDirLabel(folder.path),
  }));
}

export function projectById(projectId: string | null | undefined): Project | null {
  if (!projectId) return null;
  return projects.get(projectId) ?? null;
}

export function listProjects(includeArchived = false): Project[] {
  return [...projects.values()]
    .filter((project) => includeArchived || !project.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 启动闸门内调用：加载项目表。host 查询成功即用项目表（即使为空——
 *  新安装 legitimately 没有项目），不再回退旧路径 map（那会导致新项目查不到）。
 *  只有 host 查询本身失败（旧宿主/表不存在）才回退。 */
export async function initProjects(): Promise<void> {
  load ??= (async () => {
    try {
      const result = await hostProjectList(true);
      projects = new Map(result.projects.map((project) => [project.id, project]));
      registryAvailable = true;
      initialized = true;
      return;
    } catch (err) {
      registryAvailable = false;
      initialized = true;
      logErr("projects: registry unavailable, fallback to pi.projectDirs:", err);
    }
    await initProjectDirs();
  })();
  await load;
}

export function isProjectRegistryAvailable(): boolean {
  return registryAvailable;
}

function applyProject(project: Project): Project {
  projects.set(project.id, project);
  initialized = true;
  return project;
}

export type SaveProjectInput = {
  id?: string;
  name?: string | null;
  nameIsCustom?: boolean;
  appearanceJson?: string | null;
  /** 不传时保留已有 folders */
  folders?: string[];
  primaryPath?: string;
  archived?: boolean;
  showWhenEmpty?: boolean;
};

/**
 * 创建/更新项目：服务层做目录准入（存在/目录/控制字符/项目内嵌套/上限），
 * 共享目录允许（不再查其他项目占用）。
 */
export async function saveProject(input: SaveProjectInput): Promise<Project> {
  const existing = input.id ? projectById(input.id) : null;
  // folders 空数组/未传 = 保留已有（名称编辑等场景只改名称不动目录）
  const foldersProvided = Boolean(input.folders && input.folders.length > 0);
  const folders = (
    foldersProvided
      ? input.folders!
      : existing
        ? folderPaths(existing)
        : []
  )
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path, index, list) => list.indexOf(path) === index);
  if (folders.length === 0) {
    throw new Error("Project must have at least one folder.");
  }
  const primaryInput = input.primaryPath?.trim() || folders[0]!;
  const primary =
    folders.find((path) => samePath(path, primaryInput)) ?? folders[0]!;
  let validated: { path: string; isPrimary: boolean }[];
  if (existing && !foldersProvided) {
    // 只改名称/外观：目录原样保留，不因外接盘/网络盘暂时缺失而阻断编辑。
    // 目录是否可用由读取方按 missing 提示处理（与弹层一致）。
    validated = folders.map((path) => ({
      path,
      isPrimary: samePath(path, primary),
    }));
    if (!validated.some((entry) => entry.isPrimary)) {
      validated[0]!.isPrimary = true;
    }
  } else {
    if (!externalDirExists(primary)) {
      throw new Error(`Project folder does not exist: ${primary}`);
    }
    if (/\p{C}/u.test(primary)) {
      throw new Error("Project folder must not contain control characters.");
    }
    validated = [
      { path: resolveExternalPath(primary, primary), isPrimary: true },
    ];
    for (const folder of folders) {
      if (samePath(folder, primary)) continue;
      const validation = validateExternalDir(folder, {
        cwd: primary,
        existing: validated.map((entry) => ({
          path: entry.path,
          label: externalDirLabel(entry.path),
        })),
        maxDirs: MAX_EXTERNAL_DIRS,
      });
      if (!validation.ok) throw new Error(validation.message);
      validated.push({ path: validation.absolutePath, isPrimary: false });
    }
  }
  const nameProvided = input.name !== undefined;
  const name = nameProvided ? (input.name?.trim() || null) : undefined;
  // 显示名唯一（含“回落主文件夹 basename”的项目）：侧栏/胶囊/移动目标里
  // 同名项目无法区分。只在本次显式改名称或新建时校验，避免历史重名项目的
  // “只换图标”等编辑被永久卡住。共享同一目录的多个项目仍然允许，只要名字不同。
  if (nameProvided || !existing) {
    const effectiveName = (name ?? externalDirLabel(primary)).trim();
    const key = effectiveName.toLocaleLowerCase();
    const duplicate = listProjects(false).find(
      (project) =>
        project.id !== existing?.id &&
        projectLabel(project).trim().toLocaleLowerCase() === key,
    );
    if (duplicate) {
      throw new Error(`Project name already exists: ${effectiveName}`);
    }
  }
  const hostInput: SaveHostProjectInput = {
    id: input.id,
    displayName: name,
    nameIsCustom:
      input.nameIsCustom ?? (nameProvided ? Boolean(name) : undefined),
    appearanceJson: input.appearanceJson,
    archived: input.archived,
    showWhenEmpty: input.showWhenEmpty ?? existing?.showWhenEmpty ?? true,
    folders: validated,
    primaryPath: (validated.find((entry) => entry.isPrimary) ?? validated[0]!)
      .path,
  };
  const result = await hostProjectSave(hostInput);
  return applyProject(result.project);
}

export async function deleteProject(projectId: string): Promise<void> {
  await hostProjectDelete(projectId);
  const existing = projects.get(projectId);
  if (existing) applyProject({ ...existing, archived: true });
}

/** 含该 cwd 的**未归档**项目（精确 folder 匹配；共享目录可能多个）。
 *  归档项目不再参与 cwd 回退推导——否则移除最后一个目录后，
 *  `effectiveProjectDirs(cwd)` 仍会命中归档项目的旧 folders。 */
export function projectsContaining(cwd: string): Project[] {
  if (!cwd.trim()) return [];
  return listProjects(false).filter((project) =>
    folderPaths(project).some((path) => samePath(path, cwd)),
  );
}

/** 项目 folders 是否包含该路径（旧命令 shim/移动会话用） */
export function projectHasFolder(
  project: Project | null | undefined,
  path: string,
): boolean {
  if (!project) return false;
  return folderPaths(project).some((folder) => samePath(folder, path));
}

/** 只有一个**未归档**项目包含该 cwd 时返回它；共享/无归属返回 null（不猜）。
 *  归档项目不再接收新会话，但仍参与旧会话的 cwd 展示分组（projectsContaining）。 */
export function uniqueProjectForCwd(cwd: string): Project | null {
  const matches = projectsContaining(cwd).filter((project) => !project.archived);
  return matches.length === 1 ? matches[0]! : null;
}

export function projectIdForCwd(cwd: string): string | undefined {
  return uniqueProjectForCwd(cwd)?.id;
}

/** 旧协议/旧会话回退：cwd 唯一归属项目的 primary；共享目录取第一个命中 */
export function projectCwdFor(cwd: string): string | undefined {
  if (!registryAvailable) return legacyProjectCwdFor(cwd);
  const project = projectsContaining(cwd)[0];
  return project ? primaryFolder(project) : undefined;
}

export const canonicalProjectCwd = projectCwdFor;

/** 旧协议 `get_project_dirs` 的回退形状；共享目录取第一个命中的项目 */
export function projectRootsForCwd(
  cwd: string,
): { main: string; roots: ExternalDir[] } | null {
  if (!registryAvailable) return legacyProjectRootsFor(cwd);
  const project = projectsContaining(cwd)[0];
  if (!project) return null;
  return { main: primaryFolder(project), roots: projectFolderDirs(project) };
}

/** 会话的生效附加目录：项目 folders 去掉会话 cwd；共享目录取第一个命中 */
export function effectiveProjectDirs(cwd: string): ExternalDir[] {
  if (!registryAvailable) return legacyEffectiveProjectDirs(cwd);
  const project = projectsContaining(cwd)[0];
  if (!project) return [];
  return projectFolderDirs(project).filter(
    (dir) => !samePath(dir.path, cwd),
  );
}

/** 已知项目 id 的生效附加目录（新会话/驻留 run 优先走这里） */
export function effectiveDirsForProject(
  projectId: string | null | undefined,
  cwd: string,
): ExternalDir[] {
  const project = projectById(projectId);
  if (!project) return effectiveProjectDirs(cwd);
  return projectFolderDirs(project).filter((dir) => !samePath(dir.path, cwd));
}

/** 会话创建/恢复时确定 projectId：显式 id 优先；否则只接受唯一 cwd 归属 */
export function resolveProjectIdForCwd(
  projectId: string | undefined,
  cwd: string,
): string | undefined {
  if (projectId) {
    const project = projectById(projectId);
    if (!project) throw new Error(`project not found: ${projectId}`);
    if (cwd && !folderPaths(project).some((path) => samePath(path, cwd))) {
      throw new Error("Session cwd is not one of the project folders.");
    }
    return project.id;
  }
  return projectIdForCwd(cwd);
}

/** 旧协议 `get_project_dirs` 的全量 projects 列表 */
export function allProjectDirs(): { main: string; roots: ExternalDir[] }[] {
  if (!registryAvailable) return legacyAllProjectDirs();
  return listProjects(true).map((project) => ({
    main: primaryFolder(project),
    roots: projectFolderDirs(project),
  }));
}

/** 测试缝 */
export function resetProjectsForTest(): void {
  projects = new Map();
  initialized = false;
  registryAvailable = false;
  load = undefined;
}

export function seedProjectsForTest(list: Project[]): void {
  projects = new Map(list.map((project) => [project.id, project]));
  initialized = true;
  registryAvailable = true;
  load = Promise.resolve();
}

export function projectsReady(): boolean {
  return initialized;
}

export function projectFoldersOverlap(project: Project, candidate: string): boolean {
  return folderPaths(project).some((path) =>
    externalDirsOverlap(resolveExternalPath(path, path), candidate),
  );
}
