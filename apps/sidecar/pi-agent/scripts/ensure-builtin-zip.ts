/**
 * 内置插件包 zip 自愈：src/plugins/bundle/kova-plugins.zip 为构建产物
 * （gitignore 不入库），sidecar 源码 import 它（dev/smoke/test 都会在模块
 * 加载期读盘）。存在则直接通过（是否与 plugins/ 源一致交给 pack-drift 测试）；
 * 缺失则先确保插件面板 HTML 在位（跑根 scripts/build-plugins.mjs，幂等），
 * 再 plugins:pack 重打。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgRoot, "../../..");
const zipPath = join(pkgRoot, "src/plugins/bundle/kova-plugins.zip");

if (!existsSync(zipPath)) {
  const build = Bun.spawnSync(["bun", "run", "build:plugins"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  const pack = Bun.spawnSync(["bun", "run", "scripts/build-builtin-plugins-zip.ts"], {
    cwd: pkgRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (pack.exitCode !== 0) process.exit(pack.exitCode ?? 1);
}
