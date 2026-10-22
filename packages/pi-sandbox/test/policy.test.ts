import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxPlan,
  DEFAULT_SANDBOX_CONFIG,
  normalizeSandboxConfig,
  planAllowsRead,
  planAllowsWrite,
  realResolve,
  writeDeniedMessage,
} from "../src";

const WORKSPACE_CONFIG = {
  ...DEFAULT_SANDBOX_CONFIG,
  tier: "workspace" as const,
  allowPackageCaches: false,
};

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return realResolve(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeSandboxConfig", () => {
  test("默认是 off + allow + 缓存开启 + 不可用拒绝", () => {
    expect(normalizeSandboxConfig(undefined)).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(normalizeSandboxConfig({})).toEqual(DEFAULT_SANDBOX_CONFIG);
  });

  test("非法值回落到默认，合法值保留", () => {
    const cfg = normalizeSandboxConfig({
      tier: "off",
      network: "deny",
      allowPackageCaches: false,
      onUnavailable: "allow",
    });
    expect(cfg).toEqual({
      tier: "off",
      network: "deny",
      allowPackageCaches: false,
      onUnavailable: "allow",
    });
    expect(
      normalizeSandboxConfig({
        tier: "strict",
        network: "nope",
        allowPackageCaches: "yes",
        onUnavailable: "maybe",
      }),
    ).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});

describe("buildSandboxPlan", () => {
  test("off 不生成计划", () => {
    const cwd = tempDir("pi-sandbox-off-");
    expect(
      buildSandboxPlan({
        cwd,
        tempRoot: cwd,
        config: { ...DEFAULT_SANDBOX_CONFIG, tier: "off" },
        homeDir: cwd,
      }),
    ).toBeNull();
  });

  test("workspace 计划包含 cwd / 外部目录 / write roots / 临时目录", () => {
    const cwd = tempDir("pi-sandbox-cwd-");
    const external = tempDir("pi-sandbox-ext-");
    const writeRoot = tempDir("pi-sandbox-root-");
    const tempRoot = tempDir("pi-sandbox-tmp-");
    const home = tempDir("pi-sandbox-home-");

    const plan = buildSandboxPlan({
      cwd,
      externalDirs: [external],
      writeRoots: [writeRoot],
      tempRoot,
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        tier: "workspace",
        allowPackageCaches: false,
      },
      homeDir: home,
      pathExists: () => false,
    });

    expect(plan).not.toBeNull();
    expect(plan!.tier).toBe("workspace");
    expect(plan!.writeRoots).toContain(cwd);
    expect(plan!.writeRoots).toContain(external);
    expect(plan!.writeRoots).toContain(writeRoot);
    expect(plan!.writeRoots).toContain(tempRoot);
    expect(plan!.tempRoots).toEqual([tempRoot]);
    expect(plan!.cacheRoots).toEqual([]);
    expect(plan!.denyReadRoots).toContain(join(home, ".ssh"));
    expect(plan!.denyReadRoots).toContain(join(home, ".aws"));
    expect(plan!.denyWritePaths).toContain(
      join(cwd, ".kova", "permissions.local.json"),
    );
  });

  test("包缓存开启时只收存在的目录", () => {
    const cwd = tempDir("pi-sandbox-cache-");
    const plan = buildSandboxPlan({
      cwd,
      tempRoot: cwd,
      homeDir: cwd,
      config: { ...WORKSPACE_CONFIG, allowPackageCaches: true },
      pathExists: (path) => path.endsWith(".npm"),
    });
    expect(plan!.cacheRoots).toEqual([join(cwd, ".npm")]);
    expect(plan!.writeRoots).toContain(join(cwd, ".npm"));
  });
});

describe("planAllowsWrite / planAllowsRead", () => {
  test("工作区内允许，工作区外拒绝，.. 不能绕过", () => {
    const cwd = tempDir("pi-sandbox-write-");
    const outside = tempDir("pi-sandbox-out-");
    const plan = buildSandboxPlan({
      cwd,
      tempRoot: cwd,
      homeDir: cwd,
      config: WORKSPACE_CONFIG,
      pathExists: () => false,
    })!;

    expect(planAllowsWrite(plan, join(cwd, "a.ts"))).toBe(true);
    expect(planAllowsWrite(plan, join(cwd, "nested", "a.ts"))).toBe(true);
    expect(planAllowsWrite(plan, join(outside, "a.ts"))).toBe(false);
    expect(planAllowsWrite(plan, join(cwd, "..", "elsewhere", "a.ts"))).toBe(false);
  });

  test("写根超过 128 条时截断，不生成失控的 profile", () => {
    const cwd = tempDir("pi-sandbox-max-");
    const home = tempDir("pi-sandbox-max-home-");
    // 造 200 条授权根
    const roots: string[] = [];
    for (let i = 0; i < 200; i += 1) roots.push(join(home, `root-${String(i).padStart(3, "0")}`));
    const plan = buildSandboxPlan({
      cwd,
      tempRoot: cwd,
      homeDir: home,
      writeRoots: roots,
      config: WORKSPACE_CONFIG,
      pathExists: () => false,
    })!;
    expect(plan.writeRoots.length).toBeLessThanOrEqual(128);
    // cwd / 临时目录必须保留在前段（授权目录优先于缓存根被截）
    expect(plan.writeRoots).toContain(cwd);
  });

  test("授权清单本身不可写，即使它在工作区里", () => {
    const cwd = tempDir("pi-sandbox-perms-");
    const plan = buildSandboxPlan({
      cwd,
      tempRoot: cwd,
      homeDir: cwd,
      config: WORKSPACE_CONFIG,
      pathExists: () => false,
    })!;
    expect(planAllowsWrite(plan, join(cwd, ".kova", "permissions.local.json"))).toBe(
      false,
    );
    expect(planAllowsWrite(plan, join(cwd, ".kova", "permissions.json"))).toBe(false);
    expect(planAllowsWrite(plan, join(cwd, ".kova", "other.json"))).toBe(true);
  });

  if (process.platform !== "win32") {
    test("符号链接逃逸会被 realResolve 拦住", () => {
      const cwd = tempDir("pi-sandbox-link-");
      const outside = tempDir("pi-sandbox-link-out-");
      writeFileSync(join(outside, "secret.txt"), "secret");
      mkdirSync(join(cwd, "link-parent"));
      symlinkSync(outside, join(cwd, "link-parent", "escape"));

      const plan = buildSandboxPlan({
        cwd,
        tempRoot: cwd,
        homeDir: cwd,
        config: WORKSPACE_CONFIG,
        pathExists: () => false,
      })!;

      expect(planAllowsWrite(plan, join(cwd, "link-parent", "escape", "secret.txt"))).toBe(
        false,
      );
    });
  }

  test("高危读取目录被拒绝，普通工作区文件放行", () => {
    const cwd = tempDir("pi-sandbox-read-");
    const home = tempDir("pi-sandbox-read-home-");
    mkdirSync(join(home, ".ssh"));
    const plan = buildSandboxPlan({
      cwd,
      tempRoot: cwd,
      homeDir: home,
      config: WORKSPACE_CONFIG,
      pathExists: () => false,
    })!;

    expect(planAllowsRead(plan, join(cwd, "a.ts"))).toBe(true);
    expect(planAllowsRead(plan, join(home, ".ssh", "id_rsa"))).toBe(false);
    expect(planAllowsRead(plan, join(home, ".aws", "credentials"))).toBe(false);
  });

  test("拒绝文案包含目标路径和允许根", () => {
    const cwd = tempDir("pi-sandbox-msg-");
    const plan = buildSandboxPlan({
      cwd,
      tempRoot: cwd,
      homeDir: cwd,
      config: WORKSPACE_CONFIG,
      pathExists: () => false,
    })!;
    const target = join(cwd, "..", "outside.ts");
    const message = writeDeniedMessage(plan, target);
    expect(message).toContain(target);
    expect(message).toContain(cwd);
  });
});
