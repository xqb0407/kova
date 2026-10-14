/**
 * 拖拽区 + 滚动回归验证（CDP）：
 *   node apps/electron/scripts/e2e-drag.mjs [cdpPort]
 * 覆盖：
 *  1. 拖拽判定语义（false 截停 / deep 子树非交互可拖、交互元素与 false 子树不拖 /
 *     true 仅自身、正文不拖）——跑 preload 同款判定逻辑对真实 DOM 取样；
 *  2. 滚轮：拖拽区（顶栏）上滚动不再被吞（真实输入管线 mouse.wheel）；
 *  3. 拖拽管线：合成 mousedown(screenX/Y) → mousemove → 窗口真移动 → 归位；
 *  4. 非拖拽区（正文）拖动不移动窗口。
 */
import { chromium } from "playwright-core";

const port = process.argv[2] ?? "19452";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
if (!page) {
  console.error("FAIL: no kova:// page");
  process.exit(1);
}

const out = {};

out.regions = await page.evaluate(() => {
  const INTERACTIVE = ["button", "a", "input", "select", "textarea", "summary", "[role=button]", '[contenteditable="true"]'].join(",");
  const isInteractive = (el) => {
    if (!el) return false;
    if (el.closest(INTERACTIVE)) return true;
    if (el.isContentEditable) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && ti !== "-1";
  };
  const dragRegionFor = (target) => {
    let el = target;
    while (el && el !== document.body && el !== document.documentElement) {
      const v = el.getAttribute("data-drag-region");
      if (v === "false") return null;
      if (v === "deep") return isInteractive(target) ? null : el;
      if (v === "true") return el === target ? el : null;
      el = el.parentElement;
    }
    return null;
  };
  const probe = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return "NO_ELEM";
    return dragRegionFor(el) ? "DRAG" : "NO_DRAG";
  };
  const header = document.querySelector("header");
  let titleSpan = "NO_ELEM";
  let headerBtn = "NO_ELEM";
  if (header) {
    const span = header.querySelector('[data-drag-region="false"]');
    if (span) titleSpan = dragRegionFor(span) ? "DRAG" : "NO_DRAG";
    const btn = header.querySelector("button");
    if (btn) headerBtn = dragRegionFor(btn) ? "DRAG" : "NO_DRAG";
  }
  return {
    headerPlain: header ? (dragRegionFor(header) ? "DRAG" : "NO_DRAG") : "NO_ELEM",
    headerTitleSpanFALSE: titleSpan,
    headerButton: headerBtn,
    mainTrueRegionSelf: probe('main[data-drag-region="true"]'),
    mainTrueChild: probe('main[data-drag-region="true"] .cm-content'),
    chatBodyDeep: header ? (dragRegionFor(header.parentElement) ? "DRAG" : "NO_DRAG") : "n/a",
  };
});

// 设置页（长内容）上的滚动：程序化 + 真实滚轮
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "设置");
  btn?.click();
});
await page.waitForTimeout(1200);

out.scrollProgrammatic = await page.evaluate(() => {
  const pick = () =>
    Array.from(document.querySelectorAll("div"))
      .filter((d) => {
        const s = getComputedStyle(d);
        return (s.overflowY === "auto" || s.overflowY === "scroll") && d.scrollHeight > d.clientHeight + 40;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  const el = pick();
  if (!el) return { found: false };
  el.scrollTop = 240;
  return { found: true, scrollTop: el.scrollTop, changed: el.scrollTop > 0, scrollHeight: el.scrollHeight };
});

const headerBox = await page.locator("header").first().boundingBox();
if (headerBox) {
  await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(500);
}

out.headerWheel = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("div"))
    .filter((d) => {
      const s = getComputedStyle(d);
      return (s.overflowY === "auto" || s.overflowY === "scroll") && d.scrollHeight > d.clientHeight + 40;
    })
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  return el ? { scrollTopAfterWheel: el.scrollTop, moved: el.scrollTop > 240 } : null;
});

out.drag = await page.evaluate(async () => {
  const invoke = (cmd, args = {}) => window.kovaHost.invoke(cmd, args);
  const pos0 = (await invoke("win_get_position")).value;
  const header = document.querySelector("header");
  const rect = header.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, screenX: 400, screenY: 300 };
  header.dispatchEvent(new MouseEvent("mousedown", opts));
  await new Promise((r) => setTimeout(r, 250));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: 460, screenY: 340 }));
  await new Promise((r) => setTimeout(r, 300));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, screenX: 460, screenY: 340 }));
  await new Promise((r) => setTimeout(r, 250));
  const pos1 = (await invoke("win_get_position")).value;
  await invoke("win_set_position", { x: pos0.x, y: pos0.y });
  return { from: pos0, to: pos1, dx: pos1.x - pos0.x, dy: pos1.y - pos0.y };
});

out.noDragBody = await page.evaluate(async () => {
  const invoke = (cmd, args = {}) => window.kovaHost.invoke(cmd, args);
  const pos0 = (await invoke("win_get_position")).value;
  const el = document.querySelector("main") || document.body;
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 200, clientY: rect.top + 300, screenX: 500, screenY: 500 }));
  await new Promise((r) => setTimeout(r, 200));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: 560, screenY: 560 }));
  await new Promise((r) => setTimeout(r, 250));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, screenX: 560, screenY: 560 }));
  const pos1 = (await invoke("win_get_position")).value;
  return { moved: pos1.x !== pos0.x || pos1.y !== pos0.y, from: pos0, to: pos1 };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
