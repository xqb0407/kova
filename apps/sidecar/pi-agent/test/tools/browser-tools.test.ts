import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildBrowserTools } from "../../src/tools/browser-tools";
import { buildTools } from "../../src/tools/tools";

const NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_resize",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_shot",
];

type ObjectSchema = { properties?: Record<string, unknown>; required?: string[] };

const schemaOf = (t: AgentTool): ObjectSchema => t.parameters as ObjectSchema;

describe("buildBrowserTools", () => {
  test("八个工具齐全，标签统一 Browser 前缀", () => {
    const tools = buildBrowserTools("t-browser");
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    for (const t of tools) expect(t.label).toMatch(/^Browser /);
  });

  test("必填参数：navigate 需 url，click 需 ref，type 需 ref+text，快照/后退无参数", () => {
    const byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    expect(schemaOf(byName.get("browser_navigate")!).required).toContain("url");
    expect(schemaOf(byName.get("browser_click")!).required).toContain("ref");
    expect(schemaOf(byName.get("browser_type")!).required?.sort()).toEqual([
      "ref",
      "text",
    ]);
    expect(schemaOf(byName.get("browser_snapshot")!).required ?? []).toEqual([]);
    expect(schemaOf(byName.get("browser_back")!).required ?? []).toEqual([]);
    // browser_shot 不收 url：相机只拍面板眼前这一页，模型传的 URL 是它
    // "记得"的位置，用户可能早就手动跳走了
    expect(schemaOf(byName.get("browser_shot")!).required ?? []).toEqual([]);
  });

  test("browser_type.submit 与 browser_scroll.amount 为可选参数", () => {
    const byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    const typeProps = schemaOf(byName.get("browser_type")!).properties ?? {};
    const scrollProps = schemaOf(byName.get("browser_scroll")!).properties ?? {};
    expect(typeProps.submit).toBeTruthy();
    expect(scrollProps.amount).toBeTruthy();
    expect(scrollProps.direction).toBeTruthy();
  });

  test("buildTools 装配全部 browser_*（含相机）", () => {
    const names = buildTools("/tmp", "t-wire").map((t) => t.name);
    for (const n of NAMES) expect(names).toContain(n);
  });

  // 模型只有被明确教过"空树 = canvas 该转截图"，ARIA 快照才真的解决了
  // 土楼那次误判；描述里少这句，这个升级等于白做
  test("快照类工具的描述写明「空树 → 改用截图」", () => {
    const byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    for (const n of ["browser_navigate", "browser_snapshot"]) {
      const d = byName.get(n)!.description;
      expect(d).toMatch(/canvas/i);
      expect(d).toContain("browser_shot");
    }
  });
});
