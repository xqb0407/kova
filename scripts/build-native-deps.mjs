#!/usr/bin/env node
/**
 * 编译 Electron 侧的原生依赖（当前只有 node-pty）。
 *
 * 为什么需要它：`bun install` 默认不执行 postinstall，node-pty 的 `pty.node` 不会自己
 * 出现——漏这一步，打出来的装机版里"终端"面板一开就报不可用。node-pty 走 N-API，
 * 编译产物 Node/Electron ABI 通用，编一次即可。
 *
 * 为什么不用 `require.resolve("node-pty/package.json")`：CI（bun workspace）下
 * node-pty 未必提升到根 node_modules，实测在 GitHub macOS runner 上解析失败。
 * 这里按候选目录逐个探测，找不到就明确报错（不静默跳过）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 候选：根 node_modules → 各 app 的 node_modules → bun 的 .bun 存储 */
function dirs(path) {
  try {
    return statSync(path).isDirectory() ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

function findNodePty() {
  const candidates = [join(root, "node_modules", "node-pty")];
  for (const dir of ["apps", "packages", "plugins"]) {
    const base = join(root, dir);
    for (const name of dirs(base)) {
      if (name.startsWith(".")) continue; // .DS_Store 等
      const nested = join(base, name);
      candidates.push(join(nested, "node_modules", "node-pty"));
      for (const sub of dirs(nested)) {
        if (sub.startsWith(".")) continue; // apps/sidecar/pi-agent 这类二层目录
        candidates.push(join(nested, sub, "node_modules", "node-pty"));
      }
    }
  }
  const bunStore = join(root, "node_modules", ".bun");
  {
    for (const entry of dirs(bunStore)) {
      if (entry.startsWith("node-pty@")) candidates.push(join(bunStore, entry, "node_modules", "node-pty"));
    }
  }
  return candidates.find((c) => existsSync(join(c, "package.json"))) ?? null;
}

const pkgDir = findNodePty();
if (!pkgDir) {
  console.error("✗ 找不到 node-pty（依赖没装？先跑 bun install）");
  process.exit(1);
}
const binding = join(pkgDir, "build", "Release", "pty.node");
if (existsSync(binding)) {
  console.log(`✓ node-pty 已编译：${binding}`);
  process.exit(0);
}
console.log(`>> 编译 node-pty（${pkgDir}）`);
execFileSync(process.execPath, ["scripts/install.js"], { cwd: pkgDir, stdio: "inherit" });
if (!existsSync(binding)) {
  console.error(`✗ 编译结束但缺少 ${binding}`);
  process.exit(1);
}
console.log(`✓ node-pty 编译完成：${binding}`);
