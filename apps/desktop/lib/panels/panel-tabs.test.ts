/**
 * 面板标签 store 的测试（伪 window 环境，localStorage 走内存实现）。
 * 覆盖按会话分桶的核心语义——线程隔离、指针切换、草稿 id rekey、
 * 会话删除 purge、跨会话并集视图、LRU 落盘上限与 v1 旧键清除，
 * plugin 标签的复合键定位复用（agent open_plugin_panel 的落点语义），
 * 以及按属主定靶的 For 变体（后台会话的 agent 工具/终端回写字）。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { fakeLocalStorage, removeFakeWindow } from "./panel-tabs.test-window";
import {
  closeAllPanelTabs,
  closePanelTab,
  closePanelTabFor,
  focusPanelTab,
  focusPanelTabFor,
  focusPluginPanel,
  focusPluginPanelFor,
  getAllThreadTabs,
  getCurrentPanelThreadId,
  getPanelTabs,
  getPanelTabsFor,
  openOrFocusFileTab,
  openPanelTab,
  openPanelTabFor,
  openSideChatTab,
  pinFileTab,
  previewFileTab,
  purgeThreadPanelTabs,
  rekeyPanelThread,
  setCurrentPanelThread,
  updatePanelTabFor,
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

describe("按属主定靶（For 变体：后台会话的写入方）", () => {
  test("focusPanelTabFor 写后台桶：显示桶快照引用不变、后台桶就地新建", () => {
    setCurrentPanelThread("tA");
    openPanelTab("activity");
    const shown = getPanelTabs();
    const bgTab = focusPanelTabFor("tB", "browser", { url: "https://x.dev" });
    // 用户正在看的会话丝毫不受后台写入影响
    expect(getPanelTabs()).toBe(shown);
    expect(getPanelTabs().tabs).toHaveLength(1);
    // 后台桶不存在即新建，标签落桶并激活
    const b = getPanelTabsFor("tB");
    expect(b.tabs).toHaveLength(1);
    expect(b.activeId).toBe(bgTab);
    expect(b.tabs[0]).toMatchObject({ type: "browser", url: "https://x.dev" });
    expect(getAllThreadTabs().map((x) => x.threadId).sort()).toEqual(["tA", "tB"]);
  });

  test("定靶于显示会话时与指针版语义一致（同型复用）", () => {
    setCurrentPanelThread("tA");
    const first = focusPanelTabFor("tA", "file", { path: "a.ts" });
    const second = focusPanelTabFor("tA", "file", { path: "b.ts" });
    expect(second).toBe(first);
    const state = getPanelTabs();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.path).toBe("b.ts");
    expect(state.activeId).toBe(first);
  });

  test("plugin 复合键复用也按属主桶：后台两次唤起同一面板只占一标签", () => {
    setCurrentPanelThread("tA");
    const x = focusPluginPanelFor("tB", "p@m", "canvas", { path: "one.json" });
    const y = focusPluginPanelFor("tB", "p@m", "canvas", { path: "two.json" });
    expect(y).toBe(x);
    expect(getPanelTabs().tabs).toHaveLength(0);
    expect(getPanelTabsFor("tB").tabs[0]!.path).toBe("two.json");
  });

  test("closePanelTabFor/updatePanelTabFor 定向属主桶；指错桶的指针版不误伤", () => {
    setCurrentPanelThread("tA");
    const aTab = openPanelTab("activity");
    const bTab = focusPanelTabFor("tB", "browser", { url: "u1" });
    updatePanelTabFor("tB", bTab, { url: "u2", title: "站点" });
    expect(getPanelTabsFor("tB").tabs[0]).toMatchObject({ url: "u2", title: "站点" });
    // 后台进程退出回写走指针版时是 no-op（这正是归属 bug 的死标签来源），
    // For 版才关得掉
    closePanelTab(bTab);
    expect(getPanelTabsFor("tB").tabs).toHaveLength(1);
    closePanelTabFor("tB", bTab);
    expect(getPanelTabsFor("tB").tabs).toHaveLength(0);
    // 显示桶全程无感
    expect(getPanelTabs().tabs.map((t) => t.id)).toEqual([aTab]);
  });

  test("updatePanelTabFor 目标标签不在桶：no-op，不为后台凭空建空桶", () => {
    setCurrentPanelThread("tA");
    updatePanelTabFor("tGhost", "tab-nope", { title: "X" });
    expect(getPanelTabsFor("tGhost").tabs).toHaveLength(0);
    expect(getAllThreadTabs().map((x) => x.threadId)).toEqual([]);
  });

  test("指针为 null 时指针版 no-op 防脏，For 版照常落桶", () => {
    expect(getCurrentPanelThreadId()).toBeNull();
    const phantom = focusPanelTab("review");
    expect(phantom.startsWith("tab-")).toBe(true);
    expect(getAllThreadTabs()).toHaveLength(0);
    const id = openPanelTabFor("tZ", "plan");
    expect(getPanelTabsFor("tZ").activeId).toBe(id);
    expect(getPanelTabs().tabs).toHaveLength(0);
  });

  test("rekey 后后台属主标签随桶迁移（shell 按 uuid 反查属主的依据）", () => {
    setCurrentPanelThread("tView");
    const id = openPanelTabFor("draftX", "shell", { sessionId: "pty-9", title: "终端" });
    rekeyPanelThread("draftX", "sess-9");
    const found = getAllThreadTabs().find((b) =>
      b.tabs.some((t) => t.id === id),
    );
    expect(found?.threadId).toBe("sess-9");
    expect(getPanelTabsFor("draftX").tabs).toHaveLength(0);
    // 显示桶自始至终无感
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

describe("辅助会话标签", () => {
  test("同一子会话复用；不同子会话按父会话编号", () => {
    setCurrentPanelThread("parent-1");
    const first = openSideChatTab({
      parentSessionId: "parent-1",
      childSessionId: "child-1",
    });
    const second = openSideChatTab({
      parentSessionId: "parent-1",
      childSessionId: "child-2",
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    let state = getPanelTabs();
    expect(state.tabs.map((t) => t.ordinal)).toEqual([1, 2]);
    expect(state.tabs.every((t) => t.type === "side-chat")).toBe(true);
    expect(state.activeId).toBe(second!);

    // 同一子会话再次打开只激活，不新增
    const again = openSideChatTab({
      parentSessionId: "parent-1",
      childSessionId: "child-1",
    });
    expect(again).toBe(first!);
    state = getPanelTabs();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(first!);
  });

  test("换父会话后独立编号，标签桶互不可见", () => {
    setCurrentPanelThread("parent-1");
    openSideChatTab({
      parentSessionId: "parent-1",
      childSessionId: "child-1",
    });
    setCurrentPanelThread("parent-2");
    openSideChatTab({
      parentSessionId: "parent-2",
      childSessionId: "child-2",
    });
    expect(getPanelTabs().tabs[0]!.ordinal).toBe(1);
    setCurrentPanelThread("parent-1");
    expect(getPanelTabs().tabs[0]!.childSessionId).toBe("child-1");
  });
});

/**
 * 文件标签预览语义（VS Code）：单击 = 临时预览（唯一，原地替换），
 * 双击 / 「在新标签页中打开」= 常驻。
 */
describe("文件标签预览语义", () => {
  test("单击：无 preview 标签时新开临时标签；再单击另一文件原地替换（不新增）", () => {
    setCurrentPanelThread("tPreview");
    previewFileTab("/w", "a.ts", "a.ts");
    let state = getPanelTabs();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      type: "file",
      path: "a.ts",
      preview: true,
    });
    const firstId = state.tabs[0]!.id;

    previewFileTab("/w", "b.ts", "b.ts");
    state = getPanelTabs();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ id: firstId, path: "b.ts", preview: true });
    expect(state.activeId).toBe(firstId);
  });

  test("双击转常驻；后续单击开新的临时标签，不覆盖常驻标签", () => {
    setCurrentPanelThread("tPreviewPin");
    previewFileTab("/w", "a.ts", "a.ts");
    pinFileTab("/w", "a.ts", "a.ts");
    let state = getPanelTabs();
    expect(state.tabs[0]?.preview).toBeUndefined();

    previewFileTab("/w", "b.ts", "b.ts");
    state = getPanelTabs();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.find((t) => t.path === "a.ts")?.preview).toBeUndefined();
    expect(state.tabs.find((t) => t.path === "b.ts")?.preview).toBe(true);

    // 再点已常驻文件：只激活，不新建、不改 preview
    previewFileTab("/w", "a.ts", "a.ts");
    state = getPanelTabs();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe(
      state.tabs.find((t) => t.path === "a.ts")?.id ?? null,
    );
  });

  test("「在新标签页中打开」未开过时直接开常驻标签", () => {
    setCurrentPanelThread("tPreviewNew");
    openOrFocusFileTab("/w", "c.ts", "c.ts");
    const state = getPanelTabs();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.preview).toBeUndefined();
  });
});
