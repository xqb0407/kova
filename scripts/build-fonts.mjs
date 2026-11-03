#!/usr/bin/env node
/**
 * 非默认字体的静态资源准备。
 *
 * layout.tsx 首屏只保留 Geist；Inter/Roboto/Open Sans/Noto/思源宋体/霞鹜文楷/
 * JetBrains 的 CSS + woff2 由本脚本复制到 apps/desktop/public/fonts/<family>/，
 * 运行时由 FontCssLoader 在用户选中对应字体时才注入 <link>。
 *
 * - 产物是字体包原始 CSS（相对路径 ./files/*.woff2 保持不变）；
 * - **只复制 CSS 实际引用的 woff2**：@fontsource 的整个 files/ 目录包含全部
 *   字重与格式（woff/woff2），整目录拷贝会让安装包多背 150MB+；
 * - public/fonts 生成物不提交（.gitignore），dev/build 前自动补齐；
 * - 按「包版本 + 构建逻辑版本」写 .version，已是最新则跳过；旧产物整目录重建，
 *   保证历史上按整包拷贝出来的大目录会被自动清掉。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 剪裁逻辑/清单格式变化时递增：强制重建已有产物（含历史整包拷贝的旧目录） */
const BUILD_VERSION = 3;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps", "desktop");
const manifestPath = join(desktopDir, "lib", "theme", "font-assets.json");
const outRoot = join(desktopDir, "public", "fonts");
const req = createRequire(join(desktopDir, "package.json"));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
mkdirSync(outRoot, { recursive: true });

/** @font-face 的 src 引用；@fontsource 与 lxgw 都是相对 CSS 的 ./files/... */
const FONT_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

/** 清单条目 → 需要注入的 CSS 文件名（weight 约定或显式 css 列表） */
function cssFilesFor(entry) {
  if (Array.isArray(entry.css) && entry.css.length > 0) return entry.css;
  return (entry.weights ?? []).map((weight) => `${weight}.css`);
}

for (const [family, entry] of Object.entries(manifest)) {
  const familyDir = join(outRoot, family);
  const versionPath = join(familyDir, ".version");
  const pkgPath = req.resolve(`${entry.package}/package.json`);
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  // 清单内容（字重/CSS 列表）也进缓存键：只改 font-assets.json 时也能触发重建
  const entryKey = createHash("sha1")
    .update(JSON.stringify({ pkg: entry.package, css: cssFilesFor(entry) }))
    .digest("hex")
    .slice(0, 12);
  const stamp = `${version}@${BUILD_VERSION}:${entryKey}`;
  if (
    existsSync(versionPath) &&
    readFileSync(versionPath, "utf8").trim() === stamp
  ) {
    continue;
  }

  // 历史产物可能是整个 files/ 目录，先删后建才能把体积降下来
  rmSync(familyDir, { recursive: true, force: true });
  mkdirSync(familyDir, { recursive: true });

  const copied = new Set();
  for (const cssFile of cssFilesFor(entry)) {
    const cssSource = req.resolve(`${entry.package}/${cssFile}`);
    const css = readFileSync(cssSource, "utf8");
    copyFileSync(cssSource, join(familyDir, cssFile));

    const cssDir = dirname(cssSource);
    for (const match of css.matchAll(FONT_URL_RE)) {
      const ref = match[1].trim();
      // Chromium 只走 woff2；woff 回退留在 CSS 里但不再复制
      if (!ref.toLowerCase().endsWith(".woff2") || copied.has(ref)) continue;
      copied.add(ref);
      const source = resolve(cssDir, ref);
      if (!existsSync(source)) {
        console.warn(`[fonts] ${family}: 缺少引用文件 ${ref}`);
        continue;
      }
      const target = join(familyDir, ref);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }

  // OFL 要求随字体分发许可证文本
  for (const license of ["LICENSE", "LICENSE.txt", "OFL.txt"]) {
    const source = join(dirname(pkgPath), license);
    if (existsSync(source)) {
      copyFileSync(source, join(familyDir, license));
      break;
    }
  }

  writeFileSync(versionPath, stamp);
  console.log(
    `[fonts] ${family}@${version} → ${familyDir}（${copied.size} 个 woff2）`,
  );
}
