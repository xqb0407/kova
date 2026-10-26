/**
 * 启动性能观测：FCP / LCP + app-shell 时间点。
 *
 * 只做一次性记录，不改 UI、不阻塞启动：
 * - PerformanceObserver 收 paint / largest-contentful-paint（buffered，水合后
 *   安装也能拿到更早的条目）；
 * - 页面隐藏或启动后 5s 落一条 [perf] 到 web.log，避免每次加载刷屏；
 * - window.__kovaStartupPerf() 可现场取当前值。
 *
 * 桌面端 Chromium 支持这些 API；老 WebView 不支持时静默降级。
 */
import { reportFrontendWarning } from "@/lib/frontend-logging";

type LcpSnapshot = {
  t: number;
  size: number;
  tag?: string;
  text?: string;
};

type PaintSnapshot = { name: string; t: number };

let installed = false;
let logged = false;
let appShellAt: number | null = null;
let lcp: LcpSnapshot | null = null;
let paints: PaintSnapshot[] = [];

function elementLabel(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const text = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
  return `${el.tagName.toLowerCase()}${text ? ` "${text.slice(0, 60)}"` : ""}`;
}

function readPaint(): PaintSnapshot[] {
  try {
    return performance
      .getEntriesByType("paint")
      .map((e) => ({ name: e.name, t: Math.round(e.startTime) }));
  } catch {
    return [];
  }
}

function buildSnapshot() {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return {
    fcp: paints.find((p) => p.name === "first-contentful-paint")?.t ?? null,
    lcp: lcp ? { ...lcp } : null,
    appShell: appShellAt === null ? null : Math.round(appShellAt),
    load: nav ? Math.round(nav.loadEventEnd) : null,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
  };
}

function logOnce(): void {
  if (logged) return;
  logged = true;
  paints = readPaint();
  const s = buildSnapshot();
  reportFrontendWarning(
    `[perf] startup fcp=${s.fcp ?? "n/a"}ms lcp=${
      s.lcp ? `${s.lcp.t}ms size=${s.lcp.size} ${s.lcp.tag ?? ""} ${s.lcp.text ?? ""}` : "n/a"
    } appShell=${s.appShell ?? "n/a"}ms load=${s.load ?? "n/a"}ms`,
  );
}

export function installStartupMetrics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  paints = readPaint();

  try {
    const supported = (
      PerformanceObserver as unknown as { supportedEntryTypes?: string[] }
    ).supportedEntryTypes;
    if (supported?.includes("largest-contentful-paint")) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & {
            size?: number;
            element?: Element | null;
          };
          lcp = {
            t: Math.round(entry.startTime),
            size: Math.round(e.size ?? 0),
            tag: e.element?.tagName.toLowerCase(),
            text: e.element
              ? String(e.element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
              : undefined,
          };
        }
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      window.addEventListener("pagehide", () => logOnce(), { once: true });
    }
  } catch {
    /* 不支持就不测 */
  }

  window.setTimeout(logOnce, 5000);
  (window as unknown as { __kovaStartupPerf?: () => unknown }).__kovaStartupPerf =
    () => {
      paints = readPaint();
      return buildSnapshot();
    };
}

/** 应用壳提交后调用；effect 内执行，此时首屏已经落盘。 */
export function markAppShell(): void {
  if (appShellAt !== null) return;
  try {
    appShellAt = performance.now();
    performance.mark("kova:app-shell");
    console.warn(`[perf] app-shell ${Math.round(appShellAt)}ms`);
  } catch {
    /* 忽略 */
  }
}

/** 测试/调试用：当前快照 */
export function startupPerfSnapshot() {
  paints = readPaint();
  return buildSnapshot();
}
