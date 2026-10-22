import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SANDBOX_CONFIG } from "pi-sandbox";
import {
  getSandboxConfig,
  initSandboxConfig,
  resetSandboxConfigForTest,
  setSandboxConfig,
} from "../../src/permissions/sandbox-config";
import { initLocalStorage } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-sandbox-config-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

describe("sandbox config", () => {
  test("默认值来自 pi-sandbox", async () => {
    resetSandboxConfigForTest();
    await initSandboxConfig();
    expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
  });

  test("set 归一化并回读", async () => {
    resetSandboxConfigForTest();
    await setSandboxConfig({
      tier: "off",
      network: "deny",
      allowPackageCaches: false,
      onUnavailable: "allow",
    });
    expect(getSandboxConfig()).toEqual({
      tier: "off",
      network: "deny",
      allowPackageCaches: false,
      onUnavailable: "allow",
    });
  });

  test("非法值回落到默认", async () => {
    resetSandboxConfigForTest();
    await setSandboxConfig({
      tier: "strict",
      network: "nope",
      allowPackageCaches: "yes",
      onUnavailable: "maybe",
    });
    expect(getSandboxConfig()).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});
