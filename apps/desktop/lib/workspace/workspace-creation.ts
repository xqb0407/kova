/**
 * 「新建工作区」表单的纯逻辑：路径规范化、去重、数量上限与主/附加拆分。
 *
 * 语义与 sidecar 的项目虚拟目录对齐：
 * - 第一个文件夹 = 主目录（会话 cwd / 项目分组 key）
 * - 其余文件夹 = 附加根（`add_project_dir`，每项目最多 MAX_EXTERNAL_DIRS 个）
 *
 * 这里只做前端可判定的部分；存在性、嵌套、跨项目占用仍由 sidecar 校验。
 */
import { pathBasename } from "./path";

/** 与 sidecar `MAX_EXTERNAL_DIRS` 保持一致：1 个主目录 + 8 个附加根 */
export const WORKSPACE_MAX_ADDITIONAL = 8;
export const WORKSPACE_MAX_FOLDERS = 1 + WORKSPACE_MAX_ADDITIONAL;

/**
 * 规范化用户选中的目录：去首尾空白、去尾部重复分隔符。
 * 根目录（"/"、"C:\"）保留分隔符，避免被削成空串/盘符。
 */
export function normalizeFolderPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z]:[\\/]+$/u.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  if (/^[\\/]+$/u.test(trimmed)) return trimmed[0]!;
  return trimmed.replace(/[\\/]+$/u, "");
}

function samePath(a: string, b: string): boolean {
  return normalizeFolderPath(a) === normalizeFolderPath(b);
}

/** 目录是否已在列表中（按规范化路径比较） */
export function hasWorkspaceFolder(
  folders: readonly string[],
  candidate: string,
): boolean {
  return folders.some((folder) => samePath(folder, candidate));
}

/**
 * 追加一个文件夹：空路径忽略、重复忽略、达到上限忽略。
 * 返回新数组（React 状态更新用），调用方可比较长度判断是否真的加入。
 */
export function appendWorkspaceFolder(
  folders: readonly string[],
  candidate: string,
): string[] {
  const normalized = normalizeFolderPath(candidate);
  if (!normalized) return [...folders];
  if (folders.length >= WORKSPACE_MAX_FOLDERS) return [...folders];
  if (hasWorkspaceFolder(folders, normalized)) return [...folders];
  return [...folders, normalized];
}

/** 拆分主目录与附加根（顺带去重/去空，首项即主目录） */
export function splitWorkspaceFolders(folders: readonly string[]): {
  main: string | null;
  additional: string[];
} {
  const unique: string[] = [];
  for (const folder of folders) {
    const normalized = normalizeFolderPath(folder);
    if (!normalized) continue;
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  const [main, ...additional] = unique;
  return { main: main ?? null, additional };
}

/** 显示名：目录最后一段（根目录回退完整路径） */
export function workspaceFolderName(path: string): string {
  const normalized = normalizeFolderPath(path);
  return normalized ? pathBasename(normalized) : "";
}
