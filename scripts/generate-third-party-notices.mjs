#!/usr/bin/env node
/**
 * Third-Party Notices（第三方依赖许可清单）生成器：THIRD-PARTY-NOTICES.md
 * 由安装树自动生成。集合口径 = bun.lock 的规范依赖集（name@version 去重）
 * ∩ 本机实装树（bun 隔离布局：包本体在 node_modules/.bun/<key>+<hash>/
 * node_modules/ 下，顶层是指向存储或仓内 workspace 包的软链）。
 * 只看存储会把上次安装的孤儿包算进来（bun 不自动清存储），所以必须以
 * lockfile 过滤；许可/主页取包内 package.json（缺失标 "(none)"）。
 *
 * 改了依赖（bun install 后）重跑：node scripts/generate-third-party-notices.mjs
 * 产物 THIRD-PARTY-NOTICES.md 提交入库。
 */
import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** bun.lock 的规范依赖集：条目键（排除 optionalPeers）→ 值数组首元素 name@version */
function lockfilePackages() {
  const text = readFileSync(join(root, "bun.lock"), "utf8");
  const set = new Set();
  const re = /"((?:[^"\\]|\\.)*)":\s*\[\s*"([^"]*)"/g;
  for (const m of text.matchAll(re)) {
    const [, key, canonical] = m;
    if (key === "optionalPeers") continue;
    // 规范形态：name@version 或 @scope/name@version（workspace 条目/别名不含版本，跳过）
    if (/^(?:@[^/]+\/)?[^@/]+@[^@/]+$/.test(canonical)) set.add(canonical);
  }
  return set;
}

/** workspace 根集合：主根 + apps/*、apps/sidecar/*、packages/* */
function workspaceRoots() {
  const roots = [root];
  for (const rel of ["apps", "apps/sidecar", "packages"]) {
    const dir = join(root, rel);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (statSync(join(dir, entry)).isDirectory()) roots.push(join(dir, entry));
    }
  }
  return roots;
}

/** 一个包目录 → 许可/主页（元数据）；非包目录返回 null */
function readPackage(pkgDir) {
  let real;
  try {
    real = realpathSync(pkgDir);
  } catch {
    return null;
  }
  const pjPath = join(real, "package.json");
  if (!existsSync(pjPath)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(pjPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof doc?.name !== "string" || typeof doc?.version !== "string") return null;
  const license =
    (typeof doc.license === "string" && doc.license) ||
    (Array.isArray(doc.licenses)
      ? doc.licenses.map((l) => l?.type ?? l).join(",")
      : undefined) ||
    "(none)";
  const homepage =
    (typeof doc.homepage === "string" && doc.homepage) ||
    (typeof doc.repository === "string" && doc.repository) ||
    (typeof doc.repository?.url === "string" &&
      doc.repository.url.replace(/^git\+/, "").replace(/\.git$/, "")) ||
    "";
  return { key: `${doc.name}@${doc.version}`, license, homepage };
}

/** 遍历一个 node_modules 的 .bun 存储 + 顶层，装进 byKey（同名同版本去重） */
function collectFromNodeModules(nm, byKey) {
  const bunStore = join(nm, ".bun");
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore)) {
      const inner = join(bunStore, entry, "node_modules");
      if (!existsSync(inner)) continue;
      for (const seg of readdirSync(inner)) {
        if (seg.startsWith(".")) continue;
        if (seg.startsWith("@")) {
          const scope = join(inner, seg);
          for (const name of readdirSync(scope)) {
            const pkg = readPackage(join(scope, name));
            if (pkg) byKey.set(pkg.key, pkg);
          }
        } else {
          const pkg = readPackage(join(inner, seg));
          if (pkg) byKey.set(pkg.key, pkg);
        }
      }
    }
  }
  for (const name of readdirSync(nm)) {
    if (name === ".bun" || name.startsWith(".")) continue;
    const pkg = readPackage(join(nm, name));
    if (pkg) byKey.set(pkg.key, pkg);
  }
}

/** 分节口径：LGPL/GPL 系拦入「需逐项确认」；MPL/EPL/OFL/CC-BY 专节；余者宽松 */
function sectionOf(license) {
  const l = license.toLowerCase();
  if (l === "(none)") return "none";
  if (l.includes("lgpl") || l.includes("gpl")) return "copyleft";
  if (l.includes("mpl")) return "mpl";
  if (l.includes("epl")) return "epl";
  if (l.includes("ofl")) return "ofl";
  if (l.includes("cc-by")) return "ccbys";
  return "permissive";
}

const SECTION_DEFS = [
  ["copyleft", "需逐项确认（copyleft）"],
  ["mpl", "MPL-2.0（弱 copyleft，文件级）"],
  ["epl", "EPL-2.0（弱 copyleft）"],
  ["ofl", "OFL-1.1（字体）"],
  ["ccbys", "CC-BY-4.0（数据/文档）"],
  ["none", "无 license 字段"],
  ["permissive", "宽松许可（MIT/ISC/Apache/BSD 等）"],
];

const packages = new Map();
for (const ws of workspaceRoots()) {
  const nm = join(ws, "node_modules");
  if (existsSync(nm)) collectFromNodeModules(nm, packages);
}

// lockfile 权威集 ∩ 本机实装：存储里的孤儿包（上次安装残留）不算数；
// lockfile 里有而本机没有的（如其他平台的 optional 二进制）也不算
const locked = lockfilePackages();
let skippedLockOnly = 0;
for (const key of [...packages.keys()]) {
  if (!locked.has(key)) packages.delete(key);
}
for (const key of locked) {
  if (!packages.has(key)) skippedLockOnly++;
}

const buckets = new Map(SECTION_DEFS.map(([id]) => [id, []]));
for (const pkg of packages.values()) buckets.get(sectionOf(pkg.license)).push(pkg);
for (const list of buckets.values()) list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

const lines = [
  "# Third-Party Notices（第三方依赖许可清单）",
  "",
  "由安装树自动生成，以 bun.lock 解析集合为准。本项目主许可 Apache-2.0（见 LICENSE）。",
  "重新生成：`node scripts/generate-third-party-notices.mjs`（改依赖后重跑）。",
  "",
  `生成时间：${new Date().toISOString().slice(0, 10)}；依赖包总数：${packages.size}`,
  "",
];
for (const [id, title] of SECTION_DEFS) {
  const list = buckets.get(id);
  if (list.length === 0) continue;
  lines.push(`## ${title}（${list.length}）`, "");
  if (id === "copyleft") {
    lines.push(
      "> `@img/sharp-libvips-*`（LGPL-3.0）是 Next.js 图片管线的构建期平台二进制，经动态链接使用、不打包进应用分发；如改为静态捆绑需履行 LGPL 义务。",
      "",
    );
  }
  if (id === "none") {
    lines.push(
      "> 以下多为知名开源项目元数据缺失（如 @giscus/react 实为 MIT）。发布前建议抽查上游仓库声明。",
      "",
    );
  }
  for (const pkg of list) {
    lines.push(`- \`${pkg.key}\` — ${pkg.license}${pkg.homepage ? ` — ${pkg.homepage}` : ""}`);
  }
  lines.push("");
}
lines.pop(); // 尾部留单个换行

const { writeFileSync } = await import("node:fs");
const outFile = join(root, "THIRD-PARTY-NOTICES.md");
writeFileSync(outFile, lines.join("\n") + "\n");
console.log(
  `THIRD-PARTY-NOTICES.md：${packages.size} 个依赖包（lockfile ${locked.size}，本机缺 ${skippedLockOnly}，存储孤儿已剔），` +
    SECTION_DEFS.map(([id, title]) => `${title} ${buckets.get(id).length}`).join(" · "),
);
