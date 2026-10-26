#!/usr/bin/env node
/**
 * Windows 一键打包：`bun run package:win` / `bun run package:win:dev`
 *
 * 和 .github/workflows/release.yml 的 build-windows job 同一条链路：
 *   bun install → build-native-deps → build(sidecar/renderer/main)
 *   → electron-builder --win nsis
 *
 * 只在 Windows 上运行。打包前先停掉 `bun dev` / `next dev`，避免 watcher
 * 在构建期间重启 Electron。
 *
 * 产物：
 *   release/Kova_<version>_<arch>-setup.exe          （package:win）
 *   release-dev/Kova Dev_<version>_<arch>-setup.exe  （package:win:dev）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const electronDir = join(root, "apps", "electron");
const dev = process.argv.includes("--dev");
const product = dev ? "Kova Dev" : "Kova";
const help = process.argv.includes("--help") || process.argv.includes("-h");
/** 本脚本由 Bun 启动；若用 Node 跑，退回 PATH 里的 bun */
const bun = process.versions.bun ? process.execPath : "bun";

if (help) {
  console.log(`用法:
  bun run package:win        # 正式 Kova 安装包（和 release workflow 一致）
  bun run package:win:dev    # Kova Dev 渠道包（独立 appId/数据目录）

前置：Bun 1.3.14、Node 20+、Rust stable；先停掉 bun dev / next dev。
产物：
  apps/electron/release/Kova_<version>_<arch>-setup.exe
  apps/electron/release-dev/Kova Dev_<version>_<arch>-setup.exe`);
  process.exit(0);
}

if (process.platform !== "win32") {
  console.error("✗ 这个脚本用于 Windows 原生打包；当前平台不是 win32。");
  console.error("  非 Windows 上 electron-builder 的 Windows 目标可能需要 Wine。");
  process.exit(1);
}

function run(cmd, args, cwd = root) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) {
    console.error(`✗ ${cmd} 启动失败：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(" ")} 失败（exit ${r.status}）`);
    process.exit(r.status ?? 1);
  }
}

// build:sidecar 要读 rustc -vV 的 host triple；缺了会在构建半路才报
const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rustc.status !== 0) {
  console.error("✗ 未找到 rustc。先安装 Rust stable：");
  console.error("  winget install Rustlang.Rustup");
  console.error("  rustup default stable");
  process.exit(1);
}

console.log(
  `[package-win] ${product} · Windows NSIS`,
);
console.log("[package-win] 请先确认 bun dev / next dev 已停止");

run(bun, ["install"]);
run("node", ["scripts/build-native-deps.mjs"]);
run(bun, ["run", "build"]);
run(
  bun,
  ["run", dev ? "dist:dev" : "dist", "--", "--win", "nsis"],
  electronDir,
);

const pkg = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8"));
const outDir = join(electronDir, dev ? "release-dev" : "release");
const exes = existsSync(outDir)
  ? readdirSync(outDir)
      .filter(
        (f) =>
          f.toLowerCase().endsWith(".exe") && f.includes(pkg.version),
      )
      .sort()
  : [];

console.log(`\n[package-win] ${product} ${pkg.version} 完成`);
if (exes.length === 0) {
  console.error(
    `✗ ${outDir} 下没有 ${pkg.version} 的 .exe，请检查 electron-builder 输出`,
  );
  process.exit(1);
}
for (const f of exes) console.log(`  ${join(outDir, f)}`);
