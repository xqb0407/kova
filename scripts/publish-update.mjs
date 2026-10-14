#!/usr/bin/env node
/**
 * 升级发布脚本：把通知清单写进 Cloudflare KV，由 `dl.openkova.site` 上的只读 Worker 转发。
 *
 *   通知清单 manifest:{preview|stable} → /{channel}/latest.json（应用内"发现新版本"提示）
 *
 * 为什么不是 R2：R2 启用要绑支付方式；Workers + KV 免费档不需要。
 * 安装包本身不进 KV —— 它们挂在 GitHub Releases（公开仓），这里只写 URL。
 *
 * 键位约定（与应用侧 update.ts 对齐）：
 *   downloads.macos-aarch64 / downloads.windows-x64        ≈ 通用下载页直链
 *   downloadsElectron.macos-aarch64 / …windows-x64        ≈ 本 Electron 版专用直链
 * 两个键分开写：把 Electron 产物写进 downloads 会误导仍在用旧桌面壳的客户端。
 *
 * 用法：
 *   node scripts/publish-update.mjs --version 1.1.4-preview \
 *        [--notes-file NOTES.md | --notes "一行说明"] \
 *        [--electron-dmg <Kova_x_arm64.dmg>] [--electron-exe <Kova_x_x64-setup.exe>] \
 *        [--channel preview|stable] [--repo <owner/name>] \
 *        [--release-base <资产前缀>] [--page-url <release 页>] \
 *        [--namespace-id <KV id>] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const version = arg("version");
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(
    "用法: node scripts/publish-update.mjs --version 1.1.4-preview [--notes-file NOTES.md] [--dmg <路径>] [--exe <路径>]",
  );
  process.exit(1);
}

const dry = flag("dry-run");
const channel = arg("channel", version.includes("-preview") ? "preview" : "stable");
if (channel !== "preview" && channel !== "stable") {
  console.error(`✗ channel 只能是 preview / stable（收到 ${channel}）`);
  process.exit(1);
}
// KV 命名空间（cloudfleare/kova-update/wrangler.toml 的 binding UPDATES）
const namespaceId = arg("namespace-id", "e7cba5852a25481a906bae6613831d42");
const repo = arg("repo", "xqb0407/kova-electron");
const pageUrl = arg("page-url", `https://github.com/${repo}/releases/tag/v${version}`);
const releaseBase = arg(
  "release-base",
  `https://github.com/${repo}/releases/download/v${version}`,
).replace(/\/+$/, "");
const notesFile = arg("notes-file");
const notes = notesFile
  ? readFileSync(notesFile, "utf8").trim()
  : (arg("notes", "") ?? "").trim();
const releasedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// 1) 通知清单（自建格式）：平台键必须与应用侧 update.rs 的 platform_key() 一致
// ---------------------------------------------------------------------------
// --dmg/--exe 只用来拼 Release 资产直链：本地有文件就取真名，没有就按给定名字用
const downloads = {};
for (const [name, key] of [
  ["dmg", "macos-aarch64"],
  ["exe", "windows-x64"],
]) {
  const path = arg(name);
  if (!path) continue;
  downloads[key] = `${releaseBase}/${basename(path)}`;
}
const downloadsElectron = {};
for (const [name, key] of [
  ["electron-dmg", "macos-aarch64"],
  ["electron-exe", "windows-x64"],
]) {
  const path = arg(name);
  if (!path) continue;
  downloadsElectron[key] = `${releaseBase}/${basename(path)}`;
}
const manifest = {
  channel,
  version,
  releasedAt,
  ...(notes ? { notes } : {}),
  pageUrl,
  downloads,
  ...(Object.keys(downloadsElectron).length ? { downloadsElectron } : {}),
};

// ---------------------------------------------------------------------------
// 汇总 + 上传
// ---------------------------------------------------------------------------
console.log(`渠道: ${channel}   版本: ${version}`);
console.log(`通知清单: https://dl.openkova.site/${channel}/latest.json（KV manifest:${channel}）`);
for (const [k, v] of Object.entries(downloads)) console.log(`  下载: ${k} → ${v}`);
if (Object.keys(downloads).length === 0) {
  console.log("  （未指定 --dmg/--exe：downloads 为空，「去网页下载」退回 Release 页）");
}
for (const [k, v] of Object.entries(downloadsElectron)) console.log(`  Electron 专用下载: ${k} → ${v}`);
if (Object.keys(downloadsElectron).length === 0) {
  console.log("  （未指定 --electron-dmg：Electron 版将退回通用 downloads/pageUrl）");
}

if (dry) {
  console.log("\n--- dry-run：写入内容如下，未落 KV ---");
  console.log(JSON.stringify({ [`manifest:${channel}`]: manifest }, null, 2));
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "kova-update-"));
function put(key, doc) {
  const path = join(tmp, `${key.replace(/[:/]/g, "_")}.json`);
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
  console.log(`>> kv put ${key}`);
  execFileSync(
    "npx",
    ["wrangler", "kv", "key", "put", key, "--namespace-id", namespaceId, "--path", path, "--remote"],
    { stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
}

put(`manifest:${channel}`, manifest);

console.log("\n✓ 已发布。验证：");
console.log(`  curl -sS https://dl.openkova.site/${channel}/latest.json`);
