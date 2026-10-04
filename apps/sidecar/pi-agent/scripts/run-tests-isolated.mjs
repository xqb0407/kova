/**
 * 逐文件隔离跑 sidecar 测试套件：每个 *.test.ts 一个独立 bun 进程。
 *
 * 背景：套件里多个文件依赖进程级单例（全局 storage、automation 运行时、
 * process.stdout 钩子、design 主题目录等），合跑时测试文件的执行顺序
 * （APFS/ext4 目录序不同）稍有变化就会互相串状态——本地绿、Linux CI 红
 * 的根因即在此。本地日常开发仍用 `bun run test`（单进程快），CI 用本脚本
 * `bun run test:isolated` 求确定性。
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pkgRoot = resolve(import.meta.dirname, "..");
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(p);
  }
})(join(pkgRoot, "test"));
files.sort();

const failed = [];
for (const f of files) {
  const rel = f.slice(pkgRoot.length + 1);
  // 禁用转译缓存：二进制资产导入（zip）的加载语义在缓存命中异常时会漂
  const r = spawnSync("bun", ["test", rel], {
    cwd: pkgRoot,
    encoding: "utf8",
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  if (r.status === 0) {
    const m = /Ran (\d+) tests?/.exec(r.stdout || "");
    console.log(`PASS ${rel}${m ? ` (${m[1]} tests)` : ""}`);
  } else {
    failed.push(rel);
    console.log(`FAIL ${rel}`);
    console.log((r.stdout || "") + (r.stderr || ""));
  }
}

console.log(`\n${files.length} 个测试文件，${failed.length} 个失败`);
process.exit(failed.length ? 1 : 0);
