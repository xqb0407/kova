/**
 * 聊天区滚动回归（CDP）：
 *   node apps/electron/scripts/e2e-scroll.mjs [cdpPort]
 * 步骤：跳引导（如出现）→ 打开一个会话 → 对消息视口真实滚轮 →
 * 断言 scrollTop 变化（向下/向上双向）+ 视口内不存在拖拽区（回归护栏）。
 */
import { chromium } from "playwright-core";
const port = process.argv[2] ?? "19452";
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of b.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
if (!page) { console.error("FAIL: no page"); process.exit(1); }
await page.bringToFront();
const out = {};

// 1) 引导页：点「稍后再说」跳过（有才点）
const skip = page.getByText("稍后再说", { exact: false }).first();
if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(900); out.onboardingSkipped = true; }
else out.onboardingSkipped = false;

// 2) 打开一个会话（侧栏第一条），确保消息区有内容
const sessionBtn = page.locator("button, [role=button]").filter({ hasText: /家里nas|docker|澄清|智能家居|你好|介绍/ }).first();
if (await sessionBtn.count()) { await sessionBtn.click().catch(() => {}); await page.waitForTimeout(1500); }
out.sessionOpened = await page.evaluate(() => /家里nas|docker|澄清|智能家居/.test(document.body.innerText));

// 3) 找聊天视口（message-scroller 的 overflow-y-auto overscroll-contain）
const vp = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("*")).find((d) => {
    const s = getComputedStyle(d);
    return (s.overflowY === "auto" || s.overflowY === "scroll") && /overscroll-contain/.test(String(d.className)) && d.scrollHeight > d.clientHeight + 20;
  });
  if (!el) return null;
  el.scrollTop = 0;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(200, r.height / 2)), sh: el.scrollHeight, ch: el.clientHeight };
});
out.viewport = vp;
if (!vp) { console.log(JSON.stringify({ ...out, result: "NO_SCROLLABLE_VIEWPORT" }, null, 2)); await b.close(); process.exit(0); }

const readTop = () => page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("*")).find((d) => /overscroll-contain/.test(String(d.className)) && (getComputedStyle(d).overflowY === "auto" || getComputedStyle(d).overflowY === "scroll"));
  return el ? el.scrollTop : null;
});

await page.mouse.move(vp.x, vp.y);
await page.mouse.wheel(0, 400);
await page.waitForTimeout(600);
const down = await readTop();
await page.mouse.wheel(0, -250);
await page.waitForTimeout(600);
const up = await readTop();
out.wheel = { afterDown: down, afterUp: up, scrollsDown: (down ?? 0) > 0, scrollsUp: (up ?? 0) < (down ?? 0) };

// 4) 回归护栏：视口区域的祖先链上不应再有 app-region 拖拽区
out.noDragRegionOverViewport = await page.evaluate((pt) => {
  let el = document.elementFromPoint(pt.x, pt.y);
  while (el) {
    const v = getComputedStyle(el).webkitAppRegion;
    if (v && v !== "none") return false;
    el = el.parentElement;
  }
  return true;
}, vp);

console.log(JSON.stringify(out, null, 2));
await b.close();
