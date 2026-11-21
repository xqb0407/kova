#!/usr/bin/env node
/**
 * 版本审计：root / apps/desktop / apps/electron 三处 version 必须一致。
 * 打包权威源是 apps/electron（electron-builder 从它读 version）；
 * 三处由 scripts/release.mjs 发版时同步，日常改动不应触碰版本字段。
 *
 * 用法：
 *   node scripts/check-versions.mjs          # 校验，不一致非零退出
 *   node scripts/check-versions.mjs --fix    # 以 apps/electron 为准回写其余两处
 */
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "apps/electron/package.json",
  "package.json",
  "apps/desktop/package.json",
];
const versions = files.map((f) => JSON.parse(readFileSync(f, "utf8")).version);
const fix = process.argv.includes("--fix");

const mismatched = files.filter((f, i) => versions[i] !== versions[0]);
if (mismatched.length === 0) {
  console.log(`✓ 版本一致：${versions[0]}（root / desktop / electron 三处同步）`);
  process.exit(0);
}

console.error(
  `✗ 版本不一致：${files.map((f, i) => `${f}=${versions[i]}`).join(", ")}`,
);

if (fix) {
  const target = versions[0];
  for (const f of files) {
    if (JSON.parse(readFileSync(f, "utf8")).version !== target) {
      const pkg = JSON.parse(readFileSync(f, "utf8"));
      pkg.version = target;
      writeFileSync(f, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`  已回写 ${f} → ${target}`);
    }
  }
  console.log(`✓ 已以 apps/electron 为准修复，请 review 后提交`);
  process.exit(0);
}

console.error(`  修复：node scripts/check-versions.mjs --fix（以 apps/electron 为准回写）`);
process.exit(1);
