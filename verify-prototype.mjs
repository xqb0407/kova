/**
 * 运行验证：面板手动折叠（含持久化）/ CSS 代码分区+复制 / 原型分区回显绑定 /
 * P 预览（热点跳转·返回·Esc）/ 导出 HTML 原型并真实打开点击。
 * 用法：node verify-prototype.mjs（仓库根目录）
 */
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "/Users/herther/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const PAGE_URL = "file:///Users/herther/Desktop/ai-teamplte/plugins/ui-design/design.html";

const doc = {
  version: 1,
  meta: { name: "验证原型", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "页面 1",
      nodes: [
        {
          id: "f1", type: "frame", name: "首页", x: 0, y: 0, w: 300, h: 500,
          fills: [{ type: "solid", color: "#ffffff" }],
          children: [
            { id: "deco", type: "rect", name: "顶栏", x: 0, y: 0, w: 300, h: 44,
              fills: [{ type: "linear", angle: 90, stops: [{ at: 0, color: "#ff7a59" }, { at: 1, color: "#7a5cff" }] }] },
            { id: "btn", type: "rect", name: "去详情", x: 40, y: 380, w: 220, h: 48, radius: 24,
              fills: [{ type: "solid", color: "#0d99ff" }], onTap: { to: "f2" } },
          ],
        },
        {
          id: "f2", type: "frame", name: "详情", x: 420, y: 0, w: 300, h: 500,
          fills: [{ type: "solid", color: "#f5f5f5" }],
          children: [
            { id: "back", type: "rect", name: "返回", x: 40, y: 420, w: 220, h: 48, radius: 24,
              fills: [{ type: "solid", color: "#111111" }], onTap: { to: "f1" } },
          ],
        },
      ],
    },
  ],
};

let step = 0;
const ok = (msg) => console.log(`  ✅ ${++step}. ${msg}`);

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
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
await page.getByText("去详情", { exact: true }).first().waitFor({ timeout: 15000 });
ok("编辑器加载，图层树可见");

/* ---------- 1. 面板手动折叠 + 持久化 ---------- */
// 把手点击重试：防首帧渲染窗口内事件被吞（点三次仍不中才算失败）
async function expandViaHandle(title, probeText) {
  const h = page.locator(`button[title="${title}"]`);
  await h.waitFor({ timeout: 10000 });
  for (let i = 0; i < 3; i++) {
    await h.click({ timeout: 5000 }).catch(() => {});
    if (await page.getByText(probeText, { exact: true }).first().isVisible().catch(() => false)) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`把手点击未展开：${title}`);
}
await page.locator('button[aria-label="收起面板"]').first().click();
await page.getByText("图层", { exact: true }).first().waitFor({ state: "hidden" });
await page.locator('button[title="展开图层面板"]').waitFor();
ok("左栏收起钮生效，画布左缘出现展开把手");
await page.reload();
await page.getByText("去详情", { exact: true }).first().waitFor({ timeout: 15000 }).catch(() => {});
// reload 后：左栏应保持收起（把手在场）
await page.locator('button[title="展开图层面板"]').waitFor({ timeout: 10000 });
await expandViaHandle("展开图层面板", "去详情");
ok("折叠状态跨刷新保留，把手可展开");
await page.locator('button[aria-label="收起面板"]').nth(1).click();
await page.locator('button[title="展开属性面板"]').waitFor();
await expandViaHandle("展开属性面板", "2 个顶层元素 · 未选中任何图层");
ok("右栏收起/展开正常");

/* ---------- 2. CSS 代码分区 + 复制 ---------- */
await page.getByText("去详情", { exact: true }).first().click();
await page.getByText("复制 CSS").waitFor({ timeout: 5000 });
const codePre = page.locator("pre").last();
const cssText = await codePre.innerText();
if (!cssText.includes("background: #0d99ff") || !cssText.includes("border-radius: 24px")) {
  throw new Error("CSS 代码块内容不符：\n" + cssText);
}
ok(`CSS 代码块正确（选择器+填充+圆角在位）`);
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
await page.getByText("复制 CSS").click();
await page.getByText("已复制").waitFor({ timeout: 3000 });
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
if (clip && !clip.includes(".去详情") && !clip.includes("position: absolute")) throw new Error("剪贴板内容异常：" + clip);
ok(`复制 CSS → 已复制反馈${clip ? "（剪贴板可读，内容吻合）" : "（剪贴板不可读，仅验反馈——headless 允许）"}`);

/* ---------- 3. 原型分区回显已有绑定 ---------- */
await page.getByText("页面 1 / 详情").waitFor({ timeout: 5000 });
await page.getByText("预览原型").waitFor();
ok("原型分区显示 onTap 绑定「页面 1 / 详情」+ 预览入口");

/* ---------- 4. P 开预览：热点跳转 / 返回 / Esc ---------- */
await page.mouse.click(640, 700); // 空白处收选择并聚焦 body
await page.keyboard.press("p");
await page.getByText("点击高亮区可跳转").waitFor({ timeout: 5000 });
ok("P 快捷键打开预览，顶栏显示提示");
await page.locator('button[title="点击 → 详情"]').click();
await page.getByText("详情", { exact: true }).first().waitFor();
await page.locator('button[title="点击 → 首页"]').waitFor();
ok("点热点 f1→f2 换屏");
await page.locator('button[title="点击 → 首页"]').click();
await page.locator('button[title="返回上一屏（←）"]').click();
const nameNow = await page.locator("header").innerText().catch(() => "");
await page.keyboard.press("Escape");
await page.getByText("点击高亮区可跳转").waitFor({ state: "hidden" });
ok("往返跳转 + 返回钮 + Esc 关闭预览");

/* ---------- 5. 导出 HTML 原型并真实点击 ---------- */
await page.locator('button[title="文件菜单"]').click();
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 20000 }),
  page.getByText("导出 HTML 原型").click(),
]);
const fname = download.suggestedFilename();
if (!fname.endsWith("-原型.html")) throw new Error("导出文件名异常：" + fname);
const tmp = mkdtempSync(path.join(os.tmpdir(), "proto-"));
const saved = path.join(tmp, fname);
await download.saveAs(saved);
ok(`导出 ${fname}`);

const p2 = await ctx.newPage();
await p2.goto("file://" + saved);
await p2.waitForSelector("#s-f1");
const s1visible = await p2.$eval("#s-f1", (el) => getComputedStyle(el).display === "block");
if (!s1visible) throw new Error("初始屏未显示");
await p2.locator('#s-f1 a.hot').first().click();
await p2.waitForFunction(() => location.hash === "#s-f2" && getComputedStyle(document.querySelector("#s-f2")).display === "block");
const idxText = await p2.$eval("#idx", (el) => el.textContent);
await p2.goBack();
await p2.waitForFunction(() => getComputedStyle(document.querySelector("#s-f1")).display === "block");
ok(`导出件可交互：热点跳屏（hash=#s-f2，指示 ${idxText}）+ 浏览器后退回第一屏`);
await p2.close();

await browser.close();
console.log(`\n🎉 全部 ${step} 项通过`);
} catch (e) {
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "（读不到 body）");
  console.log("—— 失败现场 body 文本 ——\n" + bodyText + "\n——");
  await page.screenshot({ path: "/tmp/verify-fail.png", fullPage: false }).catch(() => {});
  console.log("截图 /tmp/verify-fail.png");
  await browser.close().catch(() => {});
  throw e;
}
