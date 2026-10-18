/**
 * 资料库（侧边栏「资料库」页）的根目录事实源。
 *
 * 缺省 `<appData>/library`——与 task-workspace 同级：私有、随应用数据一起走
 * （备份的「包含资料库」开关收的就是它）；用户可在设置 → 通用 → 资料库位置
 * 改到任意文件夹（kv "library.root"）。
 *
 * 这里同时是 fs_* 命令第三个可信根的来源（见 fs-cmds.ts resolveRoot）：
 * **只放行配置根子树**，绝不把 appDataDir 整棵当可信根——否则 sessions/、
 * state.db、密钥文件都会落进 fs_* 写命令的射程。setLibraryRoot 的四条拒绝
 * 规则（非绝对路径 / 盘根与文件系统根 / 家目录本体 / appDataDir 及其祖先或
 * 内部非缺省目录）就是这条边界。
 */
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appDataDir } from "./paths";
import { kvGet, kvSet } from "./store";

export const LIBRARY_DIR = "library";
export const LIBRARY_ROOT_KEY = "library.root";

/** 缺省资料库根：<appData>/library */
export function defaultLibraryRoot(): string {
  return join(appDataDir(), LIBRARY_DIR);
}

/** 当前资料库根（配置优先，缺省 <appData>/library）；不做存在性检查。
 *  db 尚未就绪（kvGet 抛错）时回退缺省值，不让整个 fs_* 通道跟着挂掉。 */
export function libraryRoot(): string {
  try {
    const raw = kvGet(LIBRARY_ROOT_KEY);
    const p = typeof raw === "string" ? raw.trim() : "";
    if (p.length > 0) return p;
  } catch {
    /* store 未初始化：按缺省值走 */
  }
  return defaultLibraryRoot();
}

export function isDefaultLibraryRoot(root: string = libraryRoot()): boolean {
  return resolve(root) === resolve(defaultLibraryRoot());
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** a 是 b 的祖先或本身（canonical 优先，比较前各自归一） */
function isAncestorOrSame(a: string, b: string): boolean {
  const ra = tryRealpath(a) ?? resolve(a);
  const rb = tryRealpath(b) ?? resolve(b);
  return (
    rb === ra ||
    rb.startsWith(ra + "/") ||
    (process.platform === "win32" && rb.startsWith(ra + "\\"))
  );
}

/**
 * 校验候选资料库根：通过返回 null，拒绝返回错误短码（对齐 fs.rs 风格）。
 * 拒绝：非绝对路径 / 文件系统根与盘根 / 家目录本体 / appDataDir 及其祖先 /
 * appDataDir 内部非缺省 library 的目录（均为把私密数据目录交进可信根的口子）。
 */
export function validateLibraryRoot(dir: string): string | null {
  const raw = dir.trim().replace(/[\\/]+$/, "");
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) return "bad-path";
  if (raw === "/" || /^[a-zA-Z]:$/.test(raw)) return "bad-path";
  if (resolve(raw) === resolve(homedir())) return "home-not-allowed";
  if (isAncestorOrSame(raw, appDataDir())) return "app-data-not-allowed";
  if (isAncestorOrSame(appDataDir(), raw) && !isDefaultLibraryRoot(raw)) {
    return "app-data-not-allowed";
  }
  return null;
}

/** 设置资料库根：校验 → 建目录（mkdir -p）→ 持久化 */
export function setLibraryRoot(dir: string): string {
  const code = validateLibraryRoot(dir);
  if (code) throw new Error(code);
  const root = dir.trim().replace(/[\\/]+$/, "");
  mkdirSync(root, { recursive: true });
  kvSet(LIBRARY_ROOT_KEY, root);
  return root;
}

/** 启动时确保资料库根存在；建不出来（只读盘/权限）只留空目录态给页面呈现 */
export function ensureLibraryRoot(): string {
  const root = libraryRoot();
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* 页面侧以「读取失败 + 更改位置」呈现 */
  }
  return root;
}