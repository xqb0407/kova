import { describe, expect, test } from "bun:test";
import { browserToolLabel, browserToolSummary } from "./browser-tool-summary";

describe("browserToolLabel", () => {
  test("已知动作走中文标签，未知 browser_* 只留后缀", () => {
    expect(browserToolLabel("browser_navigate")).toBe("打开网页");
    expect(browserToolLabel("browser_new_action")).toBe("new_action");
    expect(browserToolLabel("browser_")).toBe("浏览器操作");
  });
});

describe("browserToolSummary", () => {
  test("navigate / resize：URL 与视口尺寸", () => {
    expect(browserToolSummary("browser_navigate", { url: "https://x.test/a" })).toEqual({
      primary: "https://x.test/a",
    });
    expect(browserToolSummary("browser_resize", { width: 1280, height: 800 })).toEqual({
      primary: "1280 × 800",
    });
    // 只钉一个方向时不能笼统说“填充面板”
    expect(browserToolSummary("browser_resize", { width: 1280 })).toEqual({
      primary: "宽 1280",
    });
    expect(browserToolSummary("browser_resize", { height: 800 })).toEqual({
      primary: "高 800",
    });
    expect(browserToolSummary("browser_resize", {})).toEqual({ primary: "填充面板" });
  });

  test("click / type：ref 优先，修饰键与输入预览", () => {
    const click = browserToolSummary("browser_click", { ref: "e12" });
    expect(click.primary).toBe("ref e12");
    expect(click.secondary).toBeUndefined();

    const modified = browserToolSummary("browser_click", {
      ref: "e12",
      doubleClick: true,
      button: "right",
      modifiers: ["Control", "Shift"],
    });
    expect(modified.primary).toBe("ref e12");
    expect(modified.secondary).toBe("双击 · 右键 · Control+Shift");

    expect(browserToolSummary("browser_click", { x: 10, y: 20 })).toEqual({
      primary: "坐标 10, 20",
    });

    const longText = "a".repeat(100);
    const typed = browserToolSummary("browser_type", {
      ref: "e3",
      text: longText,
      submit: true,
    });
    expect(typed.primary).toBe(`${"a".repeat(80)}…`);
    expect(typed.secondary).toBe("ref e3 · 回车提交");
  });

  test("scroll / drag / wait：方向、坐标与等待条件", () => {
    expect(
      browserToolSummary("browser_scroll", { direction: "up", amount: 600, ref: "e2" }),
    ).toEqual({ primary: "向上 600px", secondary: "ref e2" });
    expect(browserToolSummary("browser_scroll", { deltaX: 0, deltaY: 400 })).toEqual({
      primary: "Δ 0, 400",
    });
    expect(browserToolSummary("browser_drag", { fromRef: "e1", toRef: "e2" })).toEqual({
      primary: "ref e1 → ref e2",
    });
    expect(
      browserToolSummary("browser_drag", {
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
      }),
    ).toEqual({ primary: "1, 2 → 3, 4" });
    expect(
      browserToolSummary("browser_wait_for", { selector: "#done", timeoutMs: 10_000 }),
    ).toEqual({ primary: "选择器 #done", secondary: "10s" });
    expect(
      browserToolSummary("browser_wait_for", { textGone: "加载中", timeoutMs: 500 }),
    ).toEqual({ primary: "等待「加载中」消失", secondary: "0.5s" });
  });

  test("select / check / dialog / shot：附加状态进次行", () => {
    expect(
      browserToolSummary("browser_select", { ref: "e5", values: ["a", "b"] }),
    ).toEqual({ primary: "ref e5", secondary: "选择 a, b" });
    expect(
      browserToolSummary("browser_check", { ref: "e6", checked: false }),
    ).toEqual({ primary: "ref e6", secondary: "取消勾选" });
    expect(
      browserToolSummary("browser_dialog", { accept: false, promptText: "hello" }),
    ).toEqual({ primary: "取消", secondary: "输入「hello」" });
    expect(browserToolSummary("browser_shot", { url: "https://x.test", maxDim: 800 })).toEqual({
      primary: "https://x.test",
      secondary: "最长边 800px",
    });
    expect(
      browserToolSummary("browser_shot", {
        ref: "e9",
        fullPage: true,
        clip: { width: 100, height: 50 },
      }),
    ).toEqual({ primary: "ref e9", secondary: "整页 · 裁剪 100 × 50" });
  });

  test("无参数动作返回空摘要", () => {
    expect(browserToolSummary("browser_snapshot", {})).toEqual({});
    expect(browserToolSummary("browser_back", {})).toEqual({});
  });
});
