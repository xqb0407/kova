import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

type Req = Record<string, unknown>;

let responder: (req: Req) => unknown = (_req) => ({
  type: "sandbox",
  settings: {
    tier: "workspace",
    network: "allow",
    allowPackageCaches: true,
    onUnavailable: "deny",
  },
});
const calls: Req[] = [];

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
  },
}));

afterAll(() => restoreAllMocks());

const {
  SANDBOX_DEFAULT,
  getSandboxSettings,
  initSandboxSettings,
  resetSandboxSettingsForTest,
  saveSandboxSettings,
} = await import("./sandbox");
await new Promise((resolve) => setTimeout(resolve, 0));

describe("sandbox settings mirror", () => {
  test("水合：get_sandbox 真值覆盖发布默认 off", async () => {
    resetSandboxSettingsForTest();
    await initSandboxSettings();
    expect(getSandboxSettings().tier).toBe("workspace");
    expect(calls.some((c) => c.type === "get_sandbox")).toBe(true);
  });

  test("保存：set_sandbox 带整包，镜像以后端回执为准", async () => {
    const next = {
      ...SANDBOX_DEFAULT,
      tier: "workspace" as const,
      network: "deny" as const,
    };
    responder = () => ({ type: "sandbox", settings: next });
    await saveSandboxSettings(next);
    expect(getSandboxSettings()).toEqual(next);
    expect(calls.at(-1)).toEqual({ type: "set_sandbox", settings: next });
  });

  test("保存失败：回滚到上一份并抛出", async () => {
    const before = getSandboxSettings();
    responder = () => new Error("write failed");
    await expect(
      saveSandboxSettings({ ...before, network: "allow" }),
    ).rejects.toThrow("write failed");
    expect(getSandboxSettings()).toEqual(before);
  });
});
