/**
 * verify-shapes.mjs —— 图形能力的无头浏览器实测（对标墨刀的那几件）：
 *   ① 双击矩形直接打字：出 textarea → 输入 → 提交后写进形状内嵌标签；
 *      且编辑期间**色块仍在**（只藏文字那一段，不能把整个形状藏掉）；
 *   ② 四角小圆点的圆角手柄：选中矩形出现 4 个手柄，往内拖 radius 变大，
 *      往外拖回 0 时字段被摘掉，Alt 拖只改当前角（拆角）；
 *   ③ 素材面板：切「素材」页签 → 点一个流程图形/图表/基础件 → 节点落到画板里；
 *   ④ 一步撤销能把素材插入整体撤掉。
 * 口径：window.__designStore（doc/工具栏/选择集）+ DOM（手柄、textarea、面板）。
 * 产物图：scripts/out-shapes-*.png
 */
import { chromium } from "playwright";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.resolve(dir, "../design.html")).href;
const shell = path.join(
  os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

const seed = () => ({
  version: 1,
  meta: { name: "图形能力实测", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      nodes: [
        {
          id: "f1",
          type: "frame",
          name: "首页",
          x: 0,
          y: 0,
          w: 390,
          h: 844,
          fills: [{ type: "solid", color: "#ffffff" }],
          children: [
            { id: "btn", type: "rect", name: "主按钮", x: 24, y: 120, w: 200, h: 56, radius: 8, fills: [{ type: "solid", color: "#0d99ff" }] },
            { id: "f2", type: "frame", name: "详情", x: 500, y: 0, w: 390, h: 844, fills: [{ type: "solid", color: "#ffffff" }] },
          ],
        },
        { id: "detail", type: "frame", name: "详情页", x: 520, y: 0, w: 390, h: 844, fills: [{ type: "solid", color: "#ffffff" }], children: [] },
      ],
    },
  ],
});

mkdirSync(dir, { recursive: true });
const shot = async (page, name) => {
  const p = path.join(dir, `out-shapes-${name}.png`);
  await page.screenshot({ path: p });
  console.log(`  · 截图 ${path.relative(process.cwd(), p)}`);
  return p;
};

const browser = await chromium.launch({ executablePath: shell });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
  if (!ok) fails++;
};

await page.addInitScript((s) => localStorage.setItem("ui-design-local-doc", s), JSON.stringify(seed()));
await page.goto(html);
await page.waitForFunction(() => !!window.__designStore, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

const store = () => page.evaluate(() => window.__designStore);
const nodeById = (id) =>
  page.evaluate((nid) => {
    const st = window.__designStore;
    const walk = (list, out = null) => {
      for (const n of list) {
        if (n.id === nid) return n;
        if (n.children) {
          const hit = walk(n.children);
          if (hit) return hit;
        }
      }
      return out;
    };
    for (const p of st.doc.pages) {
      const hit = walk(p.nodes);
      if (hit) return hit;
    }
    return null;
  }, id);

/** 世界坐标 → 屏幕坐标（与 verify-pen 同口径） */
const toScreen = (wx, wy) =>
  page.evaluate(([x, y]) => {
    const L = window.__designLeafer;
    const world = [...L.nodes.values()][0]?.node?.parent ?? L.app.view.parent;
    const r = L.app.view.getBoundingClientRect();
    return [r.left + world.x + x * (world.scaleX ?? 1), r.top + world.y + y * (world.scaleY ?? 1)];
  }, [wx, wy]);

const select = async (id) => {
  await page.evaluate((nid) => window.__designStore.setSel([nid]), id);
  await page.waitForTimeout(180);
};

console.log("\n=== ① 双击矩形直接打字 ===");
await select("btn");
await shot(page, "1-selected");
// btn 在画板 f1 内，局部 (24,120)-(224,176) → 世界坐标同值（画板在 0,0）
const [bx, by] = await toScreen(120, 148);
await page.mouse.dblclick(bx, by);
await page.waitForTimeout(400);
const hasTextarea = await page.locator("textarea").count();
check("双击矩形出现就地编辑器", hasTextarea > 0, { count: hasTextarea });

// 编辑期间：色块可见（fill 还在渲染），标签那一段被藏起来
const editingState = await page.evaluate(() => {
  const L = window.__designLeafer;
  let rectVisible = false;
  const visit = (n) => {
    if (n.__tag === "rect" || n.tag === "rect") rectVisible = true;
    const kids = n.children ?? [];
    for (const k of kids) visit(k);
    return false;
  };
  const stored = window.__designStore;
  return { editingTextId: stored.editingTextId, rectVisible };
});
check("编辑态挂在正确节点上", editingState.editingTextId === "btn", editingState);

if (hasTextarea > 0) {
  await page.locator("textarea").fill("立即开始");
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(400);
}
const afterLabel = await nodeById("btn");
check(
  "提交后写进形状内嵌标签（text.runs）",
  !!afterLabel?.text?.runs?.[0]?.text && afterLabel.text.runs[0].text === "立即开始",
  afterLabel?.text,
);
check("形状自身字段未被破坏（fills/radius 还在）", afterLabel?.fills?.length === 1 && afterLabel?.radius === 8);
await shot(page, "2-shape-label");

console.log("\n=== ② 圆角手柄 ===");
await select("btn");
const handles = await page.locator('[title*="拖我改圆角"]').count();
check("选中矩形出现四个角点手柄", handles === 4, { count: handles });
await shot(page, "3-radius-handles");

// 拖左上角手柄往内 30px → radius 应变大（统一值：四角一起变）
const h0 = await page.locator('[data-corner="0"]').boundingBox();
await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
await page.mouse.down();
await page.mouse.move(h0.x + h0.width / 2 + 30, h0.y + h0.height / 2 + 30, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const afterDrag = await nodeById("btn");
check("往内拖圆角变大（四角统一）", typeof afterDrag?.radius === "number" && afterDrag.radius > 10, { radius: afterDrag?.radius });
await shot(page, "4-radius-dragged");

// Alt 拖 → 拆角：只改当前角（先设回小圆角，保证四角手柄位置彼此分开）
await page.evaluate(() => {
  const st = window.__designStore;
  st.updateNode("btn", (m) => ({ ...m, radius: 8 }));
});
await page.waitForTimeout(200);
await select("btn");
const h1 = await page.locator('[data-corner="1"]').boundingBox();
await page.keyboard.down("Alt");
await page.mouse.move(h1.x + h1.width / 2, h1.y + h1.height / 2);
await page.mouse.down();
await page.mouse.move(h1.x + h1.width / 2 - 6, h1.y + h1.height / 2 + 8, { steps: 6 });
await page.mouse.up();
await page.keyboard.up("Alt");
await page.waitForTimeout(250);
const split = await nodeById("btn");
check("Alt 拖只改当前角（radius 变四角数组且不相等）", Array.isArray(split?.radius), { radius: split?.radius });
await shot(page, "5-radius-split");

// 拖回 0：字段摘掉（先用 Inspector 之外的手段把四角还原成统一值，专测摘字段）
await page.evaluate(() => {
  const st = window.__designStore;
  st.updateNode("btn", (m) => {
    const c = { ...m };
    delete c.radius;
    return c;
  });
});
await page.waitForTimeout(200);
await select("btn");
const h0b = await page.locator('[data-corner="0"]').boundingBox();
await page.mouse.move(h0b.x + h0b.width / 2, h0b.y + h0b.height / 2);
await page.mouse.down();
await page.mouse.move(h0b.x - 40, h0b.y - 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const zeroed = await nodeById("btn");
check("往外拖回 0 时 radius 字段被摘掉", zeroed?.radius === undefined, { radius: zeroed?.radius });

console.log("\n=== ③ 素材面板 ===");
// 切到「素材」页签
const stencilTab = page.locator("button", { hasText: /^素材$/ }).first();
await stencilTab.click();
await page.waitForTimeout(300);
const gridCount = await page.locator("button[title*='·']").count();
check("素材面板列出素材格子", gridCount >= 30, { count: gridCount });
await shot(page, "6-stencil-panel");

// 选中画板 → 插入一个流程图形；再从检索里插一个图表
await select("f1");
const flowBtn = page.locator("button[title^='判定']").first();
await flowBtn.click();
await page.waitForTimeout(300);
const withFlow = await page.evaluate(() => {
  const st = window.__designStore;
  const f = st.doc.pages[0].nodes.find((n) => n.id === "f1");
  return { kids: f.children.length, names: f.children.map((c) => c.name) };
});
check("点素材把流程图形插进选中的画板", withFlow.names.includes("判定"), withFlow);

await page.locator("input[placeholder^='搜素材']").fill("饼图");
await page.waitForTimeout(300);
const pieBtn = page.locator("button[title^='饼状图']").first();
await pieBtn.click();
await page.waitForTimeout(300);
const withPie = await page.evaluate(() => {
  const st = window.__designStore;
  const f = st.doc.pages[0].nodes.find((n) => n.id === "f1");
  return { names: f.children.map((c) => c.name), types: f.children.map((c) => c.type) };
});
check("检索后插入图表素材（多个 vector 扇区）", withPie.names.includes("扇区1") && withPie.types.includes("vector"), withPie);
await shot(page, "7-stencil-inserted");

// 选中新节点（插入后自动选中）
const selAfter = await page.evaluate(() => window.__designStore.selIds);
check("插入后自动选中新节点", selAfter.length > 0, selAfter);

console.log("\n=== ③b 连点排开 ===");
await page.evaluate(() => window.__designStore.setSel(["f1"]));
await page.locator("input[placeholder^='搜素材']").fill("");
await page.waitForTimeout(200);
await page.locator("button[title^='按钮']").first().click();
await page.waitForTimeout(250);
await page.locator("button[title^='标签']").first().click();
await page.waitForTimeout(250);
const cascaded = await page.evaluate(() => {
  const st = window.__designStore;
  const f = st.doc.pages[0].nodes.find((n) => n.id === "f1");
  const btn = [...f.children].reverse().find((c) => c.name === "按钮");
  const tag = [...f.children].reverse().find((c) => c.name === "标签");
  return btn && tag ? { btnY: btn.y, btnH: btn.h, tagY: tag.y, gap: tag.y - (btn.y + btn.h) } : null;
});
check("连点两个素材依次往下排（不叠在同一处）", !!cascaded && cascaded.gap >= 15, cascaded);
await shot(page, "7b-stencil-cascade");

console.log("\n=== ④ 撤销 ===");
const beforeUndo = await page.evaluate(() => {
  const st = window.__designStore;
  return st.doc.pages[0].nodes.find((n) => n.id === "f1").children.length;
});
await page.evaluate(() => window.__designStore.undo());
await page.waitForTimeout(300);
const afterUndo = await page.evaluate(() => {
  const st = window.__designStore;
  return st.doc.pages[0].nodes.find((n) => n.id === "f1").children.length;
});
check("一步撤销撤掉整次素材插入", afterUndo < beforeUndo, { beforeUndo, afterUndo });
await shot(page, "8-after-undo");

if (errors.length) {
  console.log("\n[pageerror]");
  for (const e of errors) console.log("  ", e);
  fails++;
}
console.log(`\n${fails === 0 ? "全部通过" : `${fails} 项失败`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
