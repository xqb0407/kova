/**
 * verify-undo-import.mjs —— 无头浏览器实测「撤销可靠性 + 统一导入」：
 *  A) applyExternalWrite：干净本地态下外部写 = 一步可撤销历史（undo 回旧档 / redo 重放），
 *     不再走"freshReset 清空撤销栈"的旧路（并行 agent 写盘场景的主修案）。
 *  B) setLayout → undo → redo：钉死快照污染 bug——修前 commit 的"改前"快照已被 reflowWithin
 *     就地变异污染，这类操作撤销是 no-op；修后字段与几何必须双双回退/重放。
 *  C) 真实键盘：ArrowRight 微调 + ⌘Z 撤销（走 window keydown → useHotkeys → nudge）。
 *  D) importFiles(SVG)：画布层出帧节点（rect+ellipse+烘焙色），一步 undo 全撤。
 *  E) importFiles(设计档 JSON)：页并入 + 实例 componentId/overrides key 重映射仍解析，一步 undo 全撤。
 * 口径：window.__designStore（App 每渲染刷新句柄）+ 文档读回，全走真实 React 状态核。
 */
import { chromium } from "playwright";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.resolve(dir, "../design.html")).href;
const shell = path.join(
  os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

const seed = () => ({
  version: 1,
  meta: { name: "撤销导入实测", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      nodes: [
        { id: "bg", type: "rect", x: 0, y: 0, w: 1200, h: 700, fills: [{ type: "solid", color: "#fafafa" }] },
        {
          id: "f1",
          type: "frame",
          name: "画板",
          x: 60,
          y: 60,
          w: 300,
          h: 300,
          fills: [{ type: "solid", color: "#ffffff" }],
          children: [
            { id: "ch1", type: "rect", x: 10, y: 10, w: 100, h: 30, fills: [{ type: "solid", color: "#0d99ff" }] },
            { id: "ch2", type: "rect", x: 10, y: 60, w: 100, h: 30, fills: [{ type: "solid", color: "#ff5533" }] },
          ],
        },
        { id: "r1", type: "rect", x: 500, y: 100, w: 120, h: 60, fills: [{ type: "solid", color: "#22aa44" }] },
        { id: "nv", type: "rect", x: 800, y: 100, w: 40, h: 40, fills: [{ type: "solid", color: "#8844ff" }] },
      ],
    },
  ],
});

const SVG_TEXT =
  "<svg width='60' height='40'><rect x='0' y='0' width='60' height='40' fill='#22aa44' rx='6'/>" +
  "<circle cx='30' cy='20' r='10' fill='none' stroke='black' stroke-width='2'/></svg>";

const SOURCE_DOC = {
  version: 1,
  meta: { name: "来源", kind: "uidesign" },
  activePage: "sp",
  pages: [
    {
      id: "sp",
      name: "来源页",
      nodes: [
        {
          id: "sf",
          type: "frame",
          name: "来源画板",
          x: 1400,
          y: 0,
          w: 200,
          h: 200,
          fills: [{ type: "solid", color: "#ffffff" }],
          children: [
            { id: "si", type: "instance", name: "按钮", componentId: "sc", x: 20, y: 80, w: 100, h: 40, overrides: { sr: { x: 33 } } },
          ],
        },
      ],
    },
  ],
  components: [
    { id: "sc", name: "按钮", nodes: [{ id: "sr", type: "rect", x: 0, y: 0, w: 100, h: 40, fills: [{ type: "solid", color: "#ff8800" }] }] },
  ],
};

const browser = await chromium.launch({ executablePath: shell });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
  if (!ok) fails++;
};

async function open(seedObj) {
  await page.addInitScript((s) => localStorage.setItem("ui-design-local-doc", s), JSON.stringify(seedObj));
  await page.addInitScript((src) => { (0, eval)(src); }, HELPERS);
  await page.goto(html);
  await page.waitForFunction(() => !!(window).__designLeafer && !!(window).__designStore, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
}

// 页内通用读法挂到 window（避免 direct-eval 的 const 不外泄问题）：整档找节点（页面树 + 组件主档树）
const HELPERS = `
window.__D = () => window.__designStore.doc;
window.__findN = (id) => {
  let hit = null;
  const walk = (l) => { for (const n of (l ?? [])) { if (n.id === id) hit = n; walk(n.children); } };
  for (const p of window.__D().pages) walk(p.nodes);
  for (const c of window.__D().components ?? []) walk(c.nodes);
  return hit;
};
window.__activeNodes = () => { const d = window.__D(); return d.pages.find((p) => p.id === d.activePage).nodes; };
`;

/* ---------- A. 外部写 = 一步可撤销（干净本地态） ---------- */
await open(seed());
const a = await page.evaluate(
  async ([extJson]) => {
    const s = window.__designStore;
    s.applyExternalWrite(extJson);
    await new Promise((r) => setTimeout(r, 300));
    const afterExt = window.__findN("r1")?.x;
    window.__designStore.undo();
    await new Promise((r) => setTimeout(r, 300));
    const afterUndo = window.__findN("r1")?.x;
    window.__designStore.redo();
    await new Promise((r) => setTimeout(r, 300));
    const afterRedo = window.__findN("r1")?.x;
    const conflictOpen = /冲突/.test(document.body.innerText);
    return { afterExt, afterUndo, afterRedo, conflictOpen };
  },
  [
    JSON.stringify({
      ...seed(),
      pages: [
        {
          ...seed().pages[0],
          nodes: seed().pages[0].nodes.map((n) => (n.id === "r1" ? { ...n, x: 666 } : n)),
        },
      ],
    }),
  ],
);
check("外部写生效（r1.x 500→666）", a.afterExt === 666, a);
check("单步 undo 回退外部写（666→500）", a.afterUndo === 500, a);
check("redo 重放外部写（500→666）", a.afterRedo === 666, a);
check("干净态外部写不弹冲突框", a.conflictOpen === false, a);

/* ---------- B. setLayout 的撤销/重做（钉死快照污染） ---------- */
await open(seed());
const b = await page.evaluate(async () => {
  const beforeY = window.__findN("ch2").y;
  window.__designStore.setLayout("f1", { mode: "vertical", gap: 24, padding: 10 });
  await new Promise((r) => setTimeout(r, 300));
  const laidOut = window.__findN("f1")?.layout;
  const afterY = window.__findN("ch2").y;
  window.__designStore.undo();
  await new Promise((r) => setTimeout(r, 300));
  const uLaidOut = window.__findN("f1")?.layout;
  const uY = window.__findN("ch2").y;
  window.__designStore.redo();
  await new Promise((r) => setTimeout(r, 300));
  const rLaidOut = window.__findN("f1")?.layout;
  const rY = window.__findN("ch2").y;
  return { beforeY, afterY, uY, rY, hadLayout: !!laidOut, undone: !uLaidOut, redone: !!rLaidOut };
});
check("setLayout 立即重排（ch2.y 挪动 + layout 落字段）", b.beforeY !== b.afterY && b.hadLayout, b);
check("undo：layout 字段与几何同步回退（污染 bug 已钉死）", b.undone && b.uY === b.beforeY, b);
check("redo：layout 与几何重放", b.redone && b.rY === b.afterY, b);

/* ---------- C. 真实键盘：方向键微调 + ⌘Z ---------- */
await page.evaluate(() => {
  window.__designStore.setSel(["nv"]);
});
await page.waitForTimeout(200);
const read = (id) =>
  page.evaluate((x) => {
    return window.__findN(x)?.x;
  }, id);
const cx = await read("nv");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(300);
const c1 = await read("nv");
await page.keyboard.press("Meta+z");
await page.waitForTimeout(300);
const c2 = await read("nv");
await page.keyboard.press("Meta+Shift+z");
await page.waitForTimeout(300);
const c3 = await read("nv");
check("方向键微调生效（+1px）", c1 === cx + 1, { cx, c1 });
check("真实 ⌘Z 撤销微调", c2 === cx, { cx, c2 });
check("真实 ⌘⇧Z 重做", c3 === cx + 1, { c3 });

/* ---------- D. importFiles：SVG → 帧节点一步全撤 ---------- */
const d = await page.evaluate(
  async ([svgText]) => {
    const n0 = window.__activeNodes().length;
    const f = new File([svgText], "icon.svg", { type: "image/svg+xml" });
    await window.__designStore.importFiles([f], { x: 60, y: 420 });
    await new Promise((r) => setTimeout(r, 400));
    const nodes = window.__activeNodes();
    const frame = nodes.find((x) => x.name === "icon" && x.type === "frame");
    const kidTypes = (frame?.children ?? []).map((k) => k.type);
    const rectFill = (frame?.children ?? []).find((k) => k.type === "rect")?.fills?.[0]?.color;
    window.__designStore.undo();
    await new Promise((r) => setTimeout(r, 400));
    return { n0, n1: nodes.length, hasFrame: !!frame, kidTypes, rectFill, n2: window.__activeNodes().length };
  },
  [SVG_TEXT],
);
check(
  "SVG 导入出帧（顶层 +1、子节点 rect+ellipse、烘焙色）",
  d.n1 === d.n0 + 1 && d.hasFrame && d.kidTypes.join(",") === "rect,ellipse" && d.rectFill === "#22aa44",
  d,
);
check("一步 undo 全撤 SVG 导入", d.n2 === d.n0, d);

/* ---------- E. importFiles：设计档 JSON → 页并入 + 引用重映射 ---------- */
const e = await page.evaluate(
  async ([srcJson]) => {
    const p0 = window.__D().pages.length;
    const f = new File([srcJson], "src.uidesign.json", { type: "application/json" });
    await window.__designStore.importFiles([f]);
    await new Promise((r) => setTimeout(r, 400));
    const D = window.__D();
    const newPage = D.pages[D.pages.length - 1];
    const inst = newPage?.nodes[0]?.children?.[0];
    const comps = D.components ?? [];
    const comp = comps.find((c) => c.id === inst?.componentId);
    const master = comp?.nodes?.[0];
    const remapped = !!(inst && comp && master && inst.overrides && inst.overrides[master.id] && inst.id !== "si" && comp.id !== "sc");
    const pLen = D.pages.length;
    const activeKept = D.activePage === "p1";
    window.__designStore.undo();
    await new Promise((r) => setTimeout(r, 400));
    return { p0, pLen, compCount: comps.length, remapped, activeKept, back: window.__D().pages.length === p0 };
  },
  [JSON.stringify(SOURCE_DOC)],
);
check("JSON 导入并页（2 页、activePage 不变）", e.pLen === 2 && e.activeKept, e);
check("导入后实例引用重映射仍解析（componentId/覆盖 key 指向重发 id）", e.remapped, e);
check("一步 undo 全撤 JSON 导入", e.back, e);

await page.waitForTimeout(500);
await page.screenshot({ path: path.resolve(dir, "out-undo-import.png") });
console.log(fails === 0 ? "\nALL PASS（截图 scripts/out-undo-import.png）" : `\n${fails} FAILURES`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
