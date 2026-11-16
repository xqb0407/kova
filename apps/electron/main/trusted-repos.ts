/**
 * 受信 git 仓库根收集（git.ts / worktrees.ts 共用）：kv workspace + 项目
 * folders 表（旧库回退 kv "pi.projectDirs"）。只收集，不做存在性保证——
 * 调用方按需 realpath / 过滤。
 *
 * store 惰性 require（store → data → electron 顶层导入会在 bun test 炸），
 * 与 task-workspace-root / worktrees.ts 的惰性纪律一致。
 */
import { trustedProjectRoots, trustedProjectRootsFromPaths } from "./project-roots";

interface StoreLike {
  kvGet(key: string): string | null;
  getDb(): {
    prepare(sql: string): { all(...args: unknown[]): unknown };
  };
}

function store(): StoreLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("./store") as StoreLike) ?? null;
  } catch {
    // bun test / 无 electron 状态：store 载入失败 → 无受信根
    return null;
  }
}

export function trustedGitRepoRoots(): string[] {
  const s = store();
  if (!s) return [];
  try {
    const rows = s
      .getDb()
      .prepare("SELECT path FROM project_folders")
      .all() as { path: unknown }[];
    if (rows.length > 0) {
      return trustedProjectRootsFromPaths(rows.map((row) => row.path));
    }
  } catch {
    /* 旧库/迁移前：回退 kv */
  }
  return trustedProjectRoots(s.kvGet("pi.projectDirs"));
}
