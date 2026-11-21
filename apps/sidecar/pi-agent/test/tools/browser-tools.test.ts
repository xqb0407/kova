import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildBrowserTools } from "../../src/tools/browser-tools";
import {
  resetBrowserConfigForTest,
  setBrowserConfigForTest,
} from "../../src/tools/browser-config";
import { buildTools } from "../../src/tools/tools";

const NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_resize",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_hover",
  "browser_scroll",
  "browser_select",
  "browser_check",
  "browser_drag",
  "browser_evaluate",
  "browser_wait_for",
  "browser_state",
  "browser_dialog",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_shot",
];

type ObjectSchema = { properties?: Record<string, unknown>; required?: string[] };

const schemaOf = (t: AgentTool): ObjectSchema => t.parameters as ObjectSchema;

describe("buildBrowserTools", () => {
  test("工具齐全，标签统一 Browser 前缀", () => {
    const tools = buildBrowserTools("t-browser");
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
    for (const t of tools) expect(t.label).toMatch(/^Browser /);
  });

  test("必填参数：navigate/type/press/select/check/drag/evaluate/dialog", () => {
    const byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    expect(schemaOf(byName.get("browser_navigate")!).required).toContain("url");
    // click 支持 ref 或 x/y，两者都不是硬性必填（主进程侧校验二选一）
    expect(schemaOf(byName.get("browser_click")!).required ?? []).toEqual([]);
    expect(schemaOf(byName.get("browser_type")!).required?.sort()).toEqual([
      "ref",
      "text",
    ]);
    expect(schemaOf(byName.get("browser_press")!).required).toContain("key");
    expect(schemaOf(byName.get("browser_select")!).required?.sort()).toEqual([
      "ref",
      "values",
    ]);
    expect(schemaOf(byName.get("browser_check")!).required).toContain("ref");
    expect(schemaOf(byName.get("browser_evaluate")!).required).toContain("expression");
    expect(schemaOf(byName.get("browser_dialog")!).required).toContain("accept");
    for (const n of [
      "browser_snapshot",
      "browser_state",
      "browser_back",
      "browser_forward",
      "browser_reload",
    ]) {
      expect(schemaOf(byName.get(n)!).required ?? []).toEqual([]);
    }
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

  test("buildTools 按设置注入：主开关关闭全收走，pixelShot 关只收相机", () => {
    resetBrowserConfigForTest();
    let names = buildTools("/tmp", "t-wire").map((t) => t.name);
    for (const n of NAMES.filter((name) => name !== "browser_shot")) {
      expect(names).toContain(n);
    }
    // 默认 pixelShot=false：相机不进工具表
    expect(names).not.toContain("browser_shot");
    expect(names).not.toContain("screenshot");

    setBrowserConfigForTest({ pixelShot: true, screenShot: true });
    names = buildTools("/tmp", "t-wire").map((t) => t.name);
    expect(names).toContain("browser_shot");
    expect(names).toContain("screenshot");

    // 浏览器主开关关闭：browser_* 全部收走；屏幕截图是独立授权，仍保留
    setBrowserConfigForTest({ enabled: false });
    names = buildTools("/tmp", "t-wire").map((t) => t.name);
    for (const n of NAMES) expect(names).not.toContain(n);
    expect(names).toContain("screenshot");

    setBrowserConfigForTest({ screenShot: false });
    names = buildTools("/tmp", "t-wire").map((t) => t.name);
    expect(names).not.toContain("screenshot");
    resetBrowserConfigForTest();
  });

  // 模型只有被明确教过"空树 = canvas 该转截图"，ARIA 快照才真的解决了
  // 土楼那次误判；描述里少这句，这个升级等于白做
  test("快照类工具描述随 pixelShot 开关变化（关闭时不再教模型调截图）", () => {
    resetBrowserConfigForTest();
    let byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    for (const n of ["browser_navigate", "browser_snapshot"]) {
      const d = byName.get(n)!.description;
      expect(d).toMatch(/canvas/i);
      expect(d).not.toContain("browser_shot");
    }
    setBrowserConfigForTest({ pixelShot: true });
    byName = new Map(buildBrowserTools("t-browser").map((t) => [t.name, t]));
    for (const n of ["browser_navigate", "browser_snapshot"]) {
      expect(byName.get(n)!.description).toContain("browser_shot");
    }
    resetBrowserConfigForTest();
  });
});
