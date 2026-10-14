#!/usr/bin/env bun
/**
 * mock 卫生守卫（点 3 长期化）：
 * bun test 同进程内 mock.module 会跨文件泄漏，且 bun 1.3.14 的 restore() 对
 * tsconfig 别名模块不可靠（见 lib/testing/mock-module.ts 注释）——泄漏只能靠
 * 纪律防：测试文件禁止裸调 mock.module()，必须经 mockModule() 包装并注册
 * afterAll(restoreAllMocks) 回滚。此脚本把这条例定成可执行检查。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.test\.tsx?$/.test(e)) files.push(p);
  }
})("lib");

let bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/mock\.module\(/.test(lines[i])) {
      console.log(
        `${f}:${i + 1} 裸用 mock.module() —— 改用 lib/testing/mock-module 的 mockModule()` +
          `（含 afterAll 回滚；别名模块 restore 不可靠，消费方需自锚边界）`,
      );
      bad++;
    }
  }
  if (src.includes("mockModule(") && !/afterAll[\s\S]*?restoreAllMocks/.test(src)) {
    console.log(`${f} 使用 mockModule 但未注册 afterAll(restoreAllMocks) 回滚`);
    bad++;
  }
}
if (bad === 0) {
  console.log(`mock 卫生检查通过（${files.length} 个测试文件）`);
} else {
  console.error(`mock 卫生检查失败：${bad} 处`);
  process.exit(1);
}
