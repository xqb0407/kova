/**
 * 项目虚拟目录的可信根（主进程 fs_* 命令用）。
 *
 * 配置在 sidecar kv `pi.projectDirs`：`{ [项目主目录]: [{path,label}] }`。
 * 主进程只读解析，不写；文件树切到某个附加根时，fs-cmds 的 resolveRoot
 * 必须把这些根认作可信根，否则切换后只能拿到空目录。
 *
 * 安全口径：
 * - 只认**当前存在**的目录（realpath 成功）——缺失/无权限的根不授权；
 * - 主目录与附加根都算，数量封顶（防畸形配置把每次 fs 调用拖成线性扫描）；
 * - 不做子树放行：文件树的 cwd 恒为某个根，越深路径通过相对段拼接。
 */
import { realpathSync, statSync } from "node:fs";

const MAX_TRUSTED_ROOTS = 64;

/** 从一组候选文件夹解析可信根（项目实体表的 path 列直接走这里） */
export function trustedProjectRootsFromPaths(
  paths: Iterable<unknown>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    if (out.length >= MAX_TRUSTED_ROOTS) break;
    if (typeof value !== "string" || !value.trim()) continue;
    let real: string;
    try {
      if (!statSync(value).isDirectory()) continue; // 文件不能当根
      real = realpathSync(value);
    } catch {
      continue; // 缺失/不可访问：不授权
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(real);
  }
  return out;
}

/** git 命令的 cwd 守卫：当前 workspace 精确匹配，或命中项目 folders 根。
 *  项目根已由上面的解析器做过存在性 + realpath 校验。 */
export function isTrustedGitCwd(
  realCwd: string,
  workspaceReal: string,
  projectRoots: readonly string[],
): boolean {
  return realCwd === workspaceReal || projectRoots.includes(realCwd);
}

export function trustedProjectRoots(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const paths: string[] = [];
  for (const [main, dirs] of Object.entries(parsed as Record<string, unknown>)) {
    paths.push(main);
    if (Array.isArray(dirs)) {
      for (const dir of dirs) {
        const path = (dir as { path?: unknown } | null)?.path;
        if (typeof path === "string") paths.push(path);
      }
    }
  }
  return trustedProjectRootsFromPaths(paths);
}
