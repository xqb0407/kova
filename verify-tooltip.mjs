/**
 * 运行验证：顶部边缘按钮的 tooltip 向下弹出、完全可见；底部工具仍向上弹出（回归）。
 * 用法：node verify-tooltip.mjs（仓库根目录）
 */
import { chromium } from "playwright";

const EXE = "/Users/herther/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const PAGE_URL = "file:///Users/herther/Desktop/ai-teamplte/plugins/ui-design/design.html";

const doc = {
  version: 1,
  meta: { name: "tooltip 验证", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "页面 1",
      nodes: [
        { id: "f1", type: "frame", name: "首页", x: 0, y: 0, w: 300, h: 500, fills: [{ type: "solid", color: "#ff7a59" }] },
        { id: "f2", type: "text", name: "标题", x: 420, y: 40, w: 200, h: 40, runs: [{ text: "tooltip", size: 24 }] },
      ],
    },
  ],
};

let step = 0;
const ok = (msg) => console.log(`  ✅ ${++step}. ${msg}`);

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await ctx.addInitScript((d) => {
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  localStorage.setItem("ui-design-local-doc", JSON.stringify(d));
  localStorage.setItem("ui-design-panels", JSON.stringify({ l: true, i: true }));
  const apply = () => {
    const el = document.documentElement;
    if (el && el.dataset.theme !== "light") el.dataset.theme = "light";
  };
  apply();
  new MutationObserver(apply).observe(document, { subtree: true, childList: true, attributes: true });
}, doc);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

/** 悬停按钮，返回按钮与气泡的几何框 */
async function hoverTip(btn) {
  await btn.hover();
  await page.waitForTimeout(180);
  const tip = btn.locator("span[data-tip]");
  if (!(await tip.count())) throw new Error("按钮缺 data-tip 气泡节点");
  const tb = await tip.boundingBox();
  const bb = await btn.boundingBox();
  if (!tb) throw new Error(`悬停后气泡未显示：${await btn.getAttribute("aria-label")}`);
  return { tb, bb };
}

function assertInsideViewport(tb, label) {
  const vp = page.viewportSize();
  if (tb.x < 0 || tb.y < 0 || tb.x + tb.width > vp.width || tb.y + tb.height > vp.height) {
    throw new Error(`${label} 气泡溢出视口：${JSON.stringify(tb)} vs ${JSON.stringify(vp)}`);
  }
}

try {
  await page.goto(PAGE_URL);
  await page.getByText("首页", { exact: true }).first().waitFor({ timeout: 15000 });

  /* 1. 左栏头「收起面板」（贴窗口顶缘）：气泡应在按钮下方且完全在视口内 */
  const closes = page.locator('button[aria-label="收起面板"]');
  const left = closes.nth(0);
  const { tb: lt, bb: lb } = await hoverTip(left);
  if (lt.y < lb.y + lb.height) throw new Error(`左栏收起钮气泡未向下弹出：tip.y=${lt.y} btn.bottom=${lb.y + lb.height}`);
  assertInsideViewport(lt, "左栏收起面板");
  ok(`左栏「收起面板」气泡在按钮下方（间隙 ${(lt.y - (lb.y + lb.height)).toFixed(1)}px），视口内完整可见`);
  await page.mouse.move(640, 400);

  /* 2. 右栏「收起面板」（贴顶缘 + 贴右缘）：气泡应向下、向左展开（右缘对齐不溢出窗口） */
  const right = closes.nth(1);
  const { tb: rt, bb: rb } = await hoverTip(right);
  if (rt.y < rb.y + rb.height) throw new Error(`右栏收起钮气泡未向下弹出：tip.y=${rt.y} btn.bottom=${rb.y + rb.height}`);
  if (rt.x + rt.width > rb.x + rb.width + 1) throw new Error(`右栏收起钮气泡向右溢出按钮：${JSON.stringify(rt)} vs ${JSON.stringify(rb)}`);
  assertInsideViewport(rt, "右栏收起面板");
  ok(`右栏「收起面板」气泡向下且右缘收进按钮侧（right=${(rt.x + rt.width).toFixed(1)} ≤ 按钮右缘 ${(rb.x + rb.width).toFixed(1)}），不再被视口裁掉`);

  /* 3. 回归：底部工具栏（ZoomBar「缩小」贴底缘）气泡仍应向上弹出 */
  const zoom = page.locator('button[aria-label="缩小"]');
  const { tb: zt, bb: zb } = await hoverTip(zoom);
  if (zt.y + zt.height > zb.y + 1) throw new Error(`底部按钮气泡变成向下弹出：tip.bottom=${zt.y + zt.height} btn.top=${zb.y}`);
  assertInsideViewport(zt, "缩小");
  ok("底部缩放条「缩小」气泡仍向上弹出（默认 tipSide=top 未被破坏）");
  await page.screenshot({ path: "/tmp/verify-tooltip-docked.png" });

  /* 4. 窄态左上胶囊「图层面板」（贴顶缘）：气泡应向下 */
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(250);
  const pill = page.locator('button[aria-label="图层面板"]');
  const { tb: pt, bb: pb } = await hoverTip(pill);
  if (pt.y < pb.y + pb.height) throw new Error(`窄态胶囊气泡未向下弹出：tip.y=${pt.y} btn.bottom=${pb.y + pb.height}`);
  assertInsideViewport(pt, "窄态图层面板");
  ok("窄态胶囊「图层面板」气泡在按钮下方且视口内");
  await page.screenshot({ path: "/tmp/verify-tooltip-narrow.png" });

  console.log(`\n全部 ${step} 步通过`);
} finally {
  await browser.close();
}
