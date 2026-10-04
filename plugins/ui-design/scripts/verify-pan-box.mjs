/**
 * verify-pan-box.mjs —— 无头浏览器实测：滚动（滚轮平移）时编辑器选框是否跟随场景。
 *
 * 口径：seed 一个含两个矩形的本地档 → 打开 design.html（standalone 自动开档）→
 * 选中两个节点 → 量「节点屏幕矩形 vs 编辑器框屏幕矩形」的差 → 派发 wheel(dy=+100) →
 * 再量。差值在滚动后仍 ≈0 ⇒ 框贴合；差值变化 ⇒ 漂移，数值即漂移量（px，屏幕坐标）。
 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = pathToFileURL(path.resolve(dir, "../design.html")).href;

const SEED = {
  version: 1,
  meta: { name: "选框实测", kind: "uidesign" },
  activePage: "p1",
  pages: [
    {
      id: "p1",
      name: "Page 1",
      nodes: [
        { id: "r1", type: "rect", x: 100, y: 100, w: 120, h: 80, fills: [{ type: "solid", color: "#e5484d", opacity: 1 }] },
        { id: "r2", type: "rect", x: 260, y: 160, w: 120, h: 80, fills: [{ type: "solid", color: "#30a46c", opacity: 1 }] },
      ],
    },
  ],
};

import os from "node:os";
const shell = path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell");
const browser = await chromium.launch({ executablePath: shell });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.addInitScript((seed) => {
  localStorage.setItem("ui-design-local-doc", seed);
}, JSON.stringify(SEED));
await page.goto(html);
await page.waitForFunction(() => !!(window).__designLeafer, null, { timeout: 15000 });
// 等场景 patch + fitView 落定
await page.waitForTimeout(1200);

const probe = async (label) => {
  const r = await page.evaluate(() => {
    const L = window.__designLeafer;
    const rectOf = (el) => {
      const b = el.getWorldRect ? el.getWorldRect() : el.getBounds?.();
      return b ? { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 } : null;
    };
    const n1 = L.nodes.get("r1");
    const n2 = L.nodes.get("r2");
    if (!n1 || !n2) return { err: "nodes missing: " + [...L.nodes.keys()].join(",") };
    return {
      node1: rectOf(n1.node),
      node2: rectOf(n2.node),
      world: { x: n1.node.parent?.x, y: n1.node.parent?.y, sx: n1.node.parent?.scaleX },
      editChildren: L.editor.children.map((c) => ({ tag: c.__leafer?.className ?? c.constructor?.name, rect: rectOf(c), visible: c.visible })),
    };
  });
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(r, null, 1));
  return r;
};

// 多选两个节点（走 editor 原生 select，等价于用户点选）
await page.evaluate(() => {
  const L = window.__designLeafer;
  L.editor.select([L.nodes.get("r1").node, L.nodes.get("r2").node]);
});
await page.waitForTimeout(600);
const before = await probe("selected, before wheel");

// 派发滚轮：画布中心，dy=+100（内容应上移 100）
const cdp = await page.context().newCDPSession(page);
const box = await page.evaluate(() => {
  const r = window.__designLeafer.app.view.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const wheel = async (deltaY, ctrl = false) => {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: box.x,
    y: box.y,
    deltaX: 0,
    deltaY,
    pointerType: "mouse",
    modifiers: ctrl ? 2 : 0,
  });
  await page.waitForTimeout(400);
};

/** 判定：每个可见编辑框子元素的屏幕位移必须等于内容的位移（框贴内容 = 不漂移） */
const check = (name, before, after, expectDy) => {
  const ub = union(before);
  const ua = union(after);
  let pass = ua.x - ub.x === 0 && ua.y - ub.y === expectDy;
  console.log(`\n### ${name}：内容位移 dy=${ua.y - ub.y}（期望 ${expectDy}）${pass ? "" : " ✗"}`);
  const nb = before.editChildren.length;
  for (let i = 0; i < nb; i++) {
    const b = before.editChildren[i];
    const a = after.editChildren[i];
    if (!b || !a || !b.rect || !a.rect || !b.visible || !a.visible) continue;
    const dy = Math.round((a.rect.y - b.rect.y) * 10) / 10;
    const dx = Math.round((a.rect.x - b.rect.x) * 10) / 10;
    const ok = dy === expectDy && dx === 0;
    if (!ok) pass = false;
    console.log(`  [${i}] ${a.tag} 位移 {dx:${dx}, dy:${dy}} ${ok ? "✓" : "✗ 漂移"}  before=${JSON.stringify(b.rect)} after=${JSON.stringify(a.rect)}`);
  }
  console.log(`### ${name} → ${pass ? "PASS" : "FAIL"}`);
  return pass;
};

const union = (r) => {
  const x1 = Math.min(r.node1.x, r.node2.x);
  const y1 = Math.min(r.node1.y, r.node2.y);
  const x2 = Math.max(r.node1.x + r.node1.w, r.node2.x + r.node2.w);
  const y2 = Math.max(r.node1.y + r.node1.h, r.node2.y + r.node2.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

let ok = true;
await wheel(100);
const after1 = await probe("multi after wheel");
ok = check("多选·滚轮平移 dy=+100", before, after1, -100) && ok;
await wheel(-60);
const after2 = await probe("multi after 2nd wheel");
ok = check("多选·反向滚回 dy=-60", after1, after2, 60) && ok;
// 单选一轮：单目标框画在真节点上（无快照），应天然跟随
await page.evaluate(() => {
  const L = window.__designLeafer;
  L.editor.select([L.nodes.get("r1").node]);
});
await page.waitForTimeout(500);
const sBefore = await probe("single before wheel");
await wheel(100);
ok = check("单选·滚轮平移 dy=+100", sBefore, await probe("single after wheel"), -100) && ok;
// 缩放一轮（⌘+滚轮）：框应锚在光标处、不漂移（内容位移在期望内）
await page.evaluate(() => {
  const L = window.__designLeafer;
  L.editor.select([L.nodes.get("r1").node, L.nodes.get("r2").node]);
});
await page.waitForTimeout(500);
const zBefore = await probe("multi before zoom");
await wheel(-100, true);
{
  // 缩放不比对位移数值（锚点在光标），只断言框与内容仍然重合：
  // 每子元素 rect 与内容 union rect 的相对偏移（含固定 padding）在缩放前后保持不变
  const zAfter = await probe("multi after zoom");
  const relOf = (p) => p.editChildren.map((c) => (c.rect && c.visible ? { tag: c.tag, dx: c.rect.x - union(p).x, dy: c.rect.y - union(p).y } : null)).filter(Boolean);
  const rb = relOf(zBefore);
  const ra = relOf(zAfter);
  let okz = rb.length === ra.length && rb.length >= 2;
  for (let i = 0; i < rb.length; i++) {
    const same = rb[i].tag === ra[i].tag && Math.abs(rb[i].dx - ra[i].dx) <= 1 && Math.abs(rb[i].dy - ra[i].dy) <= 1;
    if (!same) okz = false;
    console.log(`\n缩放保持重合 [${i}] ${ra[i].tag}: before偏移 {${rb[i].dx},${rb[i].dy}} after {${ra[i].dx},${ra[i].dy}} ${same ? "✓" : "✗"}`);
  }
  console.log(`### 多选·⌘滚轮缩放 → ${okz ? "PASS" : "FAIL"}`);
  ok = okz && ok;
}
await page.screenshot({ path: path.resolve(dir, "../.tmp-pan-box.png") });
console.log(`\n=== 总结: ${ok ? "ALL PASS ✅" : "FAIL ❌"} ===`);
await browser.close();
process.exit(ok ? 0 : 1);
