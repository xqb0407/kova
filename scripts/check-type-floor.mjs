#!/usr/bin/env node
/**
 * 小字号守卫：中文 UI 文本不低于 12px。
 *
 * Windows 上 9–11px 的中文（尤其微软雅黑）会粘连、断笔；本脚本扫描
 * apps/desktop 的 TSX，若 `text-[9px]` / `text-[10px]` / `text-[11px]`
 * 附近出现中文文本节点，则报错。纯 Latin / 数字 / 等宽元信息可以继续用
 * 10–11px（用 text-3xs 表达）。
 *
 * 忽略 dev-preview（字体验收页需要展示小字号样本）。
 *
 * 用法：node scripts/check-type-floor.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanRoot = join(root, "apps", "desktop");
const SMALL = /text-\[(?:9|10|11)px\]/;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "out" || name === ".next") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "dev-preview") continue;
      yield* walk(path);
    } else if (name.endsWith(".tsx")) {
      yield path;
    }
  }
}

/** 去掉行内注释，避免把中文注释误判成界面文案 */
function stripComments(line) {
  return line.replace(/\{\/\*.*?\*\/\}/g, "").replace(/\/\/.*$/, "");
}

const findings = [];

for (const file of walk(scanRoot)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SMALL);
    if (!match) continue;

    // 查看当前行 + 后 4 行：JSX 文本通常在标签下一行
    const window = lines
      .slice(i, i + 5)
      .map(stripComments)
      .join("\n");
    // 只认「标签结束后的文本节点」：> 与 < 之间，或纯文本行
    const textNodes = window.match(/>([^<>{}]*[\u3400-\u9fff][^<>{}]*)</g);
    const bareText = window
      .split("\n")
      .some((line) => CJK.test(line) && !/[{}<>]/.test(line));
    if (textNodes?.length || bareText) {
      findings.push({
        file: relative(root, file),
        line: i + 1,
        snippet: lines[i].trim(),
      });
    }
  }
}

if (findings.length === 0) {
  console.log("[type-floor] 通过：没有发现 <12px 的中文界面文本");
} else {
  console.error(
    `[type-floor] 发现 ${findings.length} 处 <12px 的中文文本（中文下限为 12px，请改用 text-2xs）：`,
  );
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}`);
    console.error(`    ${finding.snippet}`);
  }
  process.exitCode = 1;
}
