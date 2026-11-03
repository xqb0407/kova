/**
 * 表格命令连发基准（独立脚本）：5 万格工作簿 + 12 次工具栏「粗体」点击。
 *
 * 对比两种「命令 → 整档快照」策略：
 *   EMIT_DELAY=0   → 每条命令立即 save()+stringify（优化前行为，等价对照）
 *   EMIT_DELAY=250 → 250ms 合并窗口（当前默认）
 * 指标：宿主收到的 doc.change 次数 / 总字节（每份快照约 2.8MB），以及输入期间的最大帧间隔。
 *
 * 用法：bun bench/sheet-bench.ts
 */
import { chromium } from "playwright-core";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const UI_PORT = 5399;
const HOST_PORT = 5300;
const ROWS = Number(process.env.ROWS ?? 200);
const COLS = Number(process.env.COLS ?? 250);
const CLICKS = Number(process.env.CLICKS ?? 12);
const GAP = Number(process.env.CLICK_GAP ?? 120);

const hostServer = Bun.serve({
  port: HOST_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/host.html") {
      return new Response(Bun.file(path.join(ROOT, "bench", "host.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const uiUp = async (): Promise<boolean> => {
  try {
    const r = await fetch(`http://localhost:${UI_PORT}/`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    return (await r.text()).includes('id="root"');
  } catch {
    return false;
  }
};
let vite: ReturnType<typeof Bun.spawn> | null = null;
if (!(await uiUp())) {
  vite = Bun.spawn(
    [path.join(ROOT, "node_modules", ".bin", "vite"), "--config", "ui/vite.config.ts", "--port", String(UI_PORT), "--strictPort"],
    { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
  );
  for (let i = 0; i < 60; i++) {
    if (await uiUp()) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});

async function runOnce(delay: number): Promise<{ changes: number; mb: number; maxGap: number; bigFrames: number }> {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const params = new URLSearchParams({
    kind: "sheet",
    rows: String(ROWS),
    cols: String(COLS),
    ui: String(UI_PORT),
    emit: String(delay),
  });
  await page.goto(`http://localhost:${HOST_PORT}/host.html?${params}`, { waitUntil: "load" });
  await page.waitForTimeout(4500); // 等 Univer 就绪（与手工验证一致）
  const frame = page.frames().find((f) => f.url().includes(`:${UI_PORT}/`));
  if (!frame) throw new Error("UI iframe 未挂载");
  await frame.waitForSelector('canvas[id^="univer-sheet-main-canvas"]', { timeout: 60000 });
  await page.waitForTimeout(1200);
  const canvas = frame.locator('canvas[id^="univer-sheet-main-canvas"]').first();
  await canvas.click({ position: { x: 120, y: 90 } });
  await page.waitForTimeout(400);

  const base = await page.evaluate(() => ({
    changes: Number((window as any).__changes ?? 0),
    bytes: Number((window as any).__changeBytes ?? 0),
  }));

  // 帧间隔采集（iframe 内 rAF）
  await frame.evaluate(() => {
    const w = window as any;
    w.__gaps = [];
    let last = performance.now();
    let running = true;
    const loop = (t: number) => {
      w.__gaps.push(t - last);
      last = t;
      if (running) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    w.__stopGaps = () => {
      running = false;
      const gaps: number[] = w.__gaps;
      return { maxGap: Math.round(Math.max(...gaps, 0)), bigFrames: gaps.filter((g) => g > 40).length };
    };
  });

  const bold = frame.locator('[aria-label="粗体"]').filter({ visible: true }).first();
  for (let i = 0; i < CLICKS; i++) {
    await bold.click();
    await page.waitForTimeout(GAP);
  }
  await page.waitForTimeout(500);
  const gaps = (await frame.evaluate(() => (window as any).__stopGaps())) as { maxGap: number; bigFrames: number };
  const total = await page.evaluate(() => ({
    changes: Number((window as any).__changes ?? 0),
    bytes: Number((window as any).__changeBytes ?? 0),
  }));
  await page.close();
  return {
    changes: total.changes - base.changes,
    mb: (total.bytes - base.bytes) / 1024 / 1024,
    maxGap: gaps.maxGap,
    bigFrames: gaps.bigFrames,
  };
}

try {
  console.log(`\n[sheet ${ROWS}×${COLS} = ${((ROWS * COLS) / 1000).toFixed(0)}k 格] ${CLICKS} 次「粗体」点击 @${GAP}ms`);
  for (const [label, delay] of [
    ["优化前等价（每条命令立即序列化）", 0],
    ["优化后（250ms 合并窗口）", 250],
  ] as const) {
    const r = await runOnce(delay);
    console.log(`  ${label}: 上报 ${r.changes} 次 / ${r.mb.toFixed(1)} MB | 最大帧间隔 ${r.maxGap}ms，>40ms 帧 ${r.bigFrames}`);
  }
} finally {
  await browser.close();
  hostServer.stop(true);
  vite?.kill();
}
