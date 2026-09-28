/**
 * 运行验证：全局滚动条样式 + 右侧属性面板离滚动条留白（pr-2=8px）。
 * 用法：node verify-scrollbar.mjs（仓库根目录）
 */
import { chromium } from "playwright";

const EXE = "/Users/herther/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const PAGE_URL = "file:///Users/herther/Desktop/ai-teamplte/plugins/ui-design/design.html";

const fills = Array.from({ length: 6 }, (_, i) => ({ type: "solid", color: ["#ff7a59", "#7a5cff", "#0d99ff", "#22c55e", "#f59e0b", "#ec4899"][i] }));
const strokes = Array.from({ length: 4 }, (_, i) => ({ color: "#111111", width: 1 + i, align: "inside" }));
const effects = Array.from({ length: 3 }, () => ({ type: "drop-shadow", color: "rgba(0,0,0,0.25)", x: 0, y: 4, blur: 12 }));

const doc = {
  version: 1,
  meta: { name: "滚动条验证", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "页面 1",
      nodes: [
        { id: "f1", type: "frame", name: "首页", x: 0, y: 0, w: 300, h: 500, fills, strokes, effects },
        { id: "f2", type: "text", name: "标题", x: 420, y: 40, w: 200, h: 40, runs: [{ text: "滚动条验证", size: 24 }] },
      ],
    },
  ],
};

let step = 0;
const ok = (msg) => console.log(`  ✅ ${++step}. ${msg}`);

const browser = await chromium.launch({
  executablePath: EXE,
  // 测试环境关掉 macOS overlay 滚动条，让自定义 ::-webkit-scrollbar 以经典占位模式渲染（仅影响验证壳）
  args: ["--disable-features=OverlayScrollbar,OverlayScrollbars,FluentOverlayScrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await ctx.addInitScript((d) => {
  window.matchMedia = window.matchMedia || ((q) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  localStorage.setItem("ui-design-local-doc", JSON.stringify(d));
  const apply = () => {
    const el = document.documentElement;
    if (el && el.dataset.theme !== "light") el.dataset.theme = "light";
  };
  apply();
  new MutationObserver(apply).observe(document, { subtree: true, childList: true, attributes: true });
}, doc);
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));

try {
  await page.goto(PAGE_URL);
  await page.getByText("首页", { exact: true }).first().waitFor({ timeout: 15000 });
  await page.getByText("首页", { exact: true }).first().click(); // 单选 f1 → 检视面板满配
  await page.waitForTimeout(400);

  /* 1. 检视面板确实在滚动（内容高于容器） */
  const insp = page.locator("div.w-\\[272px\\].overflow-y-auto");
  const overflow = await insp.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, pr: getComputedStyle(el).paddingRight }));
  if (overflow.sh <= overflow.ch) throw new Error(`检视面板未溢出：${JSON.stringify(overflow)}`);
  ok(`检视面板出滚动条（内容 ${overflow.sh}px / 视口 ${overflow.ch}px）`);

  /* 2. 右侧留白 = 8px（pr-2）且无横向溢出（固定宽度行不被滚动条/留白挤剪——本轮回归点） */
  if (overflow.pr !== "8px") throw new Error(`padding-right 应为 8px，实际 ${overflow.pr}`);
  const hOver = await insp.evaluate((el) => {
    if (el.scrollWidth > el.clientWidth) return `容器自身 ${el.scrollWidth - el.clientWidth}px`;
    for (const row of el.querySelectorAll("div.flex")) {
      const over = row.scrollWidth - row.clientWidth;
      if (over > 1 && row.clientWidth > 0) return `行溢出 ${over}px：${row.textContent?.slice(0, 18)}`;
    }
    return null;
  });
  if (hOver) throw new Error(`横向溢出（按钮会被剪）：${hOver}`);
  ok("属性内容离滚动条右缘留白 8px（pr-2），且所有行无横向溢出");

  /* 3. 滚动条样式生效：伪元素 computed style（与是否 overlay 渲染无关，是样式真值） */
  const cs = await insp.evaluate((el) => ({
    bar: el.offsetWidth - el.clientWidth,
    w: getComputedStyle(el, "::-webkit-scrollbar").width,
    trackBg: getComputedStyle(el, "::-webkit-scrollbar-track").backgroundColor,
    thumbR: getComputedStyle(el, "::-webkit-scrollbar-thumb").borderRadius,
    thumbBorder: getComputedStyle(el, "::-webkit-scrollbar-thumb").borderTopWidth,
    thumbClip: getComputedStyle(el, "::-webkit-scrollbar-thumb").backgroundClip,
  }));
  if (cs.w !== "9px") throw new Error(`滚动条宽应 9px，实际 ${cs.w}`);
  if (cs.trackBg !== "rgba(0, 0, 0, 0)") throw new Error(`轨道应透明，实际 ${cs.trackBg}`);
  if (cs.thumbR !== "999px" || cs.thumbBorder !== "2px" || cs.thumbClip !== "padding-box") throw new Error(`滑块非胶囊内缩样式：${JSON.stringify(cs)}`);
  ok(`滚动条样式生效：9px 宽 / 透明轨道 / 2px 内缩胶囊滑块（经典模式占宽 ${cs.bar}px）`);

  /* 4. 滚到底再截右侧面板图，供人工目测 */
  await insp.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(350);
  const box = await insp.boundingBox();
  await page.screenshot({ path: "/tmp/verify-scrollbar.png", clip: { x: box.x - 8, y: 0, width: box.width + 16, height: 800 } });
  ok("截图 /tmp/verify-scrollbar.png（右侧面板滚到底）");

  console.log(`\n全部 ${step} 步通过 🎉`);
} catch (err) {
  console.error("❌ 验证失败：", err.message);
  await page.screenshot({ path: "/tmp/verify-scrollbar-fail.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
