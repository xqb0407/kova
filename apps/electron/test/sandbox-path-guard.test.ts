import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPlan, DEFAULT_SANDBOX_CONFIG, realResolve } from "pi-sandbox";
import {
  assertNetworkAllowed,
  assertReadAllowed,
  assertWriteAllowed,
  sandboxInfo,
} from "../main/sandbox/path-guard";
import {
  resolveBackend,
  sandboxEnvOverrides,
  wrapSandboxCommand,
} from "../main/sandbox";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return realResolve(dir);
}

function expectNoThrow(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    throw new Error(
      `expected no throw, got: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(overrides: Partial<Parameters<typeof buildSandboxPlan>[0]> = {}) {
  const cwd = tempDir("sandbox-guard-");
  const outside = tempDir("sandbox-guard-out-");
  const home = tempDir("sandbox-guard-home-");
  const plan = buildSandboxPlan({
    cwd,
    tempRoot: cwd,
    homeDir: home,
    config: {
      ...DEFAULT_SANDBOX_CONFIG,
      tier: "workspace",
      allowPackageCaches: false,
    },
    pathExists: () => false,
    ...overrides,
  })!;
  return { cwd, outside, home, plan };
}

describe("assertWriteAllowed", () => {
  test("工作区内放行，工作区外抛错并带路径与允许根", () => {
    const { cwd, outside, plan } = fixture();
    expectNoThrow(() => assertWriteAllowed(plan, cwd, "src/a.ts"));

    let message = "";
    try {
      assertWriteAllowed(plan, cwd, join(outside, "a.ts"));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("write denied");
    expect(message).toContain(join(outside, "a.ts"));
    expect(message).toContain(cwd);
  });

  test("授权清单即使在工作区内也拒绝", () => {
    const { cwd, plan } = fixture();
    expect(() =>
      assertWriteAllowed(plan, cwd, join(cwd, ".kova", "permissions.local.json")),
    ).toThrow(/write denied/);
  });

  if (process.platform !== "win32") {
    test("符号链接逃逸被拒绝", () => {
      const { cwd, outside, plan } = fixture();
      writeFileSync(join(outside, "secret.txt"), "x");
      mkdirSync(join(cwd, "link-parent"));
      symlinkSync(outside, join(cwd, "link-parent", "escape"));
      expect(() =>
        assertWriteAllowed(plan, cwd, join(cwd, "link-parent", "escape", "secret.txt")),
      ).toThrow(/write denied/);
    });
  }

  test("没有计划时不做限制（tier=off）", () => {
    const { cwd, outside } = fixture();
    expectNoThrow(() => assertWriteAllowed(undefined, cwd, join(outside, "a.ts")));
  });
});

describe("assertReadAllowed", () => {
  test("高危凭据目录拒绝，普通文件放行", () => {
    const { cwd, home, plan } = fixture();
    expectNoThrow(() => assertReadAllowed(plan, cwd, "src/a.ts"));
    expect(() => assertReadAllowed(plan, cwd, join(home, ".ssh", "id_rsa"))).toThrow(
      /read denied/,
    );
  });
});

describe("sandboxEnvOverrides", () => {
  test("seatbelt 时 TMPDIR 指向计划临时目录，其他后端不动", () => {
    const { cwd, plan } = fixture();
    expect(sandboxEnvOverrides(plan, "seatbelt")).toEqual({
      TMPDIR: cwd,
      TMP: cwd,
      TEMP: cwd,
    });
    expect(sandboxEnvOverrides(plan, "none")).toEqual({});
    expect(sandboxEnvOverrides(undefined, "seatbelt")).toEqual({});
  });
});

describe("sandboxInfo", () => {
  test("把 denied 标记带进工具结果（badge 用）", () => {
    const { plan } = fixture();
    expect(sandboxInfo(plan, "seatbelt", "write")).toEqual({
      tier: "workspace",
      backend: "seatbelt",
      network: "allow",
      denied: "write",
    });
  });
});

describe("backend selection", () => {
  test("win32 明确没有 OS 后端，bash 走原路径", () => {
    const { plan } = fixture();
    const win = { ...plan, platform: "win32" as const };
    expect(resolveBackend(win)).toBe("none");
    expect(wrapSandboxCommand("echo hi", win)).toBeNull();
    expect(sandboxEnvOverrides(win, "none")).toEqual({});
  });
});

describe("assertNetworkAllowed", () => {
  test("network=deny 抛错，allow 放行", () => {
    const { cwd, plan } = fixture();
    expectNoThrow(() => assertNetworkAllowed(plan));
    expect(() =>
      assertNetworkAllowed({ ...plan, network: "deny" }),
    ).toThrow(/network disabled/);
  });
});
