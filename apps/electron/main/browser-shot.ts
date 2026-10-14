/**
 * 页面像素照（对齐 browser_shot.rs 语义：一次性拍摄指定 URL）。
 * Electron 版不再拉起无头 Chrome：用隐藏 BrowserWindow（paintWhenInitiallyHidden
 * 默认开，隐藏窗口仍渲染）+ capturePage，再按同一压缩阶梯压到内联预算内。
 * 与 Rust 版差异（PORTING-NOTES）：无独立 Chrome 进程，也就没有孤儿清扫。
 */
import { BrowserWindow } from "electron";

const DEFAULT_MAX_DIM = 1920;
const DEFAULT_QUALITY = 70;
const INLINE_BUDGET_BYTES = 1_800_000;
const LOAD_TIMEOUT_MS = 30_000;

function clamp(v: number | null | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.max(min, Math.min(max, n));
}

/** 压缩重试阶梯：同 Rust build_screenshot_ladder（降质两档 → 逐级缩尺寸） */
export function buildLadder(maxDim: number, quality: number): [number, number][] {
  const ladder: [number, number][] = [[maxDim, quality]];
  for (const q of [Math.max(quality - 15, 35), Math.max(quality - 30, 35)]) {
    if (ladder[ladder.length - 1][1] !== q) ladder.push([maxDim, q]);
  }
  const midQ = Math.min(60, Math.max(45, quality));
  for (const d of [1600, 1280, 1024]) {
    if (d < maxDim) ladder.push([d, midQ]);
  }
  return ladder;
}

export async function capture(
  url: string,
  maxDim: number | null,
  quality: number | null,
  guard?: { isCancelled?: () => boolean },
): Promise<any> {
  const dim = clamp(maxDim, DEFAULT_MAX_DIM, 320, 7680);
  const q = clamp(quality, DEFAULT_QUALITY, 30, 100);
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`page load timed out after ${LOAD_TIMEOUT_MS}ms: ${url}`)), LOAD_TIMEOUT_MS);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
      win.webContents.once("did-fail-load", (_e, code, desc) => {
        clearTimeout(timer);
        reject(new Error(`page load failed (${code}): ${desc} — ${url}`));
      });
      void win.loadURL(url).catch((e) => {
        clearTimeout(timer);
        reject(new Error(`page load failed: ${e?.message ?? e}`));
      });
    });
    // 渲染追赶（与 Rust 版 400ms settle 对齐）
    await new Promise((r) => setTimeout(r, 400));
    if (guard?.isCancelled?.()) throw new Error("cancelled");

    const shot = await win.webContents.capturePage();
    if (shot.isEmpty()) throw new Error("screenshot produced no output (capturePage returned an empty image)");

    let best: Buffer | null = null;
    let bestSize = { width: shot.getSize().width, height: shot.getSize().height };
    for (const [d, qq] of buildLadder(dim, q)) {
      const size = shot.getSize();
      const scale = Math.min(1, d / Math.max(size.width, size.height));
      const resized =
        scale < 1 ? shot.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: "good" }) : shot;
      const buf = resized.toJPEG(qq);
      if (!best || buf.length < best.length) {
        best = buf;
        bestSize = resized.getSize();
      }
      if (best && best.length <= INLINE_BUDGET_BYTES) break;
    }
    if (!best) throw new Error("screenshot produced no output (encoding failed at every tier)");
    return {
      base64: best.toString("base64"),
      mimeType: "image/jpeg",
      bytes: best.length,
      width: bestSize.width,
      height: bestSize.height,
    };
  } finally {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** 兼容旧名（Rust 版冷启动清扫的占位：Electron 无独立 Chrome 进程可清） */
export function sweepOrphans(): void {
  /* no-op：隐藏窗口随调用即 destroy，不存在跨进程孤儿 */
}
