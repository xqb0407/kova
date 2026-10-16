/**
 * 面板开合会话分区偏好的测试（伪 window，localStorage 走内存实现）。
 * 覆盖：未记录默认收起、按会话隔离、写收即清除、草稿键 rekey 迁移、
 * LRU 截断防膨胀、坏档降级、空键（无会话期）不读不写。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  readPanelOpenPref,
  rekeyPanelOpenPref,
  writePanelOpenPref,
} from "@/lib/panels/panel-open-pref";

const disk = new Map<string, string>();
const KEY = "agent-panel-open-v2";

beforeEach(() => {
  disk.clear();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
      setItem: (k: string, v: string) => void disk.set(k, String(v)),
      removeItem: (k: string) => void disk.delete(k),
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

const storedKeys = (): string[] =>
  Object.keys(JSON.parse(disk.get(KEY) ?? "{}") as Record<string, 1>);

describe("panel-open-pref：按会话分区", () => {
  test("未记录默认收起；在 A 打开不影响 B", () => {
    expect(readPanelOpenPref("sA")).toBe(false);
    writePanelOpenPref("sA", true);
    expect(readPanelOpenPref("sA")).toBe(true);
    expect(readPanelOpenPref("sB")).toBe(false);
  });

  test("写收起 = 清除记录（再切回默认收起）", () => {
    writePanelOpenPref("sA", true);
    writePanelOpenPref("sA", false);
    expect(readPanelOpenPref("sA")).toBe(false);
    expect(disk.has(KEY) ? storedKeys() : []).not.toContain("sA");
  });

  test("空键不读不写（草稿无会话期/异常入参）", () => {
    writePanelOpenPref(null, true);
    writePanelOpenPref(undefined, true);
    expect(readPanelOpenPref(null)).toBe(false);
    expect(disk.has(KEY)).toBe(false);
  });

  test("rekey：草稿键迁到 sessionId；未记录则无操作", () => {
    writePanelOpenPref("__LOCALID_1", true);
    rekeyPanelOpenPref("__LOCALID_1", "sess-1");
    expect(readPanelOpenPref("__LOCALID_1")).toBe(false);
    expect(readPanelOpenPref("sess-1")).toBe(true);
    rekeyPanelOpenPref("__LOCALID_2", "sess-2");
    expect(readPanelOpenPref("sess-2")).toBe(false);
  });

  test("坏档按无记录处理；写入超限 LRU 截断", () => {
    disk.set(KEY, "{not json");
    expect(readPanelOpenPref("sA")).toBe(false);
    for (let i = 0; i < 205; i++) writePanelOpenPref(`s${i}`, true);
    expect(storedKeys().length).toBeLessThanOrEqual(200);
    expect(readPanelOpenPref("s204")).toBe(true);
    expect(readPanelOpenPref("s0")).toBe(false);
  });
});
