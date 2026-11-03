/**
 * deck 浏览器性能基准：模拟宿主 iframe 推 200 页合成档，量真实渲染路径。
 *   - 首屏就绪（doc.open → 缩略图可交互）
 *   - 选中第 150 页的重渲染耗时
 *   - 缩略图列表滚动 1.2s 的长任务与最大帧间隔
 *
 * 表格命令连发基准见 bench/sheet-bench.ts（含 250ms 合并窗口的前后对照）。
 * 用法：bun bench/run.ts，PAGES=200 bun bench/run.ts
 */
import { chromium } from "playwright-core";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PAGES = Number(process.env.PAGES ?? 200);
const UI_PORT = Number(process.env.UI_PORT ?? 5399);
const HOST_PORT = 5300;

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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));

// 每个 frame（含 iframe）都装 longtask 观察器
await page.addInitScript(() => {
  try {
    (window as any).__lt = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as any).__lt.push({ startTime: e.startTime, duration: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* 老浏览器忽略 */
  }
});

try {
  const params = new URLSearchParams({ kind: "deck", pages: String(PAGES), ui: String(UI_PORT) });
  await page.goto(`http://localhost:${HOST_PORT}/host.html?${params}`, { waitUntil: "load" });
  const frame = await (async () => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find((x) => x.url().includes(`:${UI_PORT}/`));
      if (f) return f;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("UI iframe 未挂载");
  })();
  await page.waitForFunction(() => typeof (window as any).__benchSentAt === "number", undefined, { timeout: 30000 });
  const bootStart = Date.now();
  await frame.waitForFunction(
    (n) => {
      const el = document.querySelector("[data-rail-count]") as HTMLElement | null;
      return !!el && Number(el.dataset.railCount) >= n && !!document.querySelector("[data-rail-index]");
    },
    PAGES,
    { timeout: 90000 },
  );
  const bootMs = Date.now() - bootStart;

  // 选中第 150 页：React 重渲染 + 两帧 paint（含 ~33ms 的 rAF 基线）
  const selectMs = await frame.evaluate(async () => {
    const sc = document.querySelector("[data-rail-scroll]") as HTMLElement | null;
    if (!sc) return -1;
    sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (149 / 199);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = (document.querySelector('[data-rail-index="149"]') ?? document.querySelector("[data-rail-index]")) as HTMLElement | null;
    if (!el) return -2;
    const t0 = performance.now();
    el.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  });

  // 缩略图列表滚动 1.2s：长任务与帧间隔
  const scroll = await frame.evaluate(async () => {
    const sc = document.querySelector("[data-rail-scroll]") as HTMLElement | null;
    if (!sc) return { error: "找不到缩略图滚动容器" };
    (window as any).__lt = [];
    const gaps: number[] = [];
    let last = performance.now();
    const start = Date.now();
    const loop = (t: number) => {
      gaps.push(t - last);
      last = t;
      if (Date.now() - start < 1200) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    for (let i = 0; i <= 40; i++) {
      sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * (i / 40);
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 400));
    const lt = ((window as any).__lt ?? []) as { duration: number }[];
    return {
      longtasks: lt.length,
      longtaskMs: Math.round(lt.reduce((n, e) => n + e.duration, 0)),
      maxGapMs: Math.round(Math.max(...gaps, 0)),
    };
  });

  console.log(`\n[deck ${PAGES} 页]`);
  console.log(`  首屏就绪（doc.open → 缩略图可交互）: ${bootMs} ms`);
  console.log(`  选中第 150 页重渲染: ${selectMs.toFixed(1)} ms（含两帧 rAF 基线）`);
  console.log(`  列表滚动 1.2s: longtasks=${scroll.longtasks ?? "-"} (${scroll.longtaskMs ?? "-"} ms), 最大帧间隔=${scroll.maxGapMs ?? "-"} ms`);
} finally {
  await browser.close();
  hostServer.stop(true);
  vite?.kill();
}
