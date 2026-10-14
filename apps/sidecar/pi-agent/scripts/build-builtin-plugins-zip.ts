/**
 * 内置插件包打包（bun run plugins:pack，build:sidecar 与 pretest 自动执行）：
 *   仓库 plugins/（marketplace.json 白名单）→ src/plugins/bundle/kova-plugins.zip
 *
 * zip 由 sidecar `import ... with { type: "file" }` 嵌进单文件二进制；产物是
 * 源目录的纯函数（bundleVersion = 内容聚合 hash，条目按名序），**提交进仓库**
 * （同 design-themes.zip 先例）；源改动后须重新打包并提交，漂移由测试拦截。
 * 校验与条目收集规则见 builtin-plugins-lib.ts（单一事实源，plugins:verify 同款）。
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { zipSync } from "fflate";
import { buildPluginPackPlan } from "./builtin-plugins-lib";

const pkgRoot = resolve(import.meta.dir, "..");
const srcDir = join(pkgRoot, "../../../plugins");
const outFile = join(pkgRoot, "src/plugins/bundle/kova-plugins.zip");

let plan;
try {
  plan = buildPluginPackPlan(srcDir);
} catch (err) {
  console.error(`plugins:pack: ${err instanceof Error ? err.message.replace(/^plugins-pack: /, "") : String(err)}`);
  process.exit(1);
}

const zipped = zipSync(plan.entries, { level: 6 });
mkdirSync(dirname(outFile), { recursive: true });
await Bun.write(outFile, zipped);

console.log(
  `plugins:pack: ${plan.bundleVersion.slice(0, 12)} · ${plan.plugins.length} 个（${plan.plugins.map((p) => `${p.name}@${p.version}`).join(", ")}）· ${outFile}（${zipped.byteLength} B）`,
);
