/**
 * 聊天端到端测试（CDP 驱动，仅测试用）：
 *   node apps/electron/scripts/e2e-chat.mjs [cdpPort]
 * 前置：Electron 以 --remote-debugging-port 且 KOVA_DATA_DIR 指向沙箱启动。
 * 步骤：新对话 → 输入 → 发送 → 等流式回复（pi-chunk-batch 事件 + DOM 文本）。
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9222";
const PROMPT = "请用一句话介绍你自己（不要说可以帮你做什么，只介绍你是谁）";
const timeoutMs = 120000;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
if (!page) {
  console.error("FAIL: no kova:// page");
  process.exit(1);
}

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

// 事件探针：统计 pi-chunk-batch 到达行数与最后一批内容
await page.evaluate(() => {
  window.__e2e = { batches: 0, lines: 0, lastTypes: [], piExit: 0 };
  window.kovaHost.eventsOn((m) => {
    if (m.event === "pi-chunk-batch") {
      window.__e2e.batches += 1;
      const arr = Array.isArray(m.payload) ? m.payload : [];
      window.__e2e.lines += arr.length;
      for (const row of arr.slice(0, 200)) {
        try {
          const v = JSON.parse(row.l ?? "{}");
          const t = v?.chunk?.type ?? v?.type ?? "?";
          if (!window.__e2e.lastTypes.includes(t)) window.__e2e.lastTypes.push(t);
        } catch {
          /* 半行 */
        }
      }
    }
    if (m.event === "pi-exit") window.__e2e.piExit += 1;
  });
});

// 1) 关闭可能的首启引导层（z-[60] 全屏覆盖），不点"新对话"（避免再开引导）
await page.evaluate(() => {
  const overlays = Array.from(document.querySelectorAll("div.fixed.inset-0"));
  for (const el of overlays) {
    const z = getComputedStyle(el).zIndex;
    if (z && Number(z) >= 50) el.remove();
  }
});
await page.waitForTimeout(500);

// 2) 找到输入框（assistant-ui composer：contenteditable 或 textarea）
const composerCandidates = [
  page.locator('[contenteditable="true"]').last(),
  page.locator("textarea").last(),
];
let composer = null;
for (const c of composerCandidates) {
  if ((await c.count()) > 0) {
    composer = c;
    break;
  }
}
if (!composer) {
  console.error("FAIL: composer not found");
  await page.screenshot({ path: "/tmp/kova-chat-fail.png" });
  process.exit(1);
}

// 3) 程序化聚焦输入框（CodeMirror），键盘输入并发送
await page.evaluate(() => {
  const el = document.querySelector(".cm-content");
  el?.focus?.();
});
await page.waitForTimeout(200);
await page.keyboard.type(PROMPT, { delay: 12 });
await page.waitForTimeout(300);
await page.keyboard.press("Enter");

// 4) 等待流式回复：先等事件批次，再等 DOM 出现助手文本
const t0 = Date.now();
let firstBatchAt = 0;
while (Date.now() - t0 < timeoutMs) {
  const ev = await page.evaluate(() => window.__e2e);
  if (ev.batches > 0 && !firstBatchAt) firstBatchAt = Date.now();
  if (ev.batches > 0) {
    const text = await page.evaluate(() => document.body.innerText);
    if (text.includes(PROMPT)) {
      // 助手回复 = 文本里出现除用户消息以外的较新内容：轮询 assistant 区域
    }
  }
  // 收尾判定：pi-chunk-batch 出现 finish 或错误，或者 DOM 中助手文字足够
  const done = await page.evaluate(() => {
    const t = window.__e2e.lastTypes;
    return t.includes("finish") || t.includes("error");
  });
  if (done) break;
  await page.waitForTimeout(1000);
}

const ev = await page.evaluate(() => window.__e2e);
const bodyText = await page.evaluate(() => document.body.innerText);
const url = page.url();
await page.screenshot({ path: "/tmp/kova-chat-result.png", fullPage: true });

const result = {
  url,
  prompt: PROMPT,
  chunkBatches: ev.batches,
  chunkLines: ev.lines,
  chunkTypes: ev.lastTypes,
  piExit: ev.piExit,
  waitedMs: Date.now() - t0,
  assistantTextSample: bodyText.slice(-1200),
  consoleErrors,
};
writeFileSync("/tmp/kova-chat-e2e.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
