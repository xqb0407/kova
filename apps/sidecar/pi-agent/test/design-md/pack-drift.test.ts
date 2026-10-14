import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { buildPackPlan, diffCommittedZip } from "../../scripts/design-themes-lib";

/**
 * 主题包防漂移（修复 9）：src/design-md/bundle/design-themes.zip 是随二进制
 * 分发的内置主题事实源；改了 design-md/ 源却忘跑 design:pack 时，这里的
 * 逐条目比对会失败（CI test job 的 `bun run test` 与本地套件同拦）。
 * 修复方式：cd apps/sidecar/pi-agent && bun run design:pack 后提交新 zip。
 */

const pkgRoot = resolve(import.meta.dir, "../..");

describe("design-themes.zip 与源目录一致性", () => {
  test("committed zip 每个条目都与源重建计划逐字节一致", async () => {
    const plan = await buildPackPlan(join(pkgRoot, "design-md"));
    const zipFile = Bun.file(join(pkgRoot, "src/design-md/bundle/design-themes.zip"));
    expect(await zipFile.exists()).toBe(true);
    const zipBytes = new Uint8Array(await zipFile.arrayBuffer());
    const problems = diffCommittedZip(zipBytes, plan);
    expect(problems).toEqual([]);
  });

  test("diff 能识别内容过期与多余/缺失条目（自造小计划验证哨兵本身有效）", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const { zipSync } = await import("fflate");
    const plan = {
      version: "9.9.9",
      themeCount: 1,
      entries: { "a/DESIGN.md": enc("new"), "catalog.json": enc("{}\n") },
    };
    const stale = zipSync({ "a/DESIGN.md": enc("old"), "catalog.json": enc("{}\n"), "ghost/DESIGN.md": enc("x") });
    const problems = diffCommittedZip(stale, plan);
    expect(problems).toContain("内容过期 a/DESIGN.md");
    expect(problems).toContain("多余条目 ghost/DESIGN.md");
    const missing = zipSync({ "catalog.json": enc("{}\n") });
    expect(diffCommittedZip(missing, plan)).toContain("缺条目 a/DESIGN.md");
  });
});
