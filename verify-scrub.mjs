/**
 * 运行验证：NumField 标签横向拖拽调值（Figma 式 scrub）+ 一步撤销 + 手动输入保留。
 * 用法：node verify-scrub.mjs（仓库根目录）
 */
import { chromium } from "playwright";

const EXE = "/Users/herther/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const PAGE_URL = "file:///Users/herther/Desktop/ai-teamplte/plugins/ui-design/design.html";

const doc = {
  version: 1,
  meta: { name: "scrub 验证", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "页面 1",
      nodes: [{ id: "f1", type: "frame", name: "首页", x: 100, y: 50, w: 300, h: 500, fills: [{ type: "solid", color: "#ff7a59" }] }],
    },
  ],
};

let step = 0;
const ok = (msg) => console.log(`  ✅ ${++step}. ${msg}`);

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

try {
  await page.goto(PAGE_URL);
  await page.getByText("首页", { exact: true }).first().waitFor({ timeout: 15000 });
  await page.getByText("首页", { exact: true }).first().click(); // 选中 f1 → 检视器出现 X/Y/W/H
  await page.waitForTimeout(300);

  const insp = page.locator("div.w-\\[272px\\].overflow-y-auto");
  const xField = insp.locator("label").filter({ hasText: /^X/ }).first();
  const xInput = xField.locator("input");
  const xLabel = xField.locator("span").first();

  const val = async () => (await xInput.inputValue()).trim();
  if ((await val()) !== "100") throw new Error(`初始 X 应为 100，实际 ${await val()}`);

  /* 1. 悬停 label：光标变左右箭头 */
  const cursor = await xLabel.evaluate((el) => getComputedStyle(el).cursor);
  if (cursor !== "ew-resize") throw new Error(`label 光标应为 ew-resize，实际 ${cursor}`);
  ok("数字框 label 悬停光标 = ew-resize（左右箭头）");

  /* 2. 按住拖 +50px → X = 150（1px = 1 步长） */
  const lb = await xLabel.boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(lb.x + lb.width / 2 + i * 10, lb.y + lb.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(150);
  if ((await val()) !== "150") throw new Error(`拖 +50px 后 X 应为 150，实际 ${await val()}`);
  ok("按住 label 右拖 50px → X 100→150");

  /* 3. 一次 ⌘Z 回到 100：整段拖拽合并成一步撤销 */
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(150);
  if ((await val()) !== "100") throw new Error(`拖拽应只占一步撤销（⌘Z 后应回 100），实际 ${await val()}`);
  ok("整段拖拽 = 一步撤销（⌘Z 直接回到 100）");

  /* 4. Shift 加速 ×10：拖 +10px → +100 */
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(lb.x + lb.width / 2 + i * 2, lb.y + lb.height / 2, { steps: 1 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(150);
  if ((await val()) !== "200") throw new Error(`Shift 拖 +10px 应 ×10 → 200，实际 ${await val()}`);
  ok("Shift 拖拽 ×10 加速（+10px → X=200）");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(150);

  /* 5. 手动输入保留：直接键入 123 + 回车 */
  await xInput.click();
  await xInput.fill("123");
  await xInput.press("Enter");
  await page.waitForTimeout(150);
  if ((await val()) !== "123") throw new Error(`手动输入 123 应生效，实际 ${await val()}`);
  ok("手动输入 + 回车提交仍可用（X=123）");

  /* 6. 边界钳制：拖到远小于 min（W 有 min=1，X 无 min 可负）——用 W 验证 min */
  const wField = insp.locator("label").filter({ hasText: /^W/ }).first();
  const wInput = wField.locator("input");
  const wLabel = wField.locator("span").first();
  const wb = await wLabel.boundingBox();
  await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
  await page.mouse.down();
  await page.mouse.move(wb.x + wb.width / 2 - 900, wb.y + wb.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const wv = parseFloat(await wInput.inputValue());
  if (!(wv >= 1)) throw new Error(`W 拖出负值未被钳制：${wv}`);
  ok(`左拖越界被 min 钳制（W=${wv} ≥ 1）`);

  console.log(`\n全部 ${step} 步通过`);
} catch (err) {
  console.error("❌ 验证失败：", err.message);
  await page.screenshot({ path: "/tmp/verify-scrub-fail.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
