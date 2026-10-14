/**
 * 设计主题包防漂移校验（bun run design:verify）：
 * 以 design-md/ 源目录现值重建打包计划，与已提交的
 * src/design-md/bundle/design-themes.zip 逐条目比对；不一致即退出码 1 并列出
 * 差异（缺条目 / 内容过期 / 多余条目）。改了源忘了重新 design:pack 时，
 * CI 的 `bun run test`（pack-drift 测试）与本地/预构建跑本脚本都会拦下。
 */
import { join, resolve } from "node:path";
import { diffCommittedZip, buildPackPlan } from "./design-themes-lib";

const pkgRoot = resolve(import.meta.dir, "..");

try {
  const plan = await buildPackPlan(join(pkgRoot, "design-md"));
  const zipBytes = new Uint8Array(await Bun.file(join(pkgRoot, "src/design-md/bundle/design-themes.zip")).arrayBuffer());
  const problems = diffCommittedZip(zipBytes, plan);
  if (problems.length > 0) {
    console.error(`design:verify: 主题包与源不一致（v${plan.version}）：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("修复：cd apps/sidecar/pi-agent && bun run design:pack 后提交新 zip");
    process.exit(1);
  }
  console.log(`design:verify: v${plan.version} · ${plan.themeCount} 套 · zip 与源一致`);
} catch (err) {
  console.error(`design:verify: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
