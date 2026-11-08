/**
 * 恢复日志（recovery-journal）行为级测试。
 *
 * 崩溃语义 = 「settle 缺席」：start 后不调 end 再 scan，running 行仍在——
 * 不需要真杀进程即可覆盖崩溃路径。其余按普通文件行为测：交错、损坏行、
 * fail-open、清理。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStorage } from "../../src/storage/storage";
import {
  cleanupRecovered,
  journalFlushForTest,
  journalToolEnd,
  journalToolStart,
  scanRunningToolCalls,
} from "../../src/tools/recovery-journal";

const tmps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-journal-"));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
  tmps.length = 0;
});

function setup(): string {
  const tmp = tempDir();
  initStorage(join(tmp, "state.db"), join(tmp, "sessions"));
  return join(tmp, "sessions", "recovery");
}

describe("recovery-journal", () => {
  test("start→end(done)：scan 不再返回该 id", async () => {
    setup();
    journalToolStart("t1", "call-1", "write");
    await journalFlushForTest();
    journalToolEnd("t1", "call-1", "done", "write");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("t1");
    expect(running.has("call-1")).toBe(false);
    expect(running.size).toBe(0);
  });

  test("崩溃语义：start 后 settle 缺席，scan 仍返回 running", async () => {
    setup();
    journalToolStart("t2", "call-a", "bash");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("t2");
    expect(running.has("call-a")).toBe(true);
  });

  test("同 id 多行取文件序最后一行：start→error→scan 不再 running", async () => {
    setup();
    journalToolStart("t3", "call-x", "bash");
    journalToolEnd("t3", "call-x", "error", "bash");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("t3");
    expect(running.has("call-x")).toBe(false);
  });

  test("多调用交错：各自独立，只留未结的", async () => {
    setup();
    journalToolStart("t4", "call-1", "write");
    journalToolStart("t4", "call-2", "read");
    journalToolEnd("t4", "call-1", "done", "write");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("t4");
    expect(running.has("call-1")).toBe(false);
    expect(running.has("call-2")).toBe(true);
  });

  test("损坏半行 JSON 被跳过（写一半崩溃），合法行不受影响", async () => {
    const dir = setup();
    journalToolStart("t5", "call-ok", "read");
    await journalFlushForTest();
    // 追加半行模拟写一半崩溃
    const file = join(dir, "t5.jsonl");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, `${raw}{"seq":99,"toolCallId":"call-broken","na`, { encoding: "utf8" });
    const running = await scanRunningToolCalls("t5");
    expect(running.has("call-ok")).toBe(true);
    expect(running.has("call-broken")).toBe(false);
    expect(running.size).toBe(1);
  });

  test("文件不存在/线程无 journal：空集 fail-open", async () => {
    setup();
    const running = await scanRunningToolCalls("no-such-thread");
    expect(running.size).toBe(0);
  });

  test("cleanupRecovered：无 running 时删文件；有 running 时保留", async () => {
    const dir = setup();
    journalToolStart("t6", "call-1", "write");
    journalToolEnd("t6", "call-1", "done", "write");
    await journalFlushForTest();
    await cleanupRecovered(["t6"]);
    expect(() => readFileSync(join(dir, "t6.jsonl"), "utf8")).toThrow();
    // 有 running 的保留
    journalToolStart("t7", "call-2", "bash");
    await journalFlushForTest();
    await cleanupRecovered(["t7"]);
    expect(readFileSync(join(dir, "t7.jsonl"), "utf8")).toContain("call-2");
  });

  test("threadId 含路径分隔符被剥成安全文件名", async () => {
    const dir = setup();
    journalToolStart("t/../../evil", "call-1", "read");
    await journalFlushForTest();
    const running = await scanRunningToolCalls("t/../../evil");
    expect(running.has("call-1")).toBe(true);
    // 落在 recovery 根内（没有被写到外面）；非字母数字全被剥成 _
    expect(readFileSync(join(dir, "t_______evil.jsonl"), "utf8")).toContain("call-1");
    rmSync(join(dir, "t_______evil.jsonl"), { force: true });
  });

  test("键命名空间回归门：journal 按 threadId 写，sessionId 扫不到、threadId 扫得到", async () => {
    // bd68da9 修复的回归门：hostTool 写 journal 用 threadId，restore 必须按
    // 同一 key 扫——按 sessionId 扫会永远落空（两套 id 不同命名空间）
    setup();
    const threadId = "ui-thread-abc";
    const sessionId = "pi-4f7a2b18-9c3d-4e5f-8a1b-2c3d4e5f6a7b";
    journalToolStart(threadId, "call-1", "write");
    await journalFlushForTest();
    // 同一命名空间（threadId）命中
    expect((await scanRunningToolCalls(threadId)).has("call-1")).toBe(true);
    // 另一套命名空间（sessionId）必须扫不到——若命中说明键被改成了 sessionId
    expect((await scanRunningToolCalls(sessionId)).has("call-1")).toBe(false);
    // cleanup 只消化「无 running」的文件：行还 running 时保留（repair 只读
    // 不结行，结行由宿主调用完成语义负责——见 sandbox e2e 恢复链用例）
    await cleanupRecovered([threadId]);
    expect((await scanRunningToolCalls(threadId)).has("call-1")).toBe(true);
    // 结行后再清：文件消失，sessionId 维度依旧无感
    journalToolEnd(threadId, "call-1", "done", "write");
    await journalFlushForTest();
    await cleanupRecovered([threadId]);
    expect((await scanRunningToolCalls(threadId)).size).toBe(0);
  });
});

describe("静态门：restore 链的 journal 键（防 threadId→sessionId 回归）", () => {
  test("resolve.ts 的 scan/cleanup 实参必须是 threadId", () => {
    // bd68da9 修复的静态防线：resolveSession 曾误传 sessionId（另一命名空间），
    // 增强文案在生产链路静默失效。读源码断言调用点实参。
    const src = readFileSync(
      join(import.meta.dir, "../../src/sessions/resolve.ts"),
      "utf8",
    );
    expect(src).toContain("scanRunningToolCalls(threadId)");
    expect(src).toContain("cleanupRecovered([threadId])");
    // 不允许出现按 sessionId 的调用点
    expect(src).not.toContain("scanRunningToolCalls(sessionId)");
    expect(src).not.toContain("cleanupRecovered([sessionId])");
  });
});
