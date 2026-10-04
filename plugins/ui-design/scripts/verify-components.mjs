/**
 * verify-components.mjs —— 无头浏览器实测「组件/实例」在真实 Leafer 场景里的落地：
 *  1) instanceView 的权威 id 是否就是场景节点键（"i1/m1"、"i1/mt#t0" 等）；
 *  2) 内部节点 editable=false（单击只选实例整体）、根节点可选；
 *  3) 覆盖生效（"新" vs 主档 "旧"）、哨兵尺寸回填（i2 未写 w/h → 100×50）；
 *  4) 缩放实例的烘焙几何（i1 是 2×：内部 rect 场景宽 20→40、文本 size 14→28 观感）；
 *  5) 主档改动 live 反映到**全部**实例（换 seed 重载 = 面板轮询磁盘的同一条解析路径）；
 *  6) 坏引用实例画虚线占位（i3#ph）。
 * 口径全走 window.__designLeafer（app/editor/nodes），与用户所见的渲染同一棵树。
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

const MASTER = (color) => ({
  id: "cBtn",
  name: "按钮",
  nodes: [
    {
      id: "m1",
      type: "frame",
      name: "按钮",
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      radius: 8,
      fills: [{ type: "solid", color }],
      children: [
        { id: "m2", type: "rect", x: 10, y: 10, w: 20, h: 20, fills: [{ type: "solid", color: "#ffffff" }] },
        { id: "mt", type: "text", x: 36, y: 18, w: 60, h: 18, runs: [{ text: "旧", size: 14, color: "#ffffff" }] },
      ],
    },
  ],
});

const seed = (color) => ({
  version: 1,
  meta: { name: "组件实测", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      nodes: [
        { id: "bg", type: "rect", x: 0, y: 0, w: 900, h: 600, fills: [{ type: "solid", color: "#fafafa" }] },
        { id: "i1", type: "instance", name: "按钮大", componentId: "cBtn", x: 100, y: 100, w: 200, h: 100, overrides: { mt: { text: "新" } } },
        { id: "i2", type: "instance", name: "按钮原样", componentId: "cBtn", x: 400, y: 100 },
        { id: "i3", type: "instance", name: "孤儿", componentId: "gone", x: 100, y: 320, w: 120, h: 60 },
      ],
    },
  ],
  components: [MASTER(color ?? "#0d99ff")],
});

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
  await page.goto(html);
  await page.waitForFunction(() => !!(window).__designLeafer, null, { timeout: 15000 });
  await page.waitForTimeout(1500); // 场景 patch + fitView 落定
}

await open(seed());

/* ---------- 1. 权威视图 id = 场景键 ---------- */
const scene = await page.evaluate(() => {
  const L = window.__designLeafer;
  const keys = [...L.nodes.keys()];
  const at = (k) => L.nodes.get(k);
  const num = (k, p) => {
    const e = at(k);
    return e ? e.node[p] : undefined;
  };
  return {
    keys,
    i1Editable: at("i1")?.node.editable,
    innerEditable: at("i1/m2")?.node.editable,
    mt1: at("i1/mt#t0")?.node.text,
    mt2: at("i2/mt#t0")?.node.text,
    i2w: num("i2", "width"),
    i1w: num("i1", "width"),
    m2w1: num("i1/m2", "width"),
    m2w2: num("i2/m2", "width"),
    phKeys: keys.filter((k) => k.startsWith("i3#")),
    dash: at("i3#ph")?.node.dashPattern,
    keysSample: keys.filter((k) => k.includes("/")).slice(0, 12),
  };
});
check("场景键含实例根/内部（i1、i1/m1、i1/m2、i1/mt#t0）", ["i1", "i1/m1", "i1/m2", "i1/mt#t0"].every((k) => scene.keys.includes(k)), scene.keysSample);
check("内部节点 editable=false、实例根 editable=true", scene.innerEditable === false && scene.i1Editable === true, { root: scene.i1Editable, inner: scene.innerEditable });

/* ---------- 2. 覆盖 + 哨兵回填 + 缩放烘焙 ---------- */
check("覆盖生效：i1 文本「新」、i2 主档「旧」", scene.mt1 === "新" && scene.mt2 === "旧", { i1: scene.mt1, i2: scene.mt2 });
check("哨兵回填：i2 未写 w/h → 场景宽=主档包围盒 100", scene.i2w === 100, scene.i2w);
check("2× 缩放实例内部烘焙：i1/m2 场景宽 40 = i2/m2 的 2 倍", scene.m2w1 === 40 && scene.m2w2 === 20, { i1: scene.m2w1, i2: scene.m2w2 });

/* ---------- 3. 真实点击：内部命中区选中的是实例整体 ----------
 * i1 根组 around=center（props.x/y 即盒中心，设计系 200×100）；i1/m2 中心
 * 在实例盒局部系 (40,40)，相对盒中心 (100,50) 偏移 (−60,−10)。世界层
 * （根组 parent）x/y/scaleX 即 DesignStage 同步的 view 变换；canvas DOM 偏移加回。
 */
const clickProbe = await page.evaluate(() => {
  const L = window.__designLeafer;
  const root = L.nodes.get("i1")?.node;
  const world = root?.parent;
  if (!world || world.scaleX === undefined) return { skip: "no world transform" };
  const s = world.scaleX;
  const view = L.app.view.getBoundingClientRect();
  const px = view.left + world.x + (root.x + (40 - 100)) * s;
  const py = view.top + world.y + (root.y + (40 - 50)) * s;
  const topEl = document.elementFromPoint(px, py);
  const onCanvas = topEl === L.app.view || L.app.view.contains(topEl);
  return { px, py, onCanvas, s };
});
if (clickProbe.skip || !clickProbe.onCanvas) {
  console.log(`SKIP  内部点击选整（命中点被 UI 面板遮挡）  ${JSON.stringify(clickProbe)}`);
} else {
  await page.mouse.click(clickProbe.px, clickProbe.py);
  await page.waitForTimeout(400);
  const selId = await page.evaluate(() => {
    const L = window.__designLeafer;
    const first = (L.editor.list ?? [])[0];
    if (!first) return null;
    for (const [k, ent] of L.nodes) if (ent.node === first && !k.includes("#")) return k;
    return "?";
  });
  check("单击实例内部 rect 中心 → 选中的是实例整体 i1", selId === "i1", { selId, ...clickProbe });
}

/* ---------- 4. 坏引用占位 ---------- */
check("坏引用 i3 画虚线占位（i3#ph + dashPattern）", scene.phKeys.includes("i3#ph") && Array.isArray(scene.dash) && scene.dash.length >= 2, scene.phKeys);

/* ---------- 5. 主档改动 live 反映到全部实例（重载 = 面板外部刷新同一解析路径） ---------- */
await open(seed("#ff0055"));
const live = await page.evaluate(() => {
  const L = window.__designLeafer;
  const paintOf = (frameKey) => {
    for (const [k, ent] of L.nodes) if (k.startsWith(frameKey + "#") && ent.node.fill) return ent.node.fill;
    return null;
  };
  return { p1: paintOf("i1/m1"), p2: paintOf("i2/m1"), mt: L.nodes.get("i1/mt#t0")?.node.text };
});
const fillHex = (f) => (typeof f === "string" ? f : f?.color ?? JSON.stringify(f));
check("主档换色 → 两个实例同时变（live 解析）", String(fillHex(live.p1)).toLowerCase().includes("ff0055") && String(fillHex(live.p2)).toLowerCase().includes("ff0055"), { i1: fillHex(live.p1), i2: fillHex(live.p2) });
check("重载后覆盖仍在（i1 文本「新」不随主档回退）", live.mt === "新", live.mt);

await page.screenshot({ path: path.resolve(dir, "out-components.png") });
console.log(fails === 0 ? "\nALL PASS（截图 scripts/out-components.png）" : `\n${fails} FAILURES`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
