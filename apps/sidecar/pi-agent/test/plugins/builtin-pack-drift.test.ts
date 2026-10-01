import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";

import { buildPluginPackPlan, diffCommittedPluginZip, type PluginPackPlan } from "../../scripts/builtin-plugins-lib";

/**
 * 内置插件包防漂移：src/plugins/bundle/kova-plugins.zip 提交进仓库、嵌进单文件
 * 二进制，是随 app 分发的内置插件事实源。改了仓库 plugins/ 源却忘跑
 * `bun run plugins:pack` 时，这里的逐条目比对会失败（与 design-md 的
 * pack-drift 同族，CI test job 的 `bun run test` 与本地套件同拦）。
 * 修复：cd apps/sidecar/pi-agent && bun run plugins:pack 后提交新 zip。
 */

const pkgRoot = resolve(import.meta.dir, "../..");

describe("kova-plugins.zip 与 plugins/ 源目录一致性", () => {
  test("committed zip 每个条目都与源重建计划逐字节一致", async () => {
    const plan = buildPluginPackPlan(resolve(pkgRoot, "../../../plugins"));
    const zipFile = Bun.file(join(pkgRoot, "src/plugins/bundle/kova-plugins.zip"));
    expect(await zipFile.exists()).toBe(true);
    const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
    const problems = diffCommittedPluginZip(zipBytes, plan);
    expect(problems).toEqual([]);
  });

  test("diff 能识别内容过期与多余/缺失条目（哨兵本身有效）", () => {
    const plan = {
      bundleVersion: "9.9.9",
      plugins: [{ name: "a", version: "1.0.0" }],
      entries: { "a/x.md": strToU8("new"), "catalog.json": strToU8("{}\n") },
    } satisfies PluginPackPlan;
    const drifted = zipSync({
      "a/x.md": strToU8("old"),
      "catalog.json": strToU8("{}\n"),
      "ghost/y.md": strToU8("x"),
    });
    const problems = diffCommittedPluginZip(drifted, plan);
    expect(problems).toContain("内容过期：a/x.md");
    expect(problems).toContain("多余条目：ghost/y.md");
    const missing = zipSync({ "catalog.json": strToU8("{}\n") });
    expect(diffCommittedPluginZip(missing, plan)).toContain("缺条目：a/x.md");
  });
});
