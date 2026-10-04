#!/usr/bin/env node
// 插件面板单文件 HTML（plugins/<name>/<name>.html）为 vite 构建产物，不入库。
// 此脚本幂等：产物已存在则跳过，--force 强制全部重建。
// 依赖来自根 bun workspaces（bun install 后 `bun run --filter <name> build`），
// CI 与本地同一链路；构建后把 ui/dist/index.html 兜底拷为根 HTML（postbuild
// 已拷一份，此处双保险），面板 HTML 缺失即失败——下游 plugins:pack 依赖它。
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");
const targets = [
  ["office", "office.html"],
  ["canvas", "canvas.html"],
  ["ui-design", "design.html"],
];

for (const [name, entry] of targets) {
  const entryPath = join(repoRoot, "plugins", name, entry);
  if (!force && existsSync(entryPath)) {
    console.log(`[build-plugins] plugins/${name} 产物已存在，跳过（--force 可强制重建）`);
    continue;
  }
  console.log(`[build-plugins] 构建 plugins/${name} ...`);
  const r = spawnSync("bun", ["run", "--filter", name, "build"], { cwd: repoRoot, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[build-plugins] plugins/${name} 构建失败`);
    process.exit(r.status ?? 1);
  }
  const dist = join(repoRoot, "plugins", name, "ui", "dist", "index.html");
  if (!existsSync(dist)) {
    console.error(`[build-plugins] plugins/${name} 缺少 ui/dist/index.html`);
    process.exit(1);
  }
  copyFileSync(dist, entryPath);
}
