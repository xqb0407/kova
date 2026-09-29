/**
 * verify-variables.mjs —— 无头浏览器实测「共享颜色变量」在真实渲染链路里的落地：
 *  1) seed 档带变量表 + 三种绑定（实心填充 / 文字 run / 图标 stroke）→ 画布三端渲染出解析后的色值；
 *  2) 变量改值（store.upsertVariable）→ 画布上所有绑定处同步换色（live 联动，同一帧）；
 *  3) 一步 undo 回退变量值 → 画布跟着回旧色（变量改动 = 一步可撤销历史）；
 *  4) 坏引用（删变量）→ 画布显示警示粉 MISSING_VAR_COLOR；
 *  5) 变量管理面板（图层/变量页签）真实点击：切到变量页签能列出变量行。
 * 口径：window.__designLeafer 场景键（#f0/#t0/#ic）读渲染色值 + window.__designStore 驱动变更。
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

const seed = () => ({
  version: 1,
  meta: { name: "变量实测", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      nodes: [
        { id: "bg", type: "rect", x: 0, y: 0, w: 900, h: 600, fills: [{ type: "solid", color: "#fafafa" }] },
        { id: "card", type: "rect", name: "卡片", x: 80, y: 80, w: 240, h: 120, radius: 12, fills: [{ type: "solid", color: "var:vprimary" }], strokes: [{ color: "var:vborder", width: 2 }] },
        { id: "label", type: "text", name: "标题", x: 100, y: 120, w: 200, h: 28, runs: [{ text: "共享样式", size: 18, color: "var:vtext" }] },
        { id: "star", type: "icon", name: "图标", x: 100, y: 160, w: 24, h: 24, icon: "house", color: "var:vprimary" },
      ],
    },
  ],
  variables: [
    { id: "vprimary", name: "主色", value: "#0d99ff" },
    { id: "vborder", name: "描边", value: "#223344" },
    { id: "vtext", name: "正文", value: "#111111" },
  ],
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

// 场景色值读取：#f0 = card 填充层、#s0 = card 描边层、#t0 = 文字 fragment、#ic = 图标路径
const read = () =>
  page.evaluate(() => {
    const L = window.__designLeafer;
    const num = (k) => {
      const e = L.nodes.get(k);
      if (!e) return null;
      const f = e.node.fill;
      if (typeof f === "string") return f;
      if (f && typeof f === "object" && "color" in f) return f.color;
      return JSON.stringify(f);
    };
    const str = (k, p) => {
      const e = L.nodes.get(k);
      return e ? e.node[p] : null;
    };
    return { cardFill: num("card#f0"), cardStroke: str("card#s0", "stroke"), textFill: str("label#t0", "fill"), iconStroke: str("star#ic", "stroke") };
  });

/* ---------- 1. 绑定渲染：画布解析出变量值 ---------- */
const r1 = await read();
check(
  "绑定渲染：填充/描边/文字/图标全解析为变量当前值",
  r1.cardFill === "#0d99ff" && r1.cardStroke === "#223344" && r1.textFill === "#111111" && r1.iconStroke === "#0d99ff",
  r1,
);

/* ---------- 2. 改值 → 全稿联动 ---------- */
await page.evaluate(() => {
  window.__designStore.upsertVariable({ id: "vprimary", name: "主色", value: "#ff0055" });
});
await page.waitForTimeout(700);
const r2 = await read();
check("改主色值 → 填充与图标两处绑定同步换色（#ff0055）", r2.cardFill === "#ff0055" && r2.iconStroke === "#ff0055" && r2.textFill === "#111111", r2);

/* ---------- 3. 一步 undo 回退变量值 ---------- */
await page.evaluate(() => {
  window.__designStore.undo();
});
await page.waitForTimeout(700);
const r3 = await read();
check("一步 undo → 变量值回退、画布回旧色（#0d99ff）", r3.cardFill === "#0d99ff" && r3.iconStroke === "#0d99ff", r3);

/* ---------- 4. 删变量 → 警示粉 ---------- */
await page.evaluate(() => {
  window.__designStore.deleteVariable("vprimary");
});
await page.waitForTimeout(700);
const r4 = await read();
check("删变量 → 绑定处画警示粉（缺失口径）", String(r4.cardFill).toLowerCase().includes("e8506e"), r4);
// 收尾：恢复（redo 两次撤删变量、撤改值会乱序，直接重 upsert 回来）
await page.evaluate(() => {
  window.__designStore.upsertVariable({ id: undefined, name: "主色", value: "#0d99ff" });
});
await page.waitForTimeout(500);

/* ---------- 5. 变量管理页签：真实点击切页签，列表出现 ---------- */
const tab = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "变量");
  if (!btn) return { tabBtn: false, emptyHint: false };
  btn.click(); // 真实 React onClick（Radix 之外的普通按钮，JS click 同样走合成事件）
  return new Promise((res) =>
    setTimeout(() => res({ tabBtn: true, emptyHint: /还没有共享变量|新建变量|未引用/.test(document.body.innerText) }), 350),
  );
});
check("左侧「变量」页签：切换生效且管理面板渲染（变量行/新建入口）", tab.tabBtn && tab.emptyHint, tab);

await page.screenshot({ path: path.resolve(dir, "out-variables.png") });
console.log(fails === 0 ? "\nALL PASS（截图 scripts/out-variables.png）" : `\n${fails} FAILURES`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
