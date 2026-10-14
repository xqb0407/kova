/**
 * verify-export-html.ts —— 「预览所见 = 导出所得」的端到端验收。
 *
 * 用真实文档跑一遍导出管线（ui/src/html.ts 的 renderPrototypeHtml，与 MCP export_doc /
 * 面板「导出 HTML 原型」同一个入口），把产物写到临时文件，再用真浏览器打开它，
 * 像用户那样点：跳转 → 返回 → 长按开浮层 → 关闭。跑通就说明内联的运行时确实是
 * 面板预览那一份，而不是"两份保持同步的代码"。
 *
 * 跑法：bun run scripts/verify-export-html.ts
 */
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseDesignDoc } from "../ui/src/doc";
import { renderPrototypeHtml } from "../ui/src/html";
import { makeApproxMeasure } from "../mcp/render";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shell = path.join(
  os.homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

const raw = {
  version: 1,
  meta: { name: "交付验收", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "P",
      nodes: [
        {
          id: "home",
          type: "frame",
          name: "首页",
          x: 0,
          y: 0,
          w: 390,
          h: 844,
          fills: [{ type: "solid", color: "#ffffff" }],
          scroll: "v",
          children: [
            { id: "h1", type: "text", name: "标题", x: 24, y: 60, w: 200, h: 32, text: "首页", align: "left", size: 24, weight: 700, color: "#111111" },
            {
              id: "go",
              type: "rect",
              name: "去详情",
              x: 24,
              y: 140,
              w: 200,
              h: 56,
              radius: 28,
              fills: [{ type: "solid", color: "#0d99ff" }],
              interactions: [
                { trigger: "tap", action: "navigate", to: "detail" },
                { trigger: "longPress", action: "overlay", to: "sheet", position: "bottom" },
              ],
            },
            { id: "foot", type: "rect", name: "页脚块", x: 24, y: 1300, w: 300, h: 80, radius: 12, fills: [{ type: "solid", color: "#e6e6e6" }] },
          ],
        },
        { id: "detail", type: "frame", name: "详情页", x: 520, y: 0, w: 390, h: 844, fills: [{ type: "solid", color: "#ffffff" }], children: [
          { id: "d1", type: "text", name: "标题", x: 24, y: 60, w: 200, h: 32, text: "详情页", align: "left", size: 24, weight: 700, color: "#111111" },
          { id: "dback", type: "rect", name: "返回", x: 24, y: 140, w: 120, h: 48, radius: 24, fills: [{ type: "solid", color: "#e6e6e6" }],
            interactions: [{ trigger: "tap", action: "back" }] },
        ]},
        { id: "sheet", type: "frame", name: "操作面板", x: 1040, y: 0, w: 390, h: 300, radius: 20, fills: [{ type: "solid", color: "#ffffff" }], children: [
          { id: "s1", type: "text", name: "标题", x: 24, y: 32, w: 200, h: 28, text: "选择操作", align: "left", size: 18, weight: 600, color: "#111111" },
          { id: "sclose", type: "rect", name: "关闭", x: 24, y: 100, w: 342, h: 48, radius: 24, fills: [{ type: "solid", color: "#0d99ff" }],
            interactions: [{ trigger: "tap", action: "closeOverlay" }] },
        ]},
      ],
    },
  ],
};

let fails = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  [${JSON.stringify(detail)}]` : ""}`);
  if (!ok) fails++;
};

const doc = parseDesignDoc(JSON.stringify(raw)).doc;
const html = renderPrototypeHtml(doc, { measure: makeApproxMeasure(), title: "交付验收" });
if (!html) {
  console.log("FAIL  导出产出了 null");
  process.exit(1);
}
const ws = mkdtempSync(path.join(tmpdir(), "proto-export-"));
const file = path.join(ws, "index.html");
writeFileSync(file, html);

console.log(`导出产物：${file}（${(html.length / 1024).toFixed(0)} KB，单文件自包含）\n`);
check("产物不依赖外部资源（无 http(s) 外链）", !/src="https?:|href="https?:/.test(html));
check("内联了运行时样式与热点层", html.includes(".uir-hot") && html.includes("uir-hot-layer"));

const browser = await chromium.launch({ executablePath: shell });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(pathToFileURL(file).href);
await page.waitForTimeout(600);

check("打开即渲染（运行时自启动）", (await page.locator(".uir").count()) === 1);
check("起始屏 = 首页", (await page.locator(".uir-name").innerText()) === "首页");
const png = path.join(dir, "out-export-1-home.png");
await page.screenshot({ path: png });
console.log(`  · 截图 ${path.relative(process.cwd(), png)}`);

// 单击热点 → 跳详情
await page.locator(".uir-hot").first().click();
await page.waitForTimeout(600);
check("导出件里单击跳转生效", (await page.locator(".uir-name").innerText()) === "详情页");

// 返回（back 动作）
await page.locator(".uir-hot").first().click();
await page.waitForTimeout(600);
check("导出件里 back 动作生效", (await page.locator(".uir-name").innerText()) === "首页");

// 长按 → 浮层
const hot = page.locator('[data-hot="go"]');
const b = (await hot.boundingBox())!;
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
await page.waitForTimeout(700);
check("导出件里长按开浮层", (await page.locator(".uir-ov").count()) === 1);
const png2 = path.join(dir, "out-export-2-overlay.png");
await page.screenshot({ path: png2 });
console.log(`  · 截图 ${path.relative(process.cwd(), png2)}`);

await page.locator(".uir-backdrop").click({ force: true });
await page.waitForTimeout(600);
check("导出件里点遮罩关闭浮层", (await page.locator(".uir-ov").count()) === 0);

// 滚动
const before = await page.evaluate(() => document.querySelector("[data-scroll-body]")?.getAttribute("transform") ?? null);
await page.mouse.move(700, 500);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(400);
const after = await page.evaluate(() => document.querySelector("[data-scroll-body]")?.getAttribute("transform") ?? null);
check("导出件里滚动区域可滚", !!after && before !== after, { before, after });

if (errors.length) {
  console.log("\n[pageerror]");
  for (const e of errors) console.log("  ", e);
  fails++;
}
console.log(`\n${fails === 0 ? "全部通过" : `${fails} 项失败`}`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
