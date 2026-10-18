/**
 * 面板开合会话分区偏好的测试（伪 window，localStorage 走内存实现）。
 * 覆盖三态语义：无记录 / 开过 / 明确关过；未表态时按"有没有标签"兜底、
 * 按会话隔离、草稿键 rekey 迁移（含明确关过）、LRU 截断防膨胀、坏档降级、
 * 空键（无会话期）不读不写，以及"尺寸落位是否算用户表态"的判定。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  panelResizeContradictsState,
  readPanelOpenPref,
  rekeyPanelOpenPref,
  resolvePanelOpenPref,
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
  Object.keys(JSON.parse(disk.get(KEY) ?? "{}") as Record<string, number>);

describe("panel-open-pref：按会话分区（三态）", () => {
  test("未表态读 null；在 A 打开不影响 B", () => {
    expect(readPanelOpenPref("sA")).toBeNull();
    writePanelOpenPref("sA", true);
    expect(readPanelOpenPref("sA")).toBe(true);
    expect(readPanelOpenPref("sB")).toBeNull();
  });

  test("写收起 = 明确关过（记录落盘，不再是删除）", () => {
    writePanelOpenPref("sA", true);
    writePanelOpenPref("sA", false);
    expect(readPanelOpenPref("sA")).toBe(false);
    expect(storedKeys()).toContain("sA");
  });

  test("兜底：没表过态看标签，表态永远优先", () => {
    // 从没碰过：有标签等着就展开（后台会话里 agent 开的标签不该藏在收起的面板后）
    expect(resolvePanelOpenPref("sA", true)).toBe(true);
    expect(resolvePanelOpenPref("sA", false)).toBe(false);
    // 明确关过：标签再多也不撑开（尊重用户的关闭）
    writePanelOpenPref("sA", false);
    expect(resolvePanelOpenPref("sA", true)).toBe(false);
    // 开过：即使标签已关光也保持展开
    writePanelOpenPref("sB", true);
    expect(resolvePanelOpenPref("sB", false)).toBe(true);
  });

  test("空键不读不写（草稿无会话期/异常入参）：一律交给兜底", () => {
    writePanelOpenPref(null, true);
    writePanelOpenPref(undefined, false);
    expect(readPanelOpenPref(null)).toBeNull();
    expect(resolvePanelOpenPref(null, true)).toBe(true);
    expect(disk.has(KEY)).toBe(false);
  });

  test("rekey：草稿键迁到 sessionId（开过与明确关过都跟着走）；未记录则无操作", () => {
    writePanelOpenPref("__LOCALID_1", true);
    rekeyPanelOpenPref("__LOCALID_1", "sess-1");
    expect(readPanelOpenPref("__LOCALID_1")).toBeNull();
    expect(readPanelOpenPref("sess-1")).toBe(true);
    // 草稿期就收起过的表态：绑定 sessionId 后不能被兜底重新撑开
    writePanelOpenPref("__LOCALID_2", false);
    rekeyPanelOpenPref("__LOCALID_2", "sess-2");
    expect(readPanelOpenPref("sess-2")).toBe(false);
    rekeyPanelOpenPref("__LOCALID_3", "sess-3");
    expect(readPanelOpenPref("sess-3")).toBeNull();
  });

  test("坏档/坏值按无记录处理；写入超限 LRU 截断", () => {
    disk.set(KEY, "{not json");
    expect(readPanelOpenPref("sA")).toBeNull();
    disk.set(KEY, JSON.stringify({ sA: "1", sB: null, sC: 1 }));
    expect(readPanelOpenPref("sA")).toBeNull();
    expect(readPanelOpenPref("sB")).toBeNull();
    expect(readPanelOpenPref("sC")).toBe(true);
    for (let i = 0; i < 205; i++) writePanelOpenPref(`s${i}`, true);
    expect(storedKeys().length).toBeLessThanOrEqual(200);
    expect(readPanelOpenPref("s204")).toBe(true);
    expect(readPanelOpenPref("s0")).toBeNull();
  });
});

describe("panelResizeContradictsState：落位算不算用户表态", () => {
  test("与状态相反 = 用户拖拽/双击落位，要回写", () => {
    // 开着却被收没（拖到 minSize 以下自动折叠 / 双击收起）
    expect(panelResizeContradictsState(true, true)).toBe(true);
    // 收起态被拖回来
    expect(panelResizeContradictsState(false, false)).toBe(true);
  });

  test("与状态一致 = 程序落位（切会话 snap、闸门收放、动画收尾），不回写", () => {
    expect(panelResizeContradictsState(false, true)).toBe(false);
    expect(panelResizeContradictsState(true, false)).toBe(false);
  });
});