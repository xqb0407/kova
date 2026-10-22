/**
 * 沙箱端到端：sidecar 的 buildTools 组装信封（含闭包生成的 SandboxPlan）→
 * 宿主 handleTool 裁决并执行 → 结果带回 sandbox 信息。两侧用同一个
 * pi-sandbox 编译计划，模拟真实运行但不起 Electron/sidecar 进程。
 *
 * 模拟宿主：setTransport 把 host_query 的 "tool" kind 直接转发给
 * apps/electron 的 handleTool（真实代码路径，含 parseSandboxPlan、
 * path-guard、Seatbelt 包装）；其余 kind 报错（e2e 不触库）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxPlan,
  DEFAULT_SANDBOX_CONFIG,
  realResolve,
  type SandboxPlan,
} from "pi-sandbox";
import { buildTools } from "../../src/tools/tools";
import { setTransport, type RpcOptions } from "../../src/storage/hostdb/transport";
import { resetSandboxConfigForTest, setSandboxConfig } from "../../src/permissions/sandbox-config";

const dirs: string[] = [];
const seatbelt = process.platform === "darwin";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return realResolve(dir);
}

let toolCalls: { name: string; params: Record<string, unknown> }[] = [];
let planOverride: SandboxPlan | null | undefined;
let currentPlan: SandboxPlan | null;

/** 真宿主 handleTool：host_query 的 tool kind 走这条真实代码路径 */
async function hostTool(kind: string, params: Record<string, unknown>, _opts?: RpcOptions) {
  if (kind !== "tool") throw new Error(`e2e transport only handles kind=tool, got ${kind}`);
  toolCalls.push({ name: String(params.name), params });
  const { handleTool } = await import(
    "../../../../electron/main/tool-exec"
  );
  return handleTool(`e2e-${toolCalls.length}`, params);
}

const fixtures: { cwd: string; outside: string; home: string; tempRoot: string }[] = [];

function fixture() {
  const cwd = tempDir("e2e-sb-ws-");
  const outside = tempDir("e2e-sb-out-");
  const home = tempDir("e2e-sb-home-");
  const tempRoot = tempDir("e2e-sb-tmp-");
  mkdirSync(join(home, ".ssh"));
  const plan = buildSandboxPlan({
    cwd,
    tempRoot,
    homeDir: home,
    config: { ...DEFAULT_SANDBOX_CONFIG, tier: "workspace", allowPackageCaches: false },
    platform: process.platform,
    pathExists: () => false,
  })!;
  currentPlan = plan;
  const f = { cwd, outside, home, tempRoot };
  fixtures.push(f);
  return { ...f, plan };
}

beforeAll(() => {
  setTransport((kind, params, opts) => {
    if (planOverride !== undefined) currentPlan = planOverride;
    return hostTool(kind, params, opts);
  });
  resetSandboxConfigForTest();
});

function build(cwd: string) {
  return buildTools(
    cwd,
    "e2e-thread",
    () => null,
    undefined,
    undefined,
    () => "workspace-write" as const,
    undefined,
    () => "agent" as const,
    () => [],
    () => currentPlan,
  );
}

const toolOf = (tools: ReturnType<typeof buildTools>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
};

describe("sandbox e2e: sidecar tools → host handleTool", () => {
  test("bash 在工作区内成功执行，结果带 sandbox 信息", async () => {
    const { cwd } = fixture();
    const bash = toolOf(build(cwd), "bash");
    const res = await bash.execute("t1", { command: "printf ok-sandbox-e2e" });
    const text = (res as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("ok-sandbox-e2e");
    const details = (res as { details?: { sandbox?: { backend: string } } }).details;
    if (seatbelt) expect(details?.sandbox?.backend).toBe("seatbelt");
  });

  test("bash 越界写被 Seatbelt 拒绝，输出带 sandbox 提示", async () => {
    if (!seatbelt) return;
    const { cwd, outside } = fixture();
    const bash = toolOf(build(cwd), "bash");
    const target = join(outside, "e2e-out.txt");
    const res = await bash.execute("t2", { command: `printf bad > ${JSON.stringify(target)}` });
    const text = (res as { content: { text: string }[] }).content[0].text;
    expect(text).not.toContain("bad");
    expect(existsSync(target)).toBe(false);
    const details = (res as { details?: { sandbox?: { denied?: string } } }).details;
    expect(details?.sandbox?.denied).toBe("write");
  });

  test("write 工作区外被 sidecar 预检拦截，宿主没收到调用", async () => {
    const { cwd, outside } = fixture();
    const tools = build(cwd);
    const write = toolOf(tools, "write");
    const target = join(outside, "e2e-pre.txt");
    await expect(
      write.execute("t3", { file_path: target, content: "x" }),
    ).rejects.toThrow(/write denied/);
    expect(toolCalls.every((c) => c.name !== "write")).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  test("write 工作区内成功落盘", async () => {
    const { cwd } = fixture();
    const write = toolOf(build(cwd), "write");
    const target = join(cwd, "e2e-in.txt");
    const res = await write.execute("t4", { file_path: target, content: "hello" });
    expect((res as { content: { text: string }[] }).content[0].text).toContain("Wrote");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("read 高危凭据目录被宿主拒绝", async () => {
    const { cwd, home } = fixture();
    writeFileSync(join(home, ".ssh", "id_rsa"), "secret");
    const read = toolOf(build(cwd), "read");
    await expect(
      read.execute("t5", { file_path: join(home, ".ssh", "id_rsa") }),
    ).rejects.toThrow(/read denied/);
  });

  test("read 工作区文件成功且 stale 守卫仍工作", async () => {
    const { cwd } = fixture();
    const tools = build(cwd);
    const read = toolOf(tools, "read");
    const target = join(cwd, "e2e-read.txt");
    writeFileSync(target, "v1");
    await read.execute("t6", { file_path: target });
    // 外部修改后不重读直接编辑 → stale 守卫拒绝（沙箱与既有守卫正交）
    writeFileSync(target, "v2");
    const edit = toolOf(tools, "edit");
    await expect(
      edit.execute("t7", { file_path: target, old_string: "v2", new_string: "v3" }),
    ).rejects.toThrow(/changed since you last read/);
  });

  test("tier=off 时同一调用放行到工作区外（沙箱关闭 = 旧行为）", async () => {
    const { cwd, outside } = fixture();
    // 闭包每次 execute 都解引用 currentPlan：必须先切 off 再调工具
    planOverride = null;
    try {
      // fixture() 已把 currentPlan 设为 workspace 计划；这里直接换成 null
      // 后 buildTools 闭包解引用拿到的就是 null = 沙箱关闭。
      currentPlan = null;
      const write = toolOf(build(cwd), "write");
      const target = join(outside, "e2e-off.txt");
      const res = await write.execute("t8", { file_path: target, content: "allowed" });
      expect((res as { content: { text: string }[] }).content[0].text).toContain("Wrote");
      expect(readFileSync(target, "utf8")).toBe("allowed");
    } finally {
      planOverride = undefined;
    }
  });

  test("模型伪造的 sandbox 字段不会影响宿主裁决", async () => {
    const { cwd, outside } = fixture();
    planOverride = null; // 关闭沙箱：真实 plan 缺席
    try {
      // transport 在每次调用前把 currentPlan 重置回 planOverride（null），
      // 但 execute 闭包是在 build(cwd) 时解引用的——先置 currentPlan=null
      // 再 build，本侧预检才会拿到 null。
      currentPlan = null;
      const write = toolOf(build(cwd), "write");
      const target = join(outside, "e2e-fake.txt");
      const res = await write.execute("t9", {
        file_path: target,
        content: "x",
        sandbox: { version: 1, tier: "workspace", writeRoots: ["/"] },
      });
      expect((res as { content: { text: string }[] }).content[0].text).toContain("Wrote");
      const envelope = [...toolCalls].reverse().find((c) => c.name === "write");
      expect(envelope?.params.sandbox).toBeUndefined();
    } finally {
      planOverride = undefined;
    }
  });
});

afterAll(() => {
  for (const f of fixtures) {
    rmSync(f.cwd, { recursive: true, force: true });
    rmSync(f.outside, { recursive: true, force: true });
    rmSync(f.home, { recursive: true, force: true });
    rmSync(f.tempRoot, { recursive: true, force: true });
  }
  setTransport(null);
});
