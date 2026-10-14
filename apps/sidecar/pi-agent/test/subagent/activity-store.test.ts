import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DelegationRecord, SubagentActivityItem } from "../../src/types";
import {
  appendDelegationActivity,
  findActivityFileId,
  flushDelegationActivity,
  openDelegationActivity,
  pruneActivityFiles,
  readDelegationActivity,
  resetActivityStoreForTest,
} from "../../src/subagent/activity-store";
import { initStorage, subagentPath, subagentsDirPath } from "../../src/storage/storage";
import { resetStorageForTest } from "../../src/storage/hostdb";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-activity-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), tmp);
});

afterEach(() => {
  resetActivityStoreForTest();
});

afterAll(() => {
  resetStorageForTest();
});

const rec = (id: string, over: Partial<DelegationRecord> = {}): DelegationRecord => ({
  delegationId: id,
  agentName: "explorer",
  modelId: "p/m",
  status: "running",
  description: "调研后端能力",
  activity: [],
  stopRequested: false,
  startedAt: 1000,
  turns: 0,
  toolCalls: 0,
  reportedToParent: false,
  completion: Promise.resolve(),
  resolveCompletion: () => {},
  abort: () => {},
  ...over,
});

const turn = (n: number, at: number): SubagentActivityItem => ({ kind: "turn", n, at });
const delta = (id: string, d: string, at: number): SubagentActivityItem => ({
  kind: "text",
  op: "delta",
  id,
  delta: d,
  at,
});
const statusItem = (
  status: "completed" | "failed",
  report: string,
  at: number,
): SubagentActivityItem => ({
  kind: "status",
  status,
  turns: 1,
  toolCalls: 2,
  report,
  at,
});

describe("activity-store 写盘与回读", () => {
  test("meta 先行落盘，回读带上身份与活动条目", () => {
    const r = rec("aaaaaaaa-1111");
    openDelegationActivity(r);
    appendDelegationActivity(r.delegationId, turn(1, 1100));
    appendDelegationActivity(r.delegationId, statusItem("completed", "结论：OK", 1200));

    const back = readDelegationActivity(r.delegationId)!;
    expect(back.record.agentName).toBe("explorer");
    expect(back.record.modelId).toBe("p/m");
    expect(back.record.description).toBe("调研后端能力");
    expect(back.record.startedAt).toBe(1000);
    expect(back.record.status).toBe("completed");
    expect(back.record.completedAt).toBe(1200);
    expect(back.record.report).toBe("结论：OK");
    expect(back.items.map((i) => i.kind)).toEqual(["turn", "status"]);
  });

  test("相邻同源 delta 合并成一条再落盘", () => {
    const r = rec("bbbbbbbb-2222");
    openDelegationActivity(r);
    appendDelegationActivity(r.delegationId, { kind: "text", op: "start", id: "c0", at: 1 });
    appendDelegationActivity(r.delegationId, delta("c0", "你", 2));
    appendDelegationActivity(r.delegationId, delta("c0", "好", 3));
    appendDelegationActivity(r.delegationId, delta("c0", "吗", 4));
    appendDelegationActivity(r.delegationId, { kind: "text", op: "end", id: "c0", at: 5 });
    flushDelegationActivity(r.delegationId);

    const back = readDelegationActivity(r.delegationId)!;
    expect(back.items.map((i) => i.kind)).toEqual(["text", "text", "text"]);
    expect(back.items.map((i) => (i.kind === "text" ? i.op : ""))).toEqual([
      "start",
      "delta",
      "end",
    ]);
    const mid = back.items[1]!;
    expect(mid.kind === "text" && mid.delta).toBe("你好吗");
  });

  test("无终态记录 → status = interrupted（进程没了没跑完）", () => {
    const r = rec("cccccccc-3333");
    openDelegationActivity(r);
    appendDelegationActivity(r.delegationId, turn(1, 1100));
    flushDelegationActivity(r.delegationId);

    const back = readDelegationActivity(r.delegationId)!;
    expect(back.record.status).toBe("interrupted");
    expect(back.record.completedAt).toBeUndefined();
  });

  test("终态刷盘后该委派收摊：后续追加被忽略", () => {
    const r = rec("dddddddd-4444");
    openDelegationActivity(r);
    appendDelegationActivity(r.delegationId, statusItem("failed", "boom", 10));
    // writer 已删：这条不该进文件
    appendDelegationActivity(r.delegationId, turn(2, 20));

    const back = readDelegationActivity(r.delegationId)!;
    expect(back.items.map((i) => i.kind)).toEqual(["status"]);
    expect(back.record.status).toBe("failed");
  });

  test("撕裂/损坏行被跳过；无 meta 的文件视为无效", () => {
    const r = rec("eeeeeeee-5555");
    openDelegationActivity(r);
    appendDelegationActivity(r.delegationId, statusItem("completed", "ok", 5));
    appendFileSync(subagentPath(r.delegationId), "{torn line\n");
    expect(readDelegationActivity(r.delegationId)!.record.status).toBe("completed");

    const orphan = rec("ffffffff-6666");
    appendFileSync(subagentPath(orphan.delegationId), "{torn only\n");
    expect(readDelegationActivity(orphan.delegationId)).toBeUndefined();
  });

  test("findActivityFileId：全量 id 与前缀唯一命中；歧义不猜", () => {
    openDelegationActivity(rec("12345678-aaaa"));
    openDelegationActivity(rec("12349999-aaaa"));
    expect(findActivityFileId("12345678-aaaa")).toBe("12345678-aaaa");
    expect(findActivityFileId("12345678")).toBe("12345678-aaaa");
    expect(findActivityFileId("1234")).toBeUndefined(); // 两个都匹配 → 歧义
    expect(findActivityFileId("zz")).toBeUndefined(); // 过短
  });
});

describe("pruneActivityFiles", () => {
  test("超上限删最旧；正在跑的一律跳过", () => {
    for (let i = 0; i < 52; i++) {
      openDelegationActivity(rec(`deleg-${String(i).padStart(3, "0")}`));
    }
    const count = () => {
      // 直接数文件（避免依赖 store 内部状态）
      let n = 0;
      for (let i = 0; i < 52; i++) {
        if (existsSync(subagentPath(`deleg-${String(i).padStart(3, "0")}`))) n += 1;
      }
      return n;
    };
    expect(count()).toBe(52);

    // 全部算「在跑」→ 一个都不删
    pruneActivityFiles(() => true);
    expect(count()).toBe(52);

    // 都不在跑 → 收敛到上限 50
    pruneActivityFiles(() => false);
    expect(count()).toBe(50);
    expect(existsSync(subagentsDirPath())).toBe(true);
  });
});
