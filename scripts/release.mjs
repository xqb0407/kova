#!/usr/bin/env node
/**
 * 发版脚本：同步三处版本号 → 提交 → 打 tag → 推送到 Gitee 主仓与 GitHub 镜像仓。
 *
 * 用法：
 *   node scripts/release.mjs 0.1.1             # 正式发版
 *   node scripts/release.mjs 0.1.1 --dry-run   # 预演，只打印计划不落盘
 *
 * 前置：工作区必须干净（发版内容应已提交）；
 *       GitHub 镜像远端需已配置：git remote add release https://github.com/<user>/<repo>.git
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dry = process.argv.includes("--dry-run");
if (!arg || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) {
  console.error("用法: node scripts/release.mjs <版本号> [--dry-run]   例: node scripts/release.mjs 0.1.1");
  process.exit(1);
}
const version = arg;
const tag = `v${version}`;

const tauriConfPath = "apps/desktop/src-tauri/tauri.conf.json";
const desktopPkgPath = "apps/desktop/package.json";
const cargoPath = "apps/desktop/src-tauri/Cargo.toml";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

// 前置检查：工作区干净（dry-run 仅警告）
const dirty = sh("git status --porcelain");
if (dirty) {
  if (!dry) {
    console.error("✗ 工作区有未提交改动，发版内容应先提交。请 commit 或 stash 后重试：");
    console.error(dirty);
    process.exit(1);
  }
  console.warn("⚠ dry-run 忽略未提交改动；正式发版前需保证工作区干净");
}

// 版本号三处同步：tauri.conf.json（打包权威来源）+ desktop/package.json + Cargo.toml [package]
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
const oldVersion = tauriConf.version;
tauriConf.version = version;
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, "utf8"));
desktopPkg.version = version;
let cargo = readFileSync(cargoPath, "utf8");
const cargoReplaced = cargo.replace(
  /(^\[package\][\s\S]*?^version = ")[^"]+(")/m,
  `$1${version}$2`,
);
if (cargoReplaced === cargo) throw new Error("Cargo.toml [package] version 未匹配到，请人工检查");
cargo = cargoReplaced;

console.log(`版本: ${oldVersion} → ${version} (tag ${tag})`);
console.log(`改写: ${tauriConfPath}, ${desktopPkgPath}, ${cargoPath}`);

if (dry) {
  console.log("dry-run 结束，未写入任何文件");
  process.exit(0);
}

writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");
writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + "\n");
writeFileSync(cargoPath, cargo);

// 只提交版本文件，避免误带入其他改动
sh(`git add ${tauriConfPath} ${desktopPkgPath} ${cargoPath}`);
sh(`git commit -m "release: v${version}"`);
sh(`git tag ${tag}`);

// 推送：Gitee 主仓 + GitHub 镜像（CI 触发源）
sh(`git push origin HEAD ${tag}`);
console.log(`✓ 已推送到 origin`);
try {
  sh(`git push release HEAD ${tag}`);
  console.log(`✓ 已推送到 release (GitHub)，Actions 将自动构建并创建 Draft Release`);
} catch {
  console.error(`✗ 推送 release 远端失败。若尚未配置，执行：`);
  console.error(`    git remote add release https://github.com/<user>/<repo>.git`);
  console.error(`  然后：git push release HEAD ${tag}`);
  process.exit(1);
}
