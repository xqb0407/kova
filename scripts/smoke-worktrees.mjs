#!/usr/bin/env node
/**
 * worktree 冒烟：构建 electron main → 用临时数据目录启动真实 Electron →
 * 主进程内走命令表跑 worktree 全链路（见 apps/electron/main/smoke-worktrees.ts）
 * → 以进程退出码汇报。
 *
 * 用法：bun run smoke:worktrees（或 node scripts/smoke-worktrees.mjs）
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(new URL(".", import.meta.url).pathname, "..");

function run(label, args, env) {
  const r = spawnSync(args[0], args.slice(1), {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`[smoke:worktrees] ${label} 失败（exit ${r.status ?? r.signal}）`);
    process.exit(r.status ?? 1);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "kova-smoke-data-"));
console.log(`[smoke:worktrees] data dir: ${dataDir}`);

try {
  run("构建 electron main", ["bun", "run", "--filter", "kova-electron-main", "build"]);
  run(
    "运行 Electron 冒烟",
    ["bun", "run", "--filter", "kova-electron-main", "start"],
    {
      KOVA_DATA_DIR: dataDir,
      KOVA_SMOKE_WORKTREES: "1",
      KOVA_AUTOMATION_INPROC: "1",
      // 冒烟不需要窗口交互；保持默认（Electron 会正常起主窗后立即退出）
    },
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("[smoke:worktrees] PASS");
