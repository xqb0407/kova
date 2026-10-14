#!/usr/bin/env node
/**
 * 确保 Electron 侧的原生依赖（当前只有 node-pty）在打包前可用。
 *
 * 为什么需要它：`bun install` 默认不执行包的 install/postinstall，历史版本里
 * node-pty 的 `build/Release/pty.node` 不会自己出现——漏这一步，打出来的装机版
 * 里"终端"面板一开就报不可用。
 *
 * 但 node-pty 1.1.x 起**自带预编译产物**（`prebuilds/<platform>-<arch>/`，N-API
 * 跨 Node/Electron ABI 通用），运行时加载顺序是
 *   build/Release → build/Debug → prebuilds/<platform>-<arch>
 * （见 node-pty 的 lib/utils.js），所以正常情况无需编译。
 *
 * 本脚本因此校验优先：
 *   1. 三个加载位置任一存在 → 直接通过（并打印实际会用哪个）；
 *   2. 都不存在才执行包自身的 install / postinstall 脚本
 *      （1.1.x 的 `node scripts/prebuild.js || node-gyp rebuild` 与
 *      `node scripts/post-install.js`），再校验一次。
 * 不硬编码 `scripts/install.js`：node-pty 1.1.0 起该文件已不存在（改名 prebuild.js），
 * 硬编码它会让 CI 直接 MODULE_NOT_FOUND（实测 v1.1.7-preview 两平台都栽在这）。
 *
 * 为什么不用 `require.resolve("node-pty/package.json")`：CI（bun workspace）下
 * node-pty 未必提升到根 node_modules，实测在 GitHub macOS runner 上解析失败。
 * 这里按候选目录逐个探测，找不到就明确报错（不静默跳过）。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  for (const entry of dirs(bunStore)) {
    if (entry.startsWith("node-pty@")) candidates.push(join(bunStore, entry, "node_modules", "node-pty"));
  }
  return candidates.find((c) => existsSync(join(c, "package.json"))) ?? null;
}

/** node-pty 运行时的加载顺序（lib/utils.js 的 dirs 数组），返回第一个存在的 */
function loadableBinary(pkgDir) {
  const platArch = `${process.platform}-${process.arch}`;
  const paths = [
    join(pkgDir, "build", "Release", "pty.node"),
    join(pkgDir, "build", "Debug", "pty.node"),
    join(pkgDir, "prebuilds", platArch, "pty.node"),
  ];
  return paths.find((p) => existsSync(p)) ?? null;
}

const pkgDir = findNodePty();
if (!pkgDir) {
  console.error("✗ 找不到 node-pty（依赖没装？先跑 bun install）");
  process.exit(1);
}

const found = loadableBinary(pkgDir);
if (found) {
  console.log(`✓ node-pty 可用（无需编译）：${found}`);
  process.exit(0);
}

// 没有可用产物：走包自身的 install / postinstall（命令串可能含 "||"，用平台默认 shell）
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};
const steps = [
  ["install", scripts.install],
  ["postinstall", scripts.postinstall],
].filter(([, cmd]) => typeof cmd === "string" && cmd.length > 0);
if (steps.length === 0) {
  console.error(`✗ node-pty 没有 install/postinstall 脚本，且 ${pkgDir} 下也没有可用二进制`);
  process.exit(1);
}
console.log(`>> node-pty 无预编译产物，改走包自身构建脚本（${pkgDir}）`);
for (const [name, cmd] of steps) {
  console.log(`>> npm run ${name}：${cmd}`);
  execSync(cmd, { cwd: pkgDir, stdio: "inherit" });
}

const after = loadableBinary(pkgDir);
if (!after) {
  console.error(`✗ 构建脚本已跑完，但 ${pkgDir} 下仍无 pty.node（build/Release 与 prebuilds/<plat>-<arch> 皆无）`);
  process.exit(1);
}
console.log(`✓ node-pty 编译完成：${after}`);
