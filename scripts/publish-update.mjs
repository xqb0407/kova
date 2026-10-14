#!/usr/bin/env node
/**
 * 升级发布脚本：把两类清单写进 Cloudflare KV，由 `dl.openkova.site` 上的只读 Worker 转发。
 *
 *   1. 通知清单 manifest:{preview|stable}  → /{channel}/latest.json   （应用内"发现新版本"提示）
 *   2. 升级包清单 updater:{target}-{arch}  → /updater/{target}/{arch}/{ver}（Tauri updater 安装用）
 *
 * 为什么不是 R2：R2 启用要绑支付方式；Workers + KV 免费档不需要。
 * 安装包本身不进 KV —— 它们挂在 GitHub Releases（公开仓），这里只写 URL 与签名。
 *
 * 用法：
 *   node scripts/publish-update.mjs --version 1.1.4-preview \
 *        [--notes-file NOTES.md | --notes "一行说明"] \
 *        [--dmg <Kova_x_aarch64.dmg>] [--exe <Kova_x_x64-setup.exe>] \
 *        [--mac-updater <Kova.app.tar.gz>] [--win-updater <Kova_x_x64-setup.exe>] \
 *        [--channel preview|stable] [--release-base <资产前缀>] \
 *        [--page-url <release 页>] [--namespace-id <KV id>] [--dry-run]
 *
 * `--mac-updater/--win-updater` 会自动读同目录的 `<文件>.sig`（tauri build 开
 * createUpdaterArtifacts 后产物）；缺它俩时只更新通知清单，应用内升级不可用。
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
    "用法: node scripts/publish-update.mjs --version 1.1.4-preview [--notes-file NOTES.md] [--dmg <路径>] [--exe <路径>] [--mac-updater <路径>] [--win-updater <路径>]",
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
const pageUrl = arg("page-url", `https://github.com/xqb0407/kova/releases/tag/v${version}`);
const releaseBase = arg(
  "release-base",
  `https://github.com/xqb0407/kova/releases/download/v${version}`,
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
const manifest = {
  channel,
  version,
  releasedAt,
  ...(notes ? { notes } : {}),
  pageUrl,
  downloads,
};

// ---------------------------------------------------------------------------
// 2) 升级包清单（Tauri updater 标准格式）
//    --mac-updater/--win-updater 可以给本地产物路径，也可以只给 Release 资产文件名。
//    签名优先读本地 <文件>.sig；没有就从 Release 拉（公开仓，顺带证明资产已发布）。
// ---------------------------------------------------------------------------
const platforms = {};
for (const [name, key] of [
  ["mac-updater", "darwin-aarch64"],
  ["win-updater", "windows-x86_64"],
]) {
  const path = arg(name);
  if (!path) continue;
  const fileName = basename(path);
  const url = `${releaseBase}/${fileName}`;
  let signature = null;
  const localSig = `${path}.sig`;
  if (dry) {
    // 预演不校验/不拉签名（资产可能还没发布）
    signature = "<dry-run>";
  } else if (existsSync(localSig)) {
    signature = readFileSync(localSig, "utf8").trim();
    console.log(`签名来源: 本地 ${localSig}`);
  } else {
    const res = await fetch(`${url}.sig`).catch(() => null);
    if (!res || !res.ok) {
      console.error(
        `✗ 取不到签名文件：${url}.sig${res ? `（HTTP ${res.status}）` : ""}\n` +
          `  要么本地放好 ${localSig}，要么确认 Release 资产已发布且文件名正确`,
      );
      process.exit(1);
    }
    signature = (await res.text()).trim();
    console.log(`签名来源: Release ${url}.sig`);
  }
  platforms[key] = { url, signature };
}
const updaterDoc = Object.keys(platforms).length
  ? { version, ...(notes ? { notes } : {}), pub_date: releasedAt, platforms }
  : null;

// ---------------------------------------------------------------------------
// 汇总 + 上传
// ---------------------------------------------------------------------------
console.log(`渠道: ${channel}   版本: ${version}`);
console.log(`通知清单: https://dl.openkova.site/${channel}/latest.json（KV manifest:${channel}）`);
for (const [k, v] of Object.entries(downloads)) console.log(`  下载: ${k} → ${v}`);
if (Object.keys(downloads).length === 0) {
  console.log("  （未指定 --dmg/--exe：downloads 为空，「去网页下载」退回 Release 页）");
}
if (updaterDoc) {
  for (const [k, v] of Object.entries(platforms)) {
    console.log(`升级包: ${k} → ${v.url}（签名 ${v.signature.slice(0, 24)}…）`);
  }
} else {
  console.log("（未指定 --mac-updater/--win-updater：不写升级清单，应用内「下载并安装」不可用）");
}

if (dry) {
  console.log("\n--- dry-run：写入内容如下，未落 KV ---");
  console.log(JSON.stringify({ [`manifest:${channel}`]: manifest, ...(updaterDoc ? { "updater:*": updaterDoc } : {}) }, null, 2));
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
if (updaterDoc) {
  // 同一份文档写进每个平台键：Worker 按请求的 target-arch 取键，文档里含该平台的
  // url+signature 即可（Tauri 只读自己那一条）
  for (const key of Object.keys(platforms)) {
    put(`updater:${key}`, updaterDoc);
  }
}

console.log("\n✓ 已发布。验证：");
console.log(`  curl -sS https://dl.openkova.site/${channel}/latest.json`);
if (updaterDoc) {
  const [t, a] = Object.keys(platforms)[0].split("-");
  console.log(`  curl -sS https://dl.openkova.site/updater/${t}/${a}/${version}`);
}
