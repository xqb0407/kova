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
];

type ObjectSchema = { properties?: Record<string, unknown>; required?: string[] };

const schemaOf = (t: AgentTool): ObjectSchema => t.parameters as ObjectSchema;

describe("buildBrowserTools", () => {
  test("七个工具齐全，标签统一 Browser 前缀", () => {
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
  });

  test("browser_type.submit 与 browser_scroll.amount 为可选参数", () => {
    const byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    const typeProps = schemaOf(byName.get("browser_type")!).properties ?? {};
    const scrollProps = schemaOf(byName.get("browser_scroll")!).properties ?? {};
    expect(typeProps.submit).toBeTruthy();
    expect(scrollProps.amount).toBeTruthy();
    expect(scrollProps.direction).toBeTruthy();
  });

  test("buildTools 只装配 browser_navigate（其余 browser_* 暂停暴露）", () => {
    const names = buildTools("/tmp", "t-wire").map((t) => t.name);
    expect(names).toContain("browser_navigate");
    for (const n of NAMES.filter((n) => n !== "browser_navigate"))
      expect(names).not.toContain(n);
  });
});
