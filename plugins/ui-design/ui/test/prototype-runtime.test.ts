/**
 * 原型运行时的**自包含性**测试。
 *
 * 导出侧是把 `prototypeRuntime.toString()` 的源码内联进静态 HTML 的，所以函数体一旦
 * 引用本模块的顶层标识符，就会出现最阴险的一类 bug：面板预览（模块作用域在）一切正常，
 * 导出的 HTML 一打开就 ReferenceError。这类回归静态可查——把源码里的自由标识符
 * 抠出来，跟模块顶层声明比对，交集非空即失败。
 *
 * （这条断言是被真实事故逼出来的：RT_ACTION_TEXT 曾经在函数外，导出件白屏。）
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RUNTIME_CSS, prototypeRuntime, prototypeRuntimeSource, type RuntimePayload } from "../src/prototype-runtime";

const SRC_PATH = path.resolve(import.meta.dir, "../src/prototype-runtime.ts");
const fileText = readFileSync(SRC_PATH, "utf8");

/** 本模块的顶层声明名（const/let/function/type/interface/class） */
function topLevelNames(src: string): string[] {
  const names = new Set<string>();
  const re = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const m of src.matchAll(re)) names.add(m[1]!);
  return [...names];
}

/** 源码里的自由标识符（粗粒度：所有标识符 token 减去 JS 内置与字面量） */
const JS_BUILTINS = new Set([
  "Object", "Array", "String", "Number", "Boolean", "Math", "JSON", "Date", "Set", "Map", "WeakMap",
  "Promise", "Error", "TypeError", "RangeError", "Symbol", "RegExp", "Function", "Infinity", "NaN",
  "undefined", "null", "true", "false", "this", "typeof", "instanceof", "in", "of", "new", "return",
  "const", "let", "var", "function", "if", "else", "for", "while", "do", "break", "continue", "switch",
  "case", "default", "try", "catch", "finally", "throw", "class", "extends", "super", "void", "delete",
  "yield", "await", "async", "static", "get", "set", "export", "import", "from", "as", "keyof", "never",
  "unknown", "any", "string", "number", "boolean", "void", "Record", "Partial", "Readonly",
  "document", "window", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "HTMLElement", "Element",
  "SVGElement", "DOMRect", "KeyboardEvent", "PointerEvent", "MouseEvent", "WheelEvent", "Event",
  "getComputedStyle", "CustomEvent", "Node", "CSS", "URL", "Blob", "FileReader", "Image", "fetch",
]);

function identifiers(src: string): Set<string> {
  const out = new Set<string>();
  // 去掉字符串/模板/注释后再抓标识符，避免把文案里的词当变量
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  for (const m of stripped.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) out.add(m[0]);
  return out;
}

describe("运行时自包含性（导出内联的前提）", () => {
  test("函数体不引用模块顶层标识符（否则导出的 HTML 会 ReferenceError）", () => {
    const body = prototypeRuntime.toString();
    const tops = topLevelNames(fileText).filter((n) => n !== "prototypeRuntime");
    const used = identifiers(body);
    const leaked = tops.filter((n) => used.has(n));
    expect(leaked).toEqual([]);
  });

  test("源码里没有转译器 helper（__name 之类，内联后会找不到）", () => {
    const body = prototypeRuntime.toString();
    const helpers = [...body.matchAll(/\b(__[A-Za-z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]!);
    expect([...new Set(helpers)]).toEqual([]);
  });

  test("toString() 出来的是可直接求值的函数源码", () => {
    const src = prototypeRuntimeSource();
    const rebuilt = new Function(`return (${src});`)();
    expect(typeof rebuilt).toBe("function");
    expect(rebuilt.length).toBe(3); // (root, payload, hooks)
  });

  test("样式表覆盖了全部「有外观」的类（导出只内联这一份 CSS）", () => {
    // 这些类必须真有样式规则，否则导出件会以浏览器默认样式渲染（UI 崩掉）
    const needStyled = [
      ".uir{", ".uir-top", ".uir-btn", ".uir-title", ".uir-stage", ".uir-plane", ".uir-fit",
      ".uir-wrap", ".uir-backdrop", ".uir-backdrop.on", ".uir-hot-layer", ".uir-hot{", ".uir-hot:hover",
      ".uir-hot.dead", ".uir-tag", ".uir-bottom", ".uir-chip", ".uir-chip.on", ".uir-empty",
    ];
    for (const sel of needStyled) expect(RUNTIME_CSS).toContain(sel);

    // 纯 JS 查询钩子（不进样式表，靠后代选择器或自身属性定位）——列在这里是为了
    // 下次有人把某个类改成"有外观"时，能意识到该往 needStyled 里加一条
    const hookOnly = new Set(["uir-ov", "uir-base", "uir-name", "uir-page", "uir-spacer", "uir-exit"]);
    const used = [...new Set([...prototypeRuntime.toString().matchAll(/"(uir[a-z-]*)"/g)].map((m) => m[1]!))];
    expect(used.length).toBeGreaterThan(10);
    for (const c of used) {
      if (hookOnly.has(c)) continue;
      expect(RUNTIME_CSS).toContain(`.${c}`);
    }
  });
});

describe("载荷类型契约", () => {
  test("载荷是 JSON 可序列化的（导出要写进 <script type=application/json>）", () => {
    const payload: RuntimePayload = {
      screens: [{ id: "a", name: "A", w: 100, h: 200, svg: "<svg/>", scroll: "v" }],
      start: "a",
      hotspots: {
        a: [
          {
            nodeId: "n1",
            name: "按钮",
            box: { x: 1, y: 2, w: 3, h: 4 },
            actions: [
              {
                trigger: "tap",
                action: "navigate",
                target: "b",
                targetName: "B",
                transition: "pushLeft",
                duration: 300,
                position: "center",
                dismissOnTapOutside: true,
                scrollPlan: { x: 0, y: 10 },
              },
            ],
            dead: [{ trigger: "tap", action: "navigate", to: "gone" }],
          },
        ],
      },
      triggerLabels: { tap: "单击" },
    };
    const round = JSON.parse(JSON.stringify(payload)) as RuntimePayload;
    expect(round).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain("undefined");
  });
});
