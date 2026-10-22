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

export function trustedProjectRoots(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string" || !value.trim()) return;
    let real: string;
    try {
      if (!statSync(value).isDirectory()) return; // 文件不能当根
      real = realpathSync(value);
    } catch {
      return; // 缺失/不可访问：不授权
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(real);
  };

  for (const [main, dirs] of Object.entries(parsed as Record<string, unknown>)) {
    add(main);
    if (Array.isArray(dirs)) {
      for (const dir of dirs) add((dir as { path?: unknown } | null)?.path);
    }
    if (out.length >= MAX_TRUSTED_ROOTS) break;
  }
  return out.slice(0, MAX_TRUSTED_ROOTS);
}
