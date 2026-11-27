/** 内置官方市场（kova-plugins main）：登记记录形状、幂等与不可移除。 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_MKT_BRANCH,
  BUILTIN_MKT_ID,
  BUILTIN_MKT_REPO,
  ensureBuiltinMarketplaceRecord,
  marketplaceIdFor,
  readMarketplaceRecords,
} from "../../src/plugins/registry";
import { removeMarketplace } from "../../src/plugins/marketplaces";

describe("内置官方市场", () => {
  const prevPluginsDir = process.env.PI_PLUGINS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "kova-builtin-market-"));

  beforeAll(() => {
    process.env.PI_PLUGINS_DIR = dir;
  });

  afterAll(() => {
    if (prevPluginsDir === undefined) delete process.env.PI_PLUGINS_DIR;
    else process.env.PI_PLUGINS_DIR = prevPluginsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("登记记录固定 kova-plugins main，重复调用幂等", () => {
    ensureBuiltinMarketplaceRecord();
    ensureBuiltinMarketplaceRecord();
    const records = readMarketplaceRecords();
    const builtin = records.filter((r) => r.id === BUILTIN_MKT_ID);
    expect(builtin).toHaveLength(1);
    expect(builtin[0]).toMatchObject({
      id: marketplaceIdFor("git", BUILTIN_MKT_REPO),
      name: "内置市场",
      type: "git",
      repo: BUILTIN_MKT_REPO,
      branch: "main",
      builtin: true,
    });
    expect(BUILTIN_MKT_BRANCH).toBe("main");
  });

  test("内置市场不可移除", () => {
    expect(() => removeMarketplace(BUILTIN_MKT_ID)).toThrow(/不可移除/);
  });
});
