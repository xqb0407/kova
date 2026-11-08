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
});
