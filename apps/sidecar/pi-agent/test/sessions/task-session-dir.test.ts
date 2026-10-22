/**
 * removeTaskSessionDir 的容错删除：目录被句柄占用（Windows EBUSY 的同构
 * 模拟——子目录去读权限让递归 rm 必失败）时绝不能抛——删会话是同步链，
 * 这里抛错等于整条 delete_session 失败；同时延迟清扫要在占用释放后把
 * 目录真删掉，而不是永久留孤儿。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTaskSessionDir, sweepOrphanTaskDirs } from "../../src/sessions/sessions";
import { initStorage } from "../../src/storage/storage";
import { sessionInsert } from "../../src/storage/hostdb";

const prevTaskCwd = process.env.PI_TASK_CWD;
const base = mkdtempSync(path.join(tmpdir(), "task-session-dir-"));
const SID = "d42c09ce-4fe8-46e4-8481-b4670dd30fab";
const dir = path.join(base, SID);

afterAll(() => {
  if (prevTaskCwd === undefined) delete process.env.PI_TASK_CWD;
  else process.env.PI_TASK_CWD = prevTaskCwd;
  // 目录多半已被清扫删掉（功能生效的表现），chmod 前先探存在
  const busy = path.join(dir, "busy");
  if (existsSync(busy)) chmodSync(busy, 0o755);
  try {
    rmSync(dir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});

describe("removeTaskSessionDir 容错删除", () => {
  test("目录被占时不抛错，清扫在占用释放后删净", async () => {
    process.env.PI_TASK_CWD = base;
    mkdirSync(path.join(dir, "busy"), { recursive: true });
    writeFileSync(path.join(dir, "busy", "artifact.html"), "<html></html>");
    // 占用模拟：busy 子目录去读权限 → 递归 rm 读不到内容必失败
    //（Windows 上同类故障是 EBUSY/EPERM，这里是 EACCES，走的同一条容错路）
    chmodSync(path.join(dir, "busy"), 0o000);

    expect(() => removeTaskSessionDir(SID)).not.toThrow();
    expect(existsSync(dir)).toBe(true); // 还没删掉：交给清扫

    // 释放占用 → 清扫首个重试（5s）应当删净
    chmodSync(path.join(dir, "busy"), 0o755);
    await Bun.sleep(5600);
    expect(existsSync(dir)).toBe(false);
  }, 10_000);

  test("非法会话名与从未落盘的会话都是空操作", () => {
    process.env.PI_TASK_CWD = base;
    expect(() => removeTaskSessionDir("../escape")).not.toThrow();
    expect(() => removeTaskSessionDir("00000000-0000-4000-8000-000000000000")).not.toThrow();
    expect(existsSync(path.join(base, "..", "escape"))).toBe(false);
  });
});

describe("sweepOrphanTaskDirs 启动清扫", () => {
  const sweepBase = path.join(base, "..", "task-sweep-");
  const tmpSweep = mkdtempSync(sweepBase);
  const keepId = "11111111-1111-4111-8111-111111111111";
  const goneId = "22222222-2222-4222-8222-222222222222";

  test("孤儿目录删除，存活会话目录保留，新目录不碰", async () => {
    initStorage(path.join(tmpSweep, "state.db"), path.join(tmpSweep, "sessions"));
    await sessionInsert(keepId, "");
    process.env.PI_TASK_CWD = tmpSweep;

    const keepDir = path.join(tmpSweep, keepId);
    const orphanDir = path.join(tmpSweep, goneId);
    const freshDir = path.join(tmpSweep, "33333333-3333-4333-8333-333333333333");
    for (const dir of [keepDir, orphanDir, freshDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "artifact.html"), "<html></html>");
    }
    // fresh-guard 门槛（10 分钟）需要把"该删的"做旧才能测到
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(orphanDir, old, old);
    utimesSync(keepDir, old, old);

    await sweepOrphanTaskDirs();

    expect(existsSync(orphanDir)).toBe(false); // 孤儿且已做旧 → 删
    expect(existsSync(keepDir)).toBe(true); // 存活会话 → 留
    expect(existsSync(freshDir)).toBe(true); // mtime 新（竞态防护） → 留
    // 非会话段名（点开头）不碰
    const dotDir = path.join(tmpSweep, ".DS_Store");
    writeFileSync(dotDir, "");
    await sweepOrphanTaskDirs();
    expect(existsSync(dotDir)).toBe(true);
  });

  afterAll(() => {
    if (process.env.PI_TASK_CWD === tmpSweep) process.env.PI_TASK_CWD = base;
    rmSync(tmpSweep, { recursive: true, force: true });
  });
});
