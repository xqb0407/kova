/**
 * 面板标签 store 的测试（伪 window 环境，localStorage 走内存实现）。
 * 覆盖按会话分桶的核心语义——线程隔离、指针切换、草稿 id rekey、
 * 会话删除 purge、跨会话并集视图、LRU 落盘上限与 v1 旧键清除，
 * 以及 plugin 标签的复合键定位复用（agent open_plugin_panel 的落点语义）。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { fakeLocalStorage, removeFakeWindow } from "./panel-tabs.test-window";
import {
  closeAllPanelTabs,
  closePanelTab,
  focusPanelTab,
  focusPluginPanel,
  getAllThreadTabs,
  getPanelTabs,
  openPanelTab,
  purgeThreadPanelTabs,
  rekeyPanelThread,
  setCurrentPanelThread,
} from "@/lib/panels/panel-tabs";

afterAll(removeFakeWindow);

// 每个用例后清场：非空桶逐一 purge，指针归位——用例间互不残留
afterEach(() => {
  for (const bucket of getAllThreadTabs()) purgeThreadPanelTabs(bucket.threadId);
  closeAllPanelTabs();
  setCurrentPanelThread(null);
});

describe("按会话分桶", () => {
  test("A 开的标签 B 看不见；切回 A 整组恢复（含激活项）", () => {
    setCurrentPanelThread("tA");
    openPanelTab("activity");
    const shellTab = openPanelTab("shell", { sessionId: "pty-1", title: "终端" });
    setCurrentPanelThread("tB");
    expect(getPanelTabs()).toEqual({ tabs: [], activeId: null });
    const planTab = openPanelTab("plan");
    expect(getPanelTabs().tabs).toHaveLength(1);
    setCurrentPanelThread("tA");
    const a = getPanelTabs();
    expect(a.tabs).toHaveLength(2);
    expect(a.activeId).toBe(shellTab);
    setCurrentPanelThread("tB");
    expect(getPanelTabs().activeId).toBe(planTab);
  });

  test("focusPanelTab 同型复用只在会话内：跨会话各开各的", () => {
    setCurrentPanelThread("tA");
    const rA = focusPanelTab("review", { focus: "a" });
    setCurrentPanelThread("tB");
    const rB = focusPanelTab("review", { focus: "b" });
    expect(rB).not.toBe(rA);
    setCurrentPanelThread("tA");
    expect(getPanelTabs().tabs.find((t) => t.id === rA)!.focus).toBe("a");
    const rA2 = focusPanelTab("review", { focus: "a2" });
    expect(rA2).toBe(rA);
    expect(getPanelTabs().tabs.find((t) => t.id === rA)!.focus).toBe("a2");
  });

  test("closeAllPanelTabs 只清当前会话", () => {
    setCurrentPanelThread("tA");
    openPanelTab("activity");
    setCurrentPanelThread("tB");
    openPanelTab("git");
    closeAllPanelTabs();
    expect(getPanelTabs().tabs).toHaveLength(0);
    setCurrentPanelThread("tA");
    expect(getPanelTabs().tabs).toHaveLength(1);
  });

  test("closePanelTab 激活项被关时就近切换（既有语义回归）", () => {
    setCurrentPanelThread("tC");
    const t1 = openPanelTab("activity");
    const t2 = openPanelTab("plan");
    const t3 = openPanelTab("git");
    closePanelTab(t3);
    expect(getPanelTabs().activeId).toBe(t2);
    closePanelTab(t2);
    expect(getPanelTabs().activeId).toBe(t1);
  });
});

describe("rekey / purge", () => {
  test("rekey 把草稿桶迁到 sessionId 键下，指针跟随", () => {
    setCurrentPanelThread("__LOCALID_x");
    const activity = openPanelTab("activity");
    rekeyPanelThread("__LOCALID_x", "sess-1");
    // 指针已随迁：继续 mutate 落在 sess-1 桶
    const review = focusPanelTab("review");
    expect(getPanelTabs().tabs.map((t) => t.id)).toEqual([activity, review]);
    // 模拟刷新后 mainThreadId=sessionId：桶接得上
    setCurrentPanelThread("sess-1");
    expect(getPanelTabs().tabs).toHaveLength(2);
    setCurrentPanelThread("__LOCALID_x");
    expect(getPanelTabs().tabs).toHaveLength(0);
  });

  test("purge 清桶并从并集视图消失；purge 当前会话回落空态", () => {
    setCurrentPanelThread("tD");
    openPanelTab("activity");
    setCurrentPanelThread("tE");
    openPanelTab("plan");
    expect(getAllThreadTabs()).toHaveLength(2);
    purgeThreadPanelTabs("tD");
    expect(getAllThreadTabs().map((b) => b.threadId)).toEqual(["tE"]);
    purgeThreadPanelTabs("tE");
    expect(getPanelTabs().tabs).toHaveLength(0);
  });
});

describe("持久化（内存 localStorage）", () => {
  test("v1 旧键在首次使用时被清除（不做迁移）", () => {
    getPanelTabs();
    expect(fakeLocalStorage.has("agent-panel-tabs")).toBe(false);
  });

  test("非空桶按 LRU 落盘且上限 30，空桶不落盘", () => {
    for (let i = 0; i < 32; i++) {
      setCurrentPanelThread(`cap-${i}`);
      openPanelTab("activity");
    }
    const parsed = JSON.parse(
      fakeLocalStorage.get("agent-panel-tabs-v2")!,
    ) as { byThread: Record<string, unknown>; order: string[] };
    expect(Object.keys(parsed.byThread)).toHaveLength(30);
    // order 最近在前：最新的 cap-31 在盘上，最老的 cap-0 被驱逐
    expect(parsed.byThread["cap-31"]).toBeTruthy();
    expect(parsed.byThread["cap-0"]).toBeUndefined();
    // 访问过但没开标签的会话：不落盘
    setCurrentPanelThread("empty-t");
    const after = JSON.parse(
      fakeLocalStorage.get("agent-panel-tabs-v2")!,
    ) as { byThread: Record<string, unknown> };
    expect(after.byThread["empty-t"]).toBeUndefined();
  });
});

describe("focusPluginPanel（复合键复用，会话内）", () => {
  test("首次调用新开 plugin 标签并携带定位信息", () => {
    setCurrentPanelThread("tP");
    const id = focusPluginPanel("canvas@m1", "canvas", {
      path: "deck.canvas.json",
      cwd: "/ws",
    });
    const { tabs, activeId } = getPanelTabs();
    expect(activeId).toBe(id);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id,
      type: "plugin",
      pluginId: "canvas@m1",
      panelId: "canvas",
      path: "deck.canvas.json",
      cwd: "/ws",
    });
  });

  test("同插件同面板：复用标签、换绑文档；同插件异面板：各开一个", () => {
    setCurrentPanelThread("tP");
    const a = focusPluginPanel("p@m", "canvas", { path: "one.canvas.json" });
    const b = focusPluginPanel("p@m", "canvas", { path: "two.canvas.json" });
    expect(b).toBe(a);
    let state = getPanelTabs();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.path).toBe("two.canvas.json");

    const c = focusPluginPanel("p@m", "other");
    expect(c).not.toBe(a);
    state = getPanelTabs();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(c);
    // canvas 标签保持原绑定不受影响
    expect(state.tabs.find((t) => t.id === a)!.path).toBe("two.canvas.json");
    // 复用激活不携带 extra 时旧字段保留（spread 只覆盖给出的键）
    const d = focusPluginPanel("p@m", "canvas");
    expect(d).toBe(a);
    expect(getPanelTabs().tabs.find((t) => t.id === a)!.path).toBe("two.canvas.json");
  });

  test("非 plugin 类型走 focusPanelTab 同型复用，互不干扰", () => {
    setCurrentPanelThread("tP");
    const p = focusPluginPanel("p@m", "canvas");
    const r1 = focusPanelTab("review", { focus: "f1" });
    const r2 = focusPanelTab("review", { focus: "f2" });
    expect(r2).toBe(r1);
    const { tabs } = getPanelTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.id === p)!.type).toBe("plugin");
    expect(tabs.find((t) => t.id === r1)!.focus).toBe("f2");
  });
});
