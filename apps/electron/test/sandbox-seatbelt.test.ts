import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPlan, DEFAULT_SANDBOX_CONFIG, realResolve } from "pi-sandbox";
import { buildSeatbeltProfile, isSeatbeltAvailable } from "../main/sandbox/seatbelt";

const darwin = process.platform === "darwin" && isSeatbeltAvailable();
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return realResolve(dir);
}

function run(profile: string, script: string, cwd: string, env: Record<string, string>) {
  return spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/bash", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

if (darwin) {
  describe("Seatbelt workspace profile", () => {
  function fixture() {
    const workspace = tempDir("sandbox-ws-");
    const outside = tempDir("sandbox-out-");
    const home = tempDir("sandbox-home-");
    const tempRoot = tempDir("sandbox-tmp-");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "secret"), "secret");
    writeFileSync(join(outside, "keep.txt"), "keep");
    const plan = buildSandboxPlan({
      cwd: workspace,
      tempRoot,
      homeDir: home,
      config: {
        ...DEFAULT_SANDBOX_CONFIG,
        tier: "workspace",
        allowPackageCaches: false,
      },
      pathExists: () => false,
    })!;
    return { workspace, outside, home, tempRoot, plan, profile: buildSeatbeltProfile(plan) };
  }

  test("工作区内写成功", () => {
    const { workspace, plan, profile } = fixture();
    const r = run(profile, 'printf ok > "$WS/in.txt"', workspace, { WS: workspace });
    expect(r.status).toBe(0);
    expect(existsSync(join(workspace, "in.txt"))).toBe(true);
    expect(plan.writeRoots).toContain(workspace);
  });

  test("工作区外写失败，文件不存在", () => {
    const { workspace, outside, profile } = fixture();
    const r = run(profile, 'printf bad > "$OUT/out.txt"', workspace, { OUT: outside });
    expect(r.status === 0).toBe(false);
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
  });

  test("子进程继承沙箱", () => {
    const { workspace, outside, profile } = fixture();
    const r = run(
      profile,
      '/bin/sh -c "printf bad > \\"$OUT/child.txt\\""',
      workspace,
      { OUT: outside },
    );
    expect(r.status === 0).toBe(false);
    expect(existsSync(join(outside, "child.txt"))).toBe(false);
  });

  test("高危凭据目录读取失败", () => {
    const { workspace, home, profile } = fixture();
    const r = run(profile, 'cat "$HOME/.ssh/secret"', workspace, { HOME: home });
    expect(r.status === 0).toBe(false);
  });

  test("/dev/null 与临时目录写仍可用", () => {
    const { workspace, tempRoot, profile } = fixture();
    const r = run(
      profile,
      'printf x > /dev/null && printf ok > "$TMP/t.txt" && printf ok > "$WS/n.txt"',
      workspace,
      { TMP: tempRoot, WS: workspace },
    );
    expect(r.status).toBe(0);
    expect(existsSync(join(tempRoot, "t.txt"))).toBe(true);
  });

  test("授权清单即使在工作区内也不可写", () => {
    const { workspace, profile } = fixture();
    mkdirSync(join(workspace, ".kova"), { recursive: true });
    const perms = join(workspace, ".kova", "permissions.local.json");
    writeFileSync(perms, '{"writeRoots":[]}');
    const r = run(profile, 'printf bad > "$WS/.kova/permissions.local.json"', workspace, {
      WS: workspace,
    });
    expect(r.status === 0).toBe(false);
    expect(readFileSync(perms, "utf8")).toBe('{"writeRoots":[]}');
  });

  test("路径含空格也能写", () => {
    const { workspace, profile } = fixture();
    const spaced = join(workspace, "has space");
    mkdirSync(spaced);
    const r = run(profile, 'printf ok > "$WS/has space/f.txt"', workspace, { WS: workspace });
    expect(r.status).toBe(0);
    expect(existsSync(join(spaced, "f.txt"))).toBe(true);
  });

  test("sandbox-exec 启动后仍能按进程组杀整棵树", async () => {
    const { workspace, profile } = fixture();
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/bash", "-c", "sleep 30"],
      { cwd: workspace, detached: true, stdio: "ignore" },
    );
    const pid = child.pid ?? 0;
    expect(pid >= 1).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(-pid, "SIGKILL");
    const signal = await new Promise<string | null>((resolve) => {
      child.once("exit", (_code, sig) => resolve(sig));
    });
    expect(signal).toBe("SIGKILL");
  });

  test("network: deny 阻断联网", () => {
    const { workspace, plan } = fixture();
    const denied = buildSeatbeltProfile({ ...plan, network: "deny" });
    const r = run(
      denied,
      'nc -z -w 2 1.1.1.1 53',
      workspace,
      {},
    );
    expect(r.status === 0).toBe(false);
  });
  });
}
