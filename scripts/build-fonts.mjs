#!/usr/bin/env node
/**
 * 非默认字体的静态资源准备。
 *
 * layout.tsx 首屏只保留 Geist；Inter/Roboto/Open Sans/Noto/思源宋体/JetBrains
 * 的 CSS + woff2 由本脚本复制到 apps/desktop/public/fonts/<family>/，运行时由
 * FontCssLoader 在用户选中对应字体时才注入 <link>。
 *
 * - 产物是 @fontsource 的原始 CSS（相对路径 ./files/*.woff2 保持不变）；
 * - public/fonts 生成物不提交（.gitignore），dev/build 前自动补齐；
 * - 按包版本写 .version，已是最新则跳过，避免每次 dev 都拷贝几百个字体文件。
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = join(root, "apps", "desktop");
const manifestPath = join(desktopDir, "lib", "theme", "font-assets.json");
const outRoot = join(desktopDir, "public", "fonts");
const req = createRequire(join(desktopDir, "package.json"));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
mkdirSync(outRoot, { recursive: true });

for (const [family, entry] of Object.entries(manifest)) {
  const familyDir = join(outRoot, family);
  const versionPath = join(familyDir, ".version");
  const pkgPath = req.resolve(`${entry.package}/package.json`);
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (
    existsSync(versionPath) &&
    readFileSync(versionPath, "utf8").trim() === version
  ) {
    continue;
  }
  mkdirSync(familyDir, { recursive: true });
  for (const weight of entry.weights) {
    const cssSource = req.resolve(`${entry.package}/${weight}.css`);
    copyFileSync(cssSource, join(familyDir, `${weight}.css`));
    const filesSource = join(dirname(cssSource), "files");
    if (existsSync(filesSource)) {
      cpSync(filesSource, join(familyDir, "files"), {
        recursive: true,
        force: true,
      });
    }
  }
  writeFileSync(versionPath, version);
  console.log(`[fonts] ${family}@${version} → ${familyDir}`);
}
