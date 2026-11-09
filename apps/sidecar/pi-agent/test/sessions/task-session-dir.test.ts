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
import { persistableCwd } from "../../src/sessions/resolve";
import {
  removeTaskSessionDir,
  sweepOrphanTaskDirs,
  taskSessionDirSharedWithOtherSessions,
} from "../../src/sessions/sessions";
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

  test("项目 cwd 引用的目录（含祖先）保留，无引用目录照扫", async () => {
    initStorage(path.join(tmpSweep, "state.db"), path.join(tmpSweep, "sessions"));
    // 活会话把产物根下的目录显式选作项目 cwd（persistableCwd 放行后的新形态）
    const projId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projDir = path.join(tmpSweep, "proj-a");
    // 祖先保护：活 cwd 在 <base>/nest/p，<base>/nest 本身没有行引用
    const nestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const nestCwd = path.join(tmpSweep, "nest", "p");
    await sessionInsert(projId, projDir);
    await sessionInsert(nestId, nestCwd);
    const old = new Date(Date.now() - 11 * 60_000);
    for (const dir of [projDir, nestCwd, path.join(tmpSweep, "proj-b")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "artifact.html"), "<html></html>");
      utimesSync(dir, old, old);
    }

    await sweepOrphanTaskDirs();

    expect(existsSync(projDir)).toBe(true); // 活 cwd 直接引用 → 留
    expect(existsSync(path.join(tmpSweep, "nest"))).toBe(true); // 活 cwd 的祖先 → 留
    expect(existsSync(nestCwd)).toBe(true);
    // 无任何会话引用的目录（自建名/孤儿 UUID 同规）→ 清
    expect(existsSync(path.join(tmpSweep, "proj-b"))).toBe(false);
  });

  afterAll(() => {
    if (process.env.PI_TASK_CWD === tmpSweep) process.env.PI_TASK_CWD = base;
    rmSync(tmpSweep, { recursive: true, force: true });
  });
});

describe("persistableCwd 与 taskSessionDirSharedWithOtherSessions", () => {
  const sharedBase = mkdtempSync(path.join(tmpdir(), "task-shared-"));
  const ownId = "44444444-4444-4444-8444-444444444444";
  const otherId = "55555555-5555-4555-8555-555555555555";

  afterAll(() => {
    if (process.env.PI_TASK_CWD === sharedBase) {
      if (prevTaskCwd === undefined) delete process.env.PI_TASK_CWD;
      else process.env.PI_TASK_CWD = prevTaskCwd;
    }
    try {
      rmSync(sharedBase, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  });

  test("persistableCwd 只精确拦截本会话的兜底目录", () => {
    process.env.PI_TASK_CWD = sharedBase;
    expect(persistableCwd(undefined, ownId)).toBeUndefined();
    // 本会话兜底目录：拦（内部调用方误传 run.cwd 的兜底闸）
    expect(persistableCwd(path.join(sharedBase, ownId), ownId)).toBeUndefined();
    // 其子路径与产物根下其它目录：放行——用户显式选择的产物目录是合法项目 cwd
    expect(persistableCwd(path.join(sharedBase, ownId, "out"), ownId)).toBe(
      path.join(sharedBase, ownId, "out"),
    );
    expect(persistableCwd(path.join(sharedBase, "my-proj"), ownId)).toBe(
      path.join(sharedBase, "my-proj"),
    );
    // 精确匹配而非整树：别的会话的兜底目录不在拦截范围
    expect(persistableCwd(path.join(sharedBase, otherId), ownId)).toBe(path.join(sharedBase, otherId));
    // 新建会话分支（无 sessionId）：请求 cwd 即用户选择，不拦
    expect(persistableCwd(path.join(sharedBase, ownId))).toBe(path.join(sharedBase, ownId));
    // 常规项目目录不受影响
    expect(persistableCwd("/Users/x/proj", ownId)).toBe("/Users/x/proj");
  });

  test("共享判定：他人引用 true，仅自己引用/无引用/非法段名 false", async () => {
    process.env.PI_TASK_CWD = sharedBase;
    initStorage(path.join(sharedBase, "state.db"), path.join(sharedBase, "sessions"));
    // 仅本会话行引用自己的目录：不算共享（删除自己的产物是默认行为）
    await sessionInsert(ownId, path.join(sharedBase, ownId));
    expect(await taskSessionDirSharedWithOtherSessions(ownId)).toBe(false);
    // 另一会话把 <base>/<ownId> 选作项目 cwd：共享，删除须跳过目录清理
    await sessionInsert(otherId, path.join(sharedBase, ownId));
    expect(await taskSessionDirSharedWithOtherSessions(ownId)).toBe(true);
    // 子目录引用同样算共享（祖先保护）
    const thirdId = "66666666-6666-4666-8666-666666666666";
    await sessionInsert(thirdId, path.join(sharedBase, otherId, "sub"));
    expect(await taskSessionDirSharedWithOtherSessions(otherId)).toBe(true);
    // 无任何引用的目录：不共享
    expect(await taskSessionDirSharedWithOtherSessions(thirdId)).toBe(false);
    // 非法会话段名：空操作
    expect(await taskSessionDirSharedWithOtherSessions("../escape")).toBe(false);
  });
});
