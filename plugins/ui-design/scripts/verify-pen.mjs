/**
 * verify-pen.mjs —— 无头浏览器实测「钢笔工具」在真实画布上的落地：
 *  1) setTool("pen") → 点击三锚（其一按拖出平滑柄）→ Enter 收笔 → 画布落 vector 节点
 *     （path 含 C 段、盒/选中/工具复位全对）；
 *  2) 一步 undo → 节点消失（钢笔落图 = 一步可撤销）；
 *  3) Esc 中途取消 → 不落节点；
 *  4) 点击首锚闭合 → path 以 Z 结尾（填充面）。
 * 口径：window.__designStore（setTool/doc/undo）+ leafer app.view 几何换算真实鼠标事件。
 */
import { chromium } from "playwright";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.resolve(dir, "../design.html")).href;
const shell = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell");

const seed = () => ({
  version: 1,
  meta: { name: "钢笔实测", kind: "uidesign" },
  activePage: "p1",
  pages: [{ id: "p1", name: "Page 1", nodes: [{ id: "bg", type: "rect", x: 0, y: 0, w: 900, h: 600, fills: [{ type: "solid", color: "#fafafa" }] }] }],
});

const browser = await chromium.launch({ executablePath: shell });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
  if (!ok) fails++;
};

await page.addInitScript((s) => localStorage.setItem("ui-design-local-doc", s), JSON.stringify(seed()));
await page.goto(html);
await page.waitForFunction(() => !!(window).__designLeafer && !!(window).__designStore, null, { timeout: 15000 });
await page.waitForTimeout(1500);

// 世界坐标 → 屏幕坐标（leafer world group 变换 + canvas DOM 偏移）
const toScreen = (wx, wy) =>
  page.evaluate(([x, y]) => {
    const L = window.__designLeafer;
    const world = [...L.nodes.values()][0]?.node?.parent ?? L.app.view.parent;
    const r = L.app.view.getBoundingClientRect();
    return [r.left + world.x + x * (world.scaleX ?? 1), r.top + world.y + y * (world.scaleY ?? 1)];
  }, [wx, wy]);

const clickAt = async (wx, wy) => {
  const [x, y] = await toScreen(wx, wy);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
};
const dragAt = async (wx, wy, dx, dy) => {
  const [x, y] = await toScreen(wx, wy);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(120);
};

const readDoc = () => page.evaluate(() => {
  const d = window.__designStore.doc;
  const vecs = [];
  for (const n of d.pages.find((p) => p.id === d.activePage).nodes) if (n.type === "vector") vecs.push(n);
  return { vectors: vecs.length, node: vecs[vecs.length - 1] ?? null, sel: window.__designStore.selIds, tool: window.__designStore.tool };
});

/* ---------- 1. 画开放曲线路径 → Enter 收笔 ---------- */
await page.evaluate(() => window.__designStore.setTool("pen"));
await page.waitForTimeout(200);
await clickAt(200, 200);
await clickAt(360, 200);
await dragAt(520, 200, 40, 60); // 按拖 → 平滑锚（C 段）
const d1 = await readDoc();
check("绘制中不落节点（Enter 前无 vector）", d1.vectors === 0, d1.vectors);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const d2 = await readDoc();
const n = d2.node;
check(
  "Enter 收笔 → 落 vector（path 含 C、盒覆盖锚点、选中、工具复位）",
  d2.vectors === 1 && n && typeof n.path === "string" && n.path.startsWith("M") && n.path.includes(" C ") &&
    n.x <= 200 && n.x + n.w >= 560 && d2.sel.length === 1 && d2.tool === "select",
  { vectors: d2.vectors, path: n?.path, x: n?.x, w: n?.w, tool: d2.tool },
);

/* ---------- 2. 一步 undo 撤销钢笔落图 ---------- */
await page.evaluate(() => window.__designStore.undo());
await page.waitForTimeout(300);
const d3 = await readDoc();
check("一步 undo → vector 消失", d3.vectors === 0, d3.vectors);

/* ---------- 3. Esc 中途取消 ---------- */
await page.evaluate(() => window.__designStore.setTool("pen"));
await page.waitForTimeout(150);
await clickAt(200, 420);
await clickAt(360, 420);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
const d4 = await readDoc();
check("Esc 中途取消 → 不落节点", d4.vectors === 0, d4.vectors);

/* ---------- 4. 点首锚闭合 → path 带 Z ---------- */
await page.evaluate(() => window.__designStore.setTool("pen"));
await page.waitForTimeout(150);
await clickAt(600, 400);
await clickAt(760, 400);
await clickAt(760, 520);
await clickAt(600, 400); // 点回首锚 → 闭合
await page.waitForTimeout(300);
const d5 = await readDoc();
const n5 = d5.node;
check("点首锚闭合 → path 以 Z 收尾 + 默认灰填充成形", d5.vectors === 1 && typeof n5?.path === "string" && n5.path.endsWith("Z") && n5.fills?.[0]?.color === "#d9d9d9", { path: n5?.path, fills: n5?.fills });

/* ---------- 5. 缩放态（150%、非零平移）落笔：落点必须仍等于点击的世界坐标 ---------- */
await page.evaluate(() => window.__designStore.setView({ s: 1.5, tx: -100, ty: -80 }));
await page.waitForTimeout(400);
await page.evaluate(() => window.__designStore.setTool("pen"));
await page.waitForTimeout(150);
await clickAt(150, 150);
await clickAt(350, 150);
await clickAt(350, 300);
await clickAt(150, 150);
await page.waitForTimeout(300);
const d6 = await readDoc();
const n6 = d6.node;
check(
  "缩放态落笔（150%）→ 盒精确等于点击世界坐标",
  n6 && Math.abs(n6.x - 150) < 0.5 && Math.abs(n6.y - 150) < 0.5 && Math.abs(n6.w - 200) < 0.5 && Math.abs(n6.h - 150) < 0.5,
  { x: n6?.x, y: n6?.y, w: n6?.w, h: n6?.h },
);

/* ---------- 6. 两点绘制中的预览直线必须连在两锚点的屏幕位置（回归：路径曾按世界坐标输出→整体偏移） ---------- */
const base6 = (await readDoc()).vectors;
await page.evaluate(() => window.__designStore.setView({ s: 0.8, tx: 120, ty: 60 }));
await page.waitForTimeout(400);
await page.evaluate(() => window.__designStore.setTool("pen"));
await page.waitForTimeout(150);
await clickAt(300, 250);
await clickAt(600, 420);
const pv = await page.evaluate(() => {
  const p = document.querySelector('path[data-pen-preview="line"]');
  if (!p) return null;
  const L = window.__designLeafer;
  const world = [...L.nodes.values()][0]?.node?.parent ?? L.app.view.parent;
  const s = world.scaleX ?? 1;
  const ox = world.x ?? 0;
  const oy = world.y ?? 0;
  const svgR = p.ownerSVGElement.getBoundingClientRect();
  const canvasR = L.app.view.getBoundingClientRect();
  const shift = [svgR.left - canvasR.left, svgR.top - canvasR.top]; // 两者应同框（差=0）
  const nums = (p.getAttribute("d").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const exp = (wx, wy) => [wx * s + ox + shift[0], wy * s + oy + shift[1]];
  const ea = exp(300, 250);
  const eb = exp(600, 420);
  return { d: p.getAttribute("d"), n0: [nums[0], nums[1]], n1: [nums[2], nums[3]], ea, eb };
});
check(
  "绘制中预览线段 = 两锚点屏幕连线（0.8x/非零平移）",
  pv && Math.abs(pv.n0[0] - pv.ea[0]) < 0.6 && Math.abs(pv.n0[1] - pv.ea[1]) < 0.6 &&
    Math.abs(pv.n1[0] - pv.eb[0]) < 0.6 && Math.abs(pv.n1[1] - pv.eb[1]) < 0.6,
  pv ? { d: pv.d, start: pv.n0, expect: pv.ea, end: pv.n1, expectEnd: pv.eb } : "no preview path",
);
await page.screenshot({ path: path.resolve(dir, "out-pen-preview.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(250);
const d7 = await readDoc();
check("场景6取消后节点数不变", d7.vectors === base6, { before: base6, after: d7.vectors });

/* ---------- 7. 回路悬浮闭合（PS 式）：悬停首锚 → 成形预览+靶标+光标；移开消失；点下闭合成形状 ---------- */
await page.evaluate(() => window.__designStore.setView({ s: 1, tx: 0, ty: 0 }));
await page.waitForTimeout(400);
await page.evaluate(() => window.__designStore.setTool("pen"));
await page.waitForTimeout(150);
await clickAt(420, 140);
await clickAt(560, 140);
await clickAt(490, 260);
const [fx, fy] = await toScreen(420, 140);
await page.mouse.move(fx - 2, fy - 2);
await page.waitForTimeout(180);
const hov = await page.evaluate(() => {
  const ov = document.querySelector("[data-pen-overlay]");
  return {
    close: !!document.querySelector('path[data-pen-preview="close"]'),
    target: !!document.querySelector('g[data-pen-preview="target"]'),
    cursor: ov ? getComputedStyle(ov).cursor : "",
  };
});
check("悬停首锚 → PS 式闭合原型（形状填充预览 + 靶标 + cell 光标）", hov.close && hov.target && hov.cursor === "cell", hov);
await page.screenshot({ path: path.resolve(dir, "out-pen-close.png") });
const [mx, my] = await toScreen(240, 460);
await page.mouse.move(mx, my);
await page.waitForTimeout(180);
const away = await page.evaluate(() => ({
  close: !!document.querySelector('path[data-pen-preview="close"]'),
  cursor: getComputedStyle(document.querySelector("[data-pen-overlay]") || document.body).cursor,
}));
check("移开首锚 → 闭合原型消失、光标复位", !away.close && away.cursor === "crosshair", away);
await page.mouse.move(fx - 2, fy - 2);
await page.waitForTimeout(150);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(300);
const d8 = await readDoc();
check(
  "悬停处点击 → 闭合成形状（Z + 默认灰填充、无描边）",
  d8.node && d8.node.path.endsWith("Z") && d8.node.fills?.[0]?.color === "#d9d9d9" && (d8.node.strokes?.length ?? 0) === 0,
  { path: d8.node?.path, fills: d8.node?.fills, strokes: d8.node?.strokes },
);

await page.screenshot({ path: path.resolve(dir, "out-pen.png") });
console.log(fails === 0 ? "\nALL PASS（截图 scripts/out-pen.png）" : `\n${fails} FAILURES`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
