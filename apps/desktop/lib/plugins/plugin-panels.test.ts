/**
 * 面板 opens-glob 路由测试：panelOpenMatches 的 `*` 语义（不跨路径分隔符、大小写不敏感），
 * findPanelForFile 的「最具体 glob 优先」——office 的 *.deck.canvas.json 必须压过
 * canvas 插件的 *.canvas.json（`*.canvas.json` 同样匹配 foo.deck.canvas.json），
 * 否则宽后缀插件会按注册顺序吞掉窄后缀插件的文件。
 */
import { describe, expect, test } from "bun:test";
import { findPanelForFile, panelOpenMatches, type PluginPanelContribution } from "./plugin-panels";

const panel = (pluginId: string, opens: string[]): PluginPanelContribution => ({
  pluginId,
  pluginName: pluginId,
  panel: { id: pluginId, title: pluginId, opens, permissions: ["document"] },
});

describe("panelOpenMatches", () => {
  test("`*` 不跨路径分隔符；后缀整体匹配", () => {
    expect(panelOpenMatches("*.canvas.json", "deck.canvas.json")).toBe(true);
    expect(panelOpenMatches("*.canvas.json", "a/b.canvas.json")).toBe(false);
    expect(panelOpenMatches("*.deck.canvas.json", "roadmap.deck.canvas.json")).toBe(true);
    // 宽 glob 确实也认领 deck 档（这正是路由要按具体度决胜的原因）
    expect(panelOpenMatches("*.canvas.json", "roadmap.deck.canvas.json")).toBe(true);
  });
});

describe("findPanelForFile", () => {
  const wideFirst = [panel("canvas", ["*.canvas.json"]), panel("office", ["*.deck.canvas.json"])];
  test("最具体 glob 优先：deck 档归 office（即便宽后缀注册在前）", () => {
    expect(findPanelForFile(wideFirst, "roadmap.deck.canvas.json")?.pluginId).toBe("office");
  });
  test("无重叠认领时行为不变：普通画布档仍归宽后缀插件", () => {
    expect(findPanelForFile(wideFirst, "board.canvas.json")?.pluginId).toBe("canvas");
  });
  test("同分按注册顺序取第一", () => {
    const dup = [panel("a", ["*.canvas.json"]), panel("b", ["*.canvas.json"])];
    expect(findPanelForFile(dup, "x.canvas.json")?.pluginId).toBe("a");
  });
  test("无人认领返回 undefined", () => {
    expect(findPanelForFile(wideFirst, "notes.md")).toBeUndefined();
  });
});
