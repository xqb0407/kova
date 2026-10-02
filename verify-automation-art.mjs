/**
 * 临时验证：自动化页插画（模板卡新版式 / 两个空态）亮暗两主题截图。
 * 用法：node verify-automation-art.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const EXE =
  "/Users/herther/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const URL = "http://localhost:3000/dev-preview/automation-art";
const OUT = "/Users/herther/Desktop/ai-teamplte/tmp-shots/automation-art";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({
  viewport: { width: 1500, height: 1100 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 200));
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);

const shoot = async (name, full = true) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("  ->", `${name}.png`);
};

await shoot("01-light");

// 放大看线稿本身：截模板区那块
const gallery = page
  .locator("section")
  .filter({ hasText: "从模板开始" })
  .first();
await gallery.screenshot({ path: `${OUT}/02-light-gallery.png` });
console.log("  ->", "02-light-gallery.png");

// 空态单截：这里最容易出"半透明叠半透明"的穿透瑕疵，整页缩略图看不出来
const emptyA = page
  .locator("div")
  .filter({ hasText: "还没有自动化任务" })
  .last();
await emptyA.screenshot({ path: `${OUT}/05-light-empty-a.png` });
console.log("  ->", "05-light-empty-a.png");

await page.getByRole("button", { name: "切暗色" }).click();
await page.waitForTimeout(600);
await shoot("03-dark");
const galleryDark = page
  .locator("section")
  .filter({ hasText: "从模板开始" })
  .first();
await galleryDark.screenshot({ path: `${OUT}/04-dark-gallery.png` });
console.log("  ->", "04-dark-gallery.png");

await browser.close();
console.log("done");
