#!/usr/bin/env node
/**
 * 发版脚本（Electron 版）：同步三处版本号 → 提交 → 打 tag → 推送到主仓与 GitHub 镜像仓。
 * 与 Tauri 版的差异只在"bump 哪三个文件"——原版同步 tauri.conf.json / desktop/package.json /
 * Cargo.toml，本仓没有 tauri/Cargo，改为 root / apps/desktop / apps/electron 三个 package.json
 * （apps/electron 的 package.json 是打包权威来源，electron-builder 从它读 version）。
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

const versionFiles = ["package.json", "apps/desktop/package.json", "apps/electron/package.json"];

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

// 版本号三处同步：root / desktop / electron-主进程（打包版以 apps/electron 为准）
const oldVersion = JSON.parse(readFileSync(versionFiles[0], "utf8")).version ?? "0.0.0";

console.log(`版本: ${oldVersion} → ${version} (tag ${tag})`);
console.log(`改写: ${versionFiles.join(", ")}`);

if (dry) {
  console.log("dry-run 结束，未写入任何文件");
  process.exit(0);
}

for (const f of versionFiles) {
  const pkg = JSON.parse(readFileSync(f, "utf8"));
  pkg.version = version;
  writeFileSync(f, JSON.stringify(pkg, null, 2) + "\n");
}

// 只提交版本文件，避免误带入其他改动
sh(`git add ${versionFiles.join(" ")}`);
if (sh("git diff --cached --name-only").length > 0) {
  sh(`git commit -m "release: v${version}"`);
} else {
  console.log("版本未变化：跳过提交，直接打 tag");
}
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
