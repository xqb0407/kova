/**
 * ACP 模式识别与数据目录解析。
 *
 * 触发方式：
 *   kova-worker --acp
 *   KOVA_ACP=1 kova-worker
 *
 * 数据目录（优先级从高到低）：
 *   --data-dir <path> / --data-dir=<path>
 *   KOVA_ACP_DATA_DIR
 *   KOVA_DATA_DIR
 *   ~/.kova/acp
 *
 * ACP 模式没有 Electron 宿主，业务表必须走本地 SQLite；即使调用方设置了
 * PI_SESSIONS_DIR（宿主模式标志），这里也只把它当作本地会话目录。
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logErr } from "../log";

export type AcpPaths = {
  dataDir: string;
  dbPath: string;
  sessionsDir: string;
  taskCwd: string;
  libraryRoot: string;
};

/** initialize 响应里的 agentInfo（协议当前可选，未来会强制）：版本需与
 *  apps/electron/package.json 的 version 手工同步——sidecar 是独立编译产物，
 *  构建图里拿不到宿主的 package.json。 */
export const ACP_AGENT_INFO = { name: "kova-worker", version: "1.1.24-preview" } as const;

/** session/list 单页条数：编辑器侧一次拉全量会把几千条会话摘要拖过 JSON-RPC */
export const ACP_LIST_PAGE_SIZE = 100;

export function isAcpMode(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes("--acp") || env.KOVA_ACP === "1" || env.KOVA_ACP === "true";
}

/** 取 `--data-dir <path>` / `--data-dir=<path>`；缺省 undefined */
export function dataDirArg(argv: readonly string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
      return undefined;
    }
    if (arg.startsWith("--data-dir=")) {
      const value = arg.slice("--data-dir=".length);
      return value || undefined;
    }
  }
  return undefined;
}

export function resolveAcpPaths(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): AcpPaths {
  const override = (dataDirArg(argv) ?? env.KOVA_ACP_DATA_DIR ?? env.KOVA_DATA_DIR)?.trim();
  const dataDir = resolve(override ? override : join(homedir(), ".kova", "acp"));

  const dbPath = resolve(env.PI_DB_PATH?.trim() || join(dataDir, "state.db"));
  const sessionsDir = resolve(env.PI_SESSIONS_DIR?.trim() || join(dataDir, "sessions"));
  const taskCwd = resolve(env.PI_TASK_CWD?.trim() || join(dataDir, "task-workspace"));
  const libraryRoot = resolve(env.PI_LIBRARY_ROOT?.trim() || join(dataDir, "library"));

  return { dataDir, dbPath, sessionsDir, taskCwd, libraryRoot };
}

/** 建目录（0700）：目录里可能有会话正文/本地明文凭据，不向同机其他用户开放 */
export function ensureAcpPaths(paths: AcpPaths): void {
  for (const dir of [paths.dataDir, paths.sessionsDir, paths.taskCwd, paths.libraryRoot]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mode 只对新建目录生效；已存在的目录（旧版本/手工创建）也收紧一次。
    // Windows 上 chmod 语义有限，失败只记日志，不阻断启动。
    try {
      chmodSync(dir, 0o700);
    } catch (err) {
      logErr(`[acp] chmod 0700 failed for ${dir}:`, err);
    }
  }
}

/** 把 ACP 路径写进 env：后续模块（taskWorkspaceRoot / libraryRoot）直接读取 */
export function applyAcpPaths(paths: AcpPaths, env: NodeJS.ProcessEnv = process.env): void {
  // 空串也视为未设置（resolveAcpPaths 已按 trim 处理，这里保持同一口径）
  if (!env.PI_TASK_CWD?.trim()) env.PI_TASK_CWD = paths.taskCwd;
  if (!env.PI_LIBRARY_ROOT?.trim()) env.PI_LIBRARY_ROOT = paths.libraryRoot;
}
