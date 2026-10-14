/**
 * 内置插件包防漂移校验（bun run plugins:verify）：以仓库 plugins/ 源现值重建
 * 打包计划，与 src/plugins/bundle/kova-plugins.zip 逐条目比对，不一致退出码 1。
 * zip 不提交仓库（build:sidecar/pretest 现生成），本脚本供发布前手动核验
 * 已产出的 zip 与源一致（builtin-sync 测试走同一 diff 逻辑）。
 */
import { join, resolve } from "node:path";
import { buildPluginPackPlan, diffCommittedPluginZip } from "./builtin-plugins-lib";

const pkgRoot = resolve(import.meta.dir, "..");

try {
  const plan = buildPluginPackPlan(join(pkgRoot, "../../../plugins"));
  const zipPath = join(pkgRoot, "src/plugins/bundle/kova-plugins.zip");
  const zipFile = Bun.file(zipPath);
  if (!(await zipFile.exists())) {
    console.error(`plugins:verify: zip 不存在：${zipPath}（先跑 bun run plugins:pack）`);
    process.exit(1);
  }
  const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
  const problems = diffCommittedPluginZip(zipBytes, plan);
  if (problems.length > 0) {
    console.error(`plugins:verify: 内置插件包与源不一致（${plan.bundleVersion.slice(0, 12)}）：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("修复：cd apps/sidecar/pi-agent && bun run plugins:pack");
    process.exit(1);
  }
  console.log(`plugins:verify: ${plan.bundleVersion.slice(0, 12)} · ${plan.plugins.length} 个 · zip 与源一致`);
} catch (err) {
  console.error(`plugins:verify: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
