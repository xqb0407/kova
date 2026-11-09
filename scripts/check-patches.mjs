#!/usr/bin/env node
/**
 * 补丁门禁：patchedDependencies 必须与安装树版本一致，且补丁内容真的落到文件里。
 *
 * 背景：bun 的 patchedDependencies 键写死 name@version，依赖升级后旧补丁不会应用，
 * 但 install/build 都不报错（@assistant-ui/core 0.3.22 → 0.3.27 曾静默失效）。
 * 这里在 verify:goal 里兜底：版本不匹配或补丁标记缺失都直接失败。
 * 范围：workspace 根下的 node_modules 链接（bun 隔离布局的实际消费入口）；
 * 存储里的孤儿实例不参与判断。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const patched = rootPkg.patchedDependencies ?? {};
const keys = Object.keys(patched);

if (keys.length === 0) {
  console.log("check:patches: 没有 patchedDependencies，跳过");
  process.exit(0);
}

/** workspace 根：主根 + apps/*、apps/sidecar/*、packages/* */
function workspaceRoots() {
  const roots = [root];
  const addChildren = (rel) => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const child = join(dir, entry);
      if (statSync(child).isDirectory()) roots.push(child);
    }
  };
  addChildren("apps");
  addChildren(join("apps", "sidecar"));
  addChildren("packages");
  return roots;
}

/** 所有装了 name 的 node_modules 目录（bun 隔离布局下可能有多个 peer 变体） */
function installedDirs(name) {
  const dirs = [];
  for (const ws of workspaceRoots()) {
    const dir = join(ws, "node_modules", name);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

function installedVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/** 从 unified diff 提取「文件 → 新增行」，用于确认补丁确实落盘 */
function addedLines(patchText) {
  const files = new Map();
  let current;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = line.slice("+++ b/".length).trim();
      files.set(current, new Set());
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      current = undefined;
      continue;
    }
    if (current === undefined || !line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1).trim();
    if (text.length >= 12 && !/^[{}();,]+$/.test(text)) files.get(current).add(text);
  }
  return files;
}

function isPatched(dir, files) {
  for (const [file, lines] of files) {
    const target = join(dir, file);
    if (!existsSync(target)) return false;
    const contentLines = new Set(readFileSync(target, "utf8").split("\n").map((l) => l.trim()));
    for (const line of lines) {
      if (!contentLines.has(line)) return false;
    }
  }
  return true;
}

let failed = false;
let hadUnverifiable = false;
for (const key of keys) {
  const at = key.lastIndexOf("@");
  const name = at > 0 ? key.slice(0, at) : key;
  const version = at > 0 ? key.slice(at + 1) : "";
  const patchPath = patched[key];

  const patchFile = join(root, patchPath);
  if (!existsSync(patchFile)) {
    console.error(`check:patches: ✗ ${key} — patch 文件不存在: ${patchPath}`);
    failed = true;
    continue;
  }

  const dirs = installedDirs(name);
  const versions = [...new Set(dirs.map(installedVersion).filter(Boolean))];
  const matching = dirs.filter((dir) => installedVersion(dir) === version);

  // 部分升级最危险：注册版本还在（某个 workspace 仍链着），但另一个 workspace
  // 已切到新版本——新版本实例不会应用补丁，只看注册版本会漏掉。
  const otherVersions = versions.filter((v) => v !== version);
  if (otherVersions.length > 0) {
    console.error(
      `check:patches: ✗ ${key} — 安装树还在消费未注册版本: ${otherVersions.join(", ")}（已注册: ${version}）。\n` +
        `  这些实例不会应用补丁；请统一版本（overrides）或为新版本重新生成补丁。`,
    );
    failed = true;
    continue;
  }

  if (matching.length === 0) {
    console.error(
      `check:patches: ✗ ${key} — 安装树里没有该版本（实际: ${versions.join(", ") || "未安装"}）。\n` +
        `  patchedDependencies 的键写死了版本，补丁不会应用；请重新生成：bun patch ${name}@<实际版本>`,
    );
    failed = true;
    continue;
  }

  const files = addedLines(readFileSync(patchFile, "utf8"));
  const unverifiable = [...files].filter(([, lines]) => lines.size === 0).map(([file]) => file);
  if (unverifiable.length > 0) {
    hadUnverifiable = true;
    console.warn(
      `check:patches: ⚠ ${key} — 以下文件没有可校验的新增行（纯删除补丁），只能确认版本: ` +
        unverifiable.join(", "),
    );
  }
  // 同一版本可能有多个 peer 变体；按实际链接目标去重，要求每个被消费的实例都带补丁。
  const targets = [...new Set(matching.map((dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  }))];
  const unpatched = targets.filter((dir) => !isPatched(dir, files));

  if (unpatched.length > 0) {
    console.error(
      `check:patches: ✗ ${key} — ${unpatched.length}/${targets.length} 个安装实例没有补丁：\n` +
        unpatched.map((dir) => `  - ${dir}`).join("\n") +
        `\n  请重装依赖：bun install；若仍失败，重新生成补丁：bun patch ${name}@${version}`,
    );
    failed = true;
    continue;
  }

  const caveat = unverifiable.length > 0 ? `；${unverifiable.length} 个文件仅校验版本` : "";
  console.log(`check:patches: ✓ ${key} (${targets.length} 个安装实例全部生效${caveat})`);
}

if (failed) process.exit(1);
if (hadUnverifiable) {
  console.log(`check:patches: ${keys.length} 个补丁通过（部分文件仅校验版本，见上方警告）`);
} else {
  console.log(`check:patches: ${keys.length} 个补丁全部生效`);
}
