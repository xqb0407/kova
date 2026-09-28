/**
 * 运行验证：Phase C 快捷键 + 右键上下文菜单。
 * 覆盖：⌘A 全选 / 画布空白右键菜单 / 节点·图层行右键菜单 / Esc 关菜单不清选择 /
 *   创建副本 / ⌘⇧H 显隐 / ⌘⇧L 锁定 / ⌘]·⌘[ 移层 / ⌘⇧C 复制 CSS / ⇧⌘1 缩放到选区 / 置入图片。
 * 用法：node verify-shortcuts.mjs（仓库根目录；跑的是 design.html 生产单文件）
 */
import { chromium } from "playwright";

const EXE = "/Users/herther/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const PAGE_URL = "file:///Users/herther/Desktop/ai-teamplte/plugins/ui-design/design.html";

/** 两画板 + 子节点：够覆盖多层级命中与菜单切换 */
const doc = {
  version: 1,
  meta: { name: "验证快捷键", kind: "uidesign" },
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
            { id: "deco", type: "rect", name: "顶栏", x: 0, y: 0, w: 300, h: 44, fills: [{ type: "solid", color: "#ff7a59" }] },
          ],
        },
        {
          id: "f2", type: "frame", name: "详情", x: 420, y: 0, w: 300, h: 500,
          fills: [{ type: "solid", color: "#f5f5f5" }],
        },
      ],
    },
  ],
};

/* 1x1 透明 PNG（置入图片用，资产在独立模式被丢弃不影响节点落库） */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let step = 0;
const ok = (msg) => console.log(`  ✅ ${++step}. ${msg}`);

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
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

const readDoc = () => page.evaluate(() => JSON.parse(localStorage.getItem("ui-design-local-doc")));
const topLevel = async () => (await readDoc()).pages[0].nodes;
const waitForSave = () => page.waitForTimeout(1400); // 800ms 防抖保存 + 余量
const menuItem = (label) => page.locator("[data-ctx-menu]").getByRole("button", { name: new RegExp(`^${label}( .+)?$`) });
const expectMenuGone = async () => {
  await page.waitForTimeout(150);
  if (await menuItem("创建副本").isVisible().catch(() => false)) throw new Error("菜单未关闭");
};

try {
  await page.goto(PAGE_URL);
  await page.getByText("首页", { exact: true }).first().waitFor({ timeout: 15000 });
  ok("编辑器加载，图层树可见");

  /* ---------- 1. ⌘A 全选 ---------- */
  await page.keyboard.press("Meta+a");
  await page.getByText("已选 2 项", { exact: true }).waitFor({ timeout: 5000 });
  ok("⌘A 全选：底部「已选 2 项」（顶层两画板）");

  /* ---------- 2. 图层行右键：多选菜单 + Esc 不清选择 ---------- */
  await page.getByText("详情", { exact: true }).first().click({ button: "right" });
  await menuItem("创建副本").waitFor({ timeout: 5000 });
  if (!(await menuItem("成组").isVisible().catch(() => false))) throw new Error("多选右键菜单缺「成组」");
  ok("图层行右键：多选含成组/创建副本");
  await page.keyboard.press("Escape");
  await expectMenuGone();
  await page.getByText("已选 2 项", { exact: true }).waitFor({ timeout: 3000 });
  ok("Esc 关菜单且不吞选择（仍「已选 2 项」）");

  /* ---------- 3. 右键未选中行 → 选择切过去 + 单选菜单 ---------- */
  await page.getByText("首页", { exact: true }).first().click(); // 单选 f1
  await page.getByText("详情", { exact: true }).first().click({ button: "right" }); // 右键切选 f2
  await menuItem("复制 CSS").waitFor({ timeout: 5000 });
  if (await menuItem("成组").isVisible().catch(() => false)) throw new Error("单选右键菜单不应有「成组」");
  ok("右键未选中行：选择切换后按单选给菜单（复制 CSS、无成组）");

  /* ---------- 4. 菜单点「创建副本」→ 顶层 3 节点 ---------- */
  await menuItem("创建副本").click();
  await waitForSave();
  if ((await topLevel()).length !== 3) throw new Error(`创建副本后顶层应 3 节点，实际 ${(await topLevel()).length}`);
  ok("菜单「创建副本」生效：顶层 3 节点");

  /* ---------- 5. ⌘⇧H 显隐（确定性切换） ---------- */
  await page.getByText("首页", { exact: true }).first().click();
  await page.keyboard.press("Meta+Shift+h");
  await waitForSave();
  if ((await topLevel()).find((n) => n.id === "f1").visible !== false) throw new Error("⌘⇧H 未隐藏");
  await page.keyboard.press("Meta+Shift+h");
  await waitForSave();
  if ((await topLevel()).find((n) => n.id === "f1").visible === false) throw new Error("⌘⇧H 未恢复显示");
  ok("⌘⇧H 隐藏 → 再按恢复显示");

  /* ---------- 6. ⌘⇧L 锁定 ---------- */
  await page.keyboard.press("Meta+Shift+l");
  await waitForSave();
  if ((await topLevel()).find((n) => n.id === "f1").locked !== true) throw new Error("⌘⇧L 未锁定");
  await page.keyboard.press("Meta+Shift+l");
  await waitForSave();
  if ((await topLevel()).find((n) => n.id === "f1").locked === true) throw new Error("⌘⇧L 未解锁");
  ok("⌘⇧L 锁定 → 再按解锁");

  /* ---------- 7. ⌘] / ⌘[ 移层 ---------- */
  const idxOf = async () => (await topLevel()).findIndex((n) => n.id === "f1");
  if (await idxOf() !== 0) throw new Error("前置条件：f1 应在索引 0");
  await page.keyboard.press("Meta+]");
  await waitForSave();
  if (await idxOf() !== 1) throw new Error(`⌘] 上移后索引应 1，实际 ${await idxOf()}`);
  await page.keyboard.press("Meta+[");
  await waitForSave();
  if (await idxOf() !== 0) throw new Error(`⌘[ 下移后索引应 0，实际 ${await idxOf()}`);
  await page.keyboard.press("Meta+Shift+BracketRight");
  await waitForSave();
  if (await idxOf() !== 2) throw new Error(`⌘⇧] 置顶后索引应 2，实际 ${await idxOf()}`);
  await page.keyboard.press("Meta+Shift+BracketLeft");
  await waitForSave();
  if (await idxOf() !== 0) throw new Error(`⌘⇧[ 置底后索引应 0，实际 ${await idxOf()}`);
  ok("⌘]/⌘[ 上移下移 + ⌘⇧]/⌘⇧[ 置顶置底");

  /* ---------- 8. ⌘⇧C 复制 CSS ---------- */
  await page.getByText("首页", { exact: true }).first().click();
  await page.keyboard.press("Meta+Shift+c");
  await page.waitForTimeout(400);
  const css = await page.evaluate(() => navigator.clipboard.readText());
  if (!css.includes("background:") || !css.includes("width: 300px")) throw new Error(`剪贴板 CSS 不符：${css.slice(0, 80)}`);
  ok("⌘⇧C 复制图层 CSS 到剪贴板");

  /* ---------- 9. ⇧⌘1 缩放到选区（缩放百分比变化） ---------- */
  const zoomText = () => page.locator('button[title="缩放选项"]').innerText();
  const z0 = await zoomText();
  await page.getByText("顶栏", { exact: true }).first().click(); // 选个小节点
  await page.keyboard.press("Meta+Shift+1");
  await page.waitForTimeout(400);
  const z1 = await zoomText();
  if (z0 === z1) throw new Error(`⇧⌘1 缩放未变化（${z0}）`);
  ok(`⇧⌘1 缩放到选区：${z0.trim()} → ${z1.trim()}`);

  /* ---------- 10. 画布空白右键：菜单 + 置入图片 ---------- */
  const cv = page.locator("canvas").first();
  const box = await cv.boundingBox();
  await page.mouse.click(box.x + 24, box.y + 24, { button: "right" }); // fitView 留 80px 边 → 角落必空白
  await menuItem("全选").waitFor({ timeout: 5000 });
  if (!(await menuItem("粘贴").isVisible().catch(() => false))) throw new Error("画布右键菜单缺「粘贴」");
  ok("画布空白右键：全选/粘贴/置入图片… 菜单");
  const chooserP = page.waitForEvent("filechooser", { timeout: 5000 });
  await menuItem("置入图片…").click();
  const chooser = await chooserP;
  await chooser.setFiles({ name: "贴图.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.getByText("贴图.png", { exact: true }).first().waitFor({ timeout: 8000 });
  await waitForSave();
  if ((await topLevel()).length !== 4) throw new Error(`置入图片后顶层应 4，实际 ${(await topLevel()).length}`);
  ok("置入图片…：文件选择 → image 节点落库（顶层 4）");

  /* ---------- 11. 节点上右键（命中已选保持多选、命中新节点切单选） ---------- */
  await page.getByText("首页", { exact: true }).first().click();
  await page.keyboard.press("Meta+a"); // 全选 4
  await page.getByText("详情", { exact: true }).first().click({ button: "right" }); // 在树里右键，仍在选中集
  await menuItem("成组").waitFor({ timeout: 5000 });
  ok("全选状态下右键选中行：菜单仍按多选给（含成组）");
  await page.keyboard.press("Escape");
  await expectMenuGone();

  console.log(`\n全部 ${step} 步通过 🎉`);
} catch (err) {
  const dump = await page.locator("body").innerText().catch(() => "(读不到)");
  console.error("❌ 验证失败：", err.message);
  console.error("---- 页面文本（尾 800 字） ----\n" + dump.slice(-800));
  await page.screenshot({ path: "/tmp/verify-shortcuts-fail.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
