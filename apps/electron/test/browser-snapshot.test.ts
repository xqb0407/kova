import { describe, expect, test } from "bun:test";
import {
  SNAPSHOT_JS,
  SNAPSHOT_MAX_LINES,
  checkScript,
  focusScript,
  formatSnapshot,
  probeScript,
  readValueScript,
  resolveScript,
  selectScript,
  selectTextScript,
  typeTextScript,
  type BrowserSnapshotData,
} from "../main/browser-snapshot";

function base(overrides: Partial<BrowserSnapshotData> = {}): BrowserSnapshotData {
  return {
    ok: true,
    url: "https://example.com/app",
    title: "Example",
    scrollX: 0,
    scrollY: 120,
    innerWidth: 1280,
    innerHeight: 800,
    elements: [],
    dom: [],
    ...overrides,
  };
}

const checkbox = {
  ref: "e1",
  tag: "input",
  role: "checkbox",
  name: "Subscribe to updates",
  checked: true,
  selector: "#subscribe",
  rect: { x: 10, y: 20, width: 16, height: 16 },
  inViewport: true,
};

const input = {
  ref: "e2",
  tag: "input",
  role: "textbox",
  name: "Email",
  value: "a@b.com",
  selector: "form > input:nth-of-type(1)",
  rect: { x: 10, y: 50, width: 200, height: 32 },
  inViewport: true,
};

describe("snapshot formatting", () => {
  test("checkbox 用关联 label 名，不再显示 value=on", () => {
    const out = formatSnapshot(base({ elements: [checkbox] }));
    expect(out.output).toContain('checkbox "Subscribe to updates"');
    expect(out.output).toContain("checked");
    expect(out.output.includes('"on"')).toBe(false);
    expect(out.empty).toBe(false);
  });

  test("输入框带 value/selector，页头带滚动与视口", () => {
    const out = formatSnapshot(base({ elements: [input] }));
    expect(out.output).toContain('value="a@b.com"');
    expect(out.output).toContain("sel=form > input:nth-of-type(1)");
    expect(out.output).toContain("scroll=0,120");
    expect(out.output).toContain("viewport=1280x800");
  });

  test("disabled / offscreen 状态可见", () => {
    const out = formatSnapshot(
      base({
        elements: [
          {
            ...input,
            ref: "e3",
            name: "Submit",
            role: "button",
            disabled: true,
            inViewport: false,
          },
        ],
      }),
    );
    expect(out.output).toContain("disabled");
    expect(out.output).toContain("offscreen");
  });

  test("页面文本段按 depth 缩进", () => {
    const out = formatSnapshot(
      base({
        dom: [
          { tag: "h1", depth: 0, inViewport: true, text: "Welcome" },
          { tag: "p", depth: 1, inViewport: true, text: "Hello world" },
        ],
      }),
    );
    expect(out.output).toContain('- h1 "Welcome"');
    expect(out.output).toContain('  - p "Hello world"');
  });

  test("行数硬上限：超量元素被截断并标注", () => {
    const elements = Array.from({ length: 600 }, (_, i) => ({
      ...input,
      ref: `e${i + 1}`,
      selector: `div:nth-of-type(${i + 1})`,
    }));
    const out = formatSnapshot(base({ elements }));
    expect(out.truncated).toBe(true);
    expect(out.output.split("\n").length <= SNAPSHOT_MAX_LINES + 1).toBe(true);
    expect(out.output).toContain("（快照被截断");
  });

  test("空页面：empty 标记供调用方补 canvas 提示", () => {
    const out = formatSnapshot(base());
    expect(out.empty).toBe(true);
    expect(out.output).toContain("（无）");
  });
});

describe("snapshot scripts", () => {
  test("SNAPSHOT_JS 使用 __kovaRefs 与 label 关联，不再写 data-xr-ref", () => {
    expect(SNAPSHOT_JS).toContain("window.__kovaRefs");
    expect(SNAPSHOT_JS).toContain("aria-labelledby");
    expect(SNAPSHOT_JS).toContain("label[for=");
    expect(SNAPSHOT_JS.includes("data-xr-ref")).toBe(false);
  });

  test("resolve/select/check/probe 脚本内插 ref 与参数", () => {
    expect(resolveScript("e12")).toContain('map.get("e12")');
    expect(resolveScript("e12")).toContain("scrollIntoView");
    // 拖拽用 no-scroll 版本：不能把另一个端点的坐标滚走
    expect(resolveScript("e12", false)).not.toContain("scrollIntoView");
    expect(resolveScript("e12", false)).toContain("outside the viewport");
    expect(selectScript("e3", ["a", "b"])).toContain('["a","b"]');
    expect(checkScript("e4", false)).toContain("el.checked !== false");
    expect(probeScript({ text: "Done" })).toContain('"Done"');
    // click/focus 走 __kovaRefs + scrollIntoView
    expect(focusScript("e6")).toContain("el.focus()");
    // select-all：insertText 是光标处插入，全选后才等价「替换现有文本」
    expect(selectTextScript("e7")).toContain("el.select()");
    expect(selectTextScript("e7")).toContain("selectNodeContents");
    // 聚焦脚本顺带回传可编辑性与原值（browser_type 据此判断输入有没有落上）
    expect(selectTextScript("e7")).toContain("editable");
    expect(selectTextScript("e7")).toContain("value: before");
  });

  test("readValueScript 回读目标元素的值与焦点状态", () => {
    const script = readValueScript("e8");
    expect(script).toContain('map.get("e8")');
    expect(script).toContain("el.value");
    expect(script).toContain("activeElement");
    expect(script).toContain("value: String(value)");
  });

  test("typeTextScript 页面内替换并回传插入前后值", () => {
    const script = typeTextScript("e9", "hello");
    expect(script).toContain('map.get("e9")');
    // 主路径不依赖浏览器焦点：页面内 execCommand 写入
    expect(script).toContain('execCommand("insertText"');
    expect(script).toContain("read-only");
    expect(script).toContain("does not accept text");
    expect(script).toContain("before: before");
    expect(script).toContain("value: after");
  });
});
