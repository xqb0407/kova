/**
 * 面板标签 store 的测试（node 环境跑：window 缺席时 localStorage 读写均为
 * no-op 降级路径，正好等价于「无浏览器环境静默降级」的桌面外场景）。
 * 覆盖 plugin 标签的复合键定位复用（agent open_plugin_panel 的落点语义）。
 */
import { describe, expect, test, beforeEach } from "bun:test";
import {
  closeAllPanelTabs,
  focusPanelTab,
  focusPluginPanel,
  getPanelTabs,
} from "@/lib/panels/panel-tabs";

describe("focusPluginPanel", () => {
  beforeEach(() => {
    closeAllPanelTabs();
  });

  test("首次调用新开 plugin 标签并携带定位信息", () => {
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
