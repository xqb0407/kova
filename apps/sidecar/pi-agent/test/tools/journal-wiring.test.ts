/**
 * hostTool × recovery-journal 接线测试：execute 的四个结行点
 * （成功 done / 宿主抛错 error / 沙箱预检 deny error / start 落 running）。
 * 走 setTransport 模拟宿主（与 sandbox e2e 同一套），journal 落临时目录。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import { setTransport } from "../../src/storage/hostdb/transport";
import { buildTools } from "../../src/tools/tools";
import { journalFlushForTest, scanRunningToolCalls } from "../../src/tools/recovery-journal";
import { resetVisionToolConfigForTest } from "../../src/tools/vision-tool-config";
import { buildSandboxPlan, DEFAULT_SANDBOX_CONFIG } from "pi-sandbox";

const tmps: string[] = [];
const transportCalls: { name: string }[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "journal-wire-"));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
  tmps.length = 0;
  transportCalls.length = 0;
  resetVisionToolConfigForTest();
});

function setupHost(mode: "ok" | "throw"): string {
  const tmp = tempDir();
  initStorage(join(tmp, "state.db"), join(tmp, "sessions"));
  setTransport(async (kind, params) => {
    if (kind === "tool") transportCalls.push({ name: String((params as { name?: string }).name) });
    if (mode === "throw") throw new Error("host refused");
    return { output: "host-ok", truncated: false, exitCode: 0 };
  });
  return tmp;
}

function toolOf(tools: ReturnType<typeof buildTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} missing`);
  return tool;
}

describe("hostTool × recovery-journal 接线", () => {
  test("成功执行：start running → end done，scan 空", async () => {
    const sessions = join(setupHost("ok"), "sessions");
    const read = toolOf(buildTools("/tmp/ws", "wire-ok"), "read");
    const res = await read.execute("wire-c1", { file_path: join(sessionPath("x"), "..", "f.txt") }, undefined);
    expect((res.content[0] as { text: string }).text).toContain("host-ok");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("wire-ok");
    expect(running.size).toBe(0);
    expect(transportCalls.some((c) => c.name === "read")).toBe(true);
  });

  test("宿主抛错：end error，scan 命中（模型/调用方拿到的仍是抛错）", async () => {
    setupHost("throw");
    const read = toolOf(buildTools("/tmp/ws", "wire-err"), "read");
    await expect(read.execute("wire-c2", { file_path: "f.txt" }, undefined)).rejects.toThrow("host refused");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("wire-err");
    expect(running.size).toBe(0); // error 已结行
    // 结行确实存在（文件里有 error 状态行）
    const raw = readFileSync(recoveryFileFor("wire-err"), "utf8");
    expect(raw).toContain('"state":"error"');
    expect(raw).toContain('"state":"running"');
  });

  test("沙箱预检 deny：end error，宿主没收到调用", async () => {
    const sessions = join(setupHost("ok"), "sessions");
    // 沙箱计划用 buildSandboxPlan 真构造（stub 缺 denyWritePaths 等字段会崩），
    // workspace 档下 /outside/* 不在写根内 → 预检拒绝
    const wsRoot = mkdtempSync(join(tmpdir(), "journal-ws-"));
    tmps.push(wsRoot);
    const outside = mkdtempSync(join(tmpdir(), "journal-out-"));
    tmps.push(outside);
    const plan = buildSandboxPlan({
      cwd: wsRoot,
      tempRoot: mkdtempSync(join(tmpdir(), "journal-tmp-")),
      homeDir: mkdtempSync(join(tmpdir(), "journal-home-")),
      config: { ...DEFAULT_SANDBOX_CONFIG, tier: "workspace", allowPackageCaches: false },
      platform: process.platform,
      pathExists: () => false,
    })!;
    tmps.push(join(wsRoot, "nonexist")); // 占位保持 tmps 非空语义一致
    const tools = buildTools(
      wsRoot,
      "wire-deny",
      undefined, // getDesignTheme
      undefined, // getThemeLoads
      undefined, // ensureCwd
      undefined, // getApprovalLevel
      undefined, // getReviewFacts
      undefined, // getMode
      undefined, // getExternalDirs
      () => plan, // getSandboxPlan
    );
    const forbidden = join(outside, "forbidden.txt");
    const write = toolOf(tools, "write");
    const res = (await write.execute(
      "wire-c3",
      { file_path: forbidden, content: "x" },
      undefined,
    )) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("[diagnostic: sandbox_write_denied]");
    await journalFlushForTest();
    expect(transportCalls.some((c) => c.name === "write")).toBe(false);
    const raw = readFileSync(recoveryFileFor("wire-deny"), "utf8");
    expect(raw).toContain('"state":"error"');
    expect(raw).toContain('"state":"running"');
  });
});

// journal 在 <sessionsDir>/recovery/<threadId>.jsonl；从 sessionPath 反推根
function recoveryFileFor(threadId: string): string {
  const sessionsRoot = sessionPath(threadId).replace(/\/[^/]+\.jsonl$/, "");
  return join(sessionsRoot, "recovery", `${threadId}.jsonl`);
}
