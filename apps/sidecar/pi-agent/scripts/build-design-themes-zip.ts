/**
 * 设计主题包打包（bun run design:pack）：
 *   design-md/catalog-src.json + design-md/<slug>/DESIGN.md × N + LICENSE.txt
 *   → src/design-md/bundle/design-themes.zip（zip 内 catalog.json + <slug>/DESIGN.md + LICENSE.txt）
 *
 * zip 提交进仓库、由 sidecar 以 `import ... with { type: "file" }` 嵌进单文件二进制，
 * 启动时按 catalog.version 与数据目录里 builtin/.manifest.json 比对做版本化重同步
 * （见 src/design-md/builtin-sync.ts）。
 *
 * 约定：改动主题内容或增删主题时必须同步递增 catalog-src.json 的 version，
 * 否则安装端不会触发重解压。校验与条目构建在 design-themes-lib.ts（单一事实源，
 * design:verify 与 pack-drift 测试走同一计划）；打包前先校验，不合法不产出 zip。
 */
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { buildPackPlan } from "./design-themes-lib";

const pkgRoot = resolve(import.meta.dir, "..");
const srcDir = join(pkgRoot, "design-md");
const outFile = join(pkgRoot, "src/design-md/bundle/design-themes.zip");

let plan;
try {
  plan = await buildPackPlan(srcDir);
} catch (err) {
  console.error(`design:pack: ${err instanceof Error ? err.message.replace(/^design-md: /, "") : String(err)}`);
  process.exit(1);
}

const zipped = zipSync(plan.entries, { level: 9 });
await Bun.write(outFile, zipped);

console.log(
  `design:pack: v${plan.version} · ${plan.themeCount} 套 · ${outFile}（${zipped.byteLength} B）`,
);
