/**
 * 页面像素照（browser_shot 的隐藏窗口回退路径）。
 * 面板当前页优先走 CDP 活页面截图（browser.ts）；这里只在显式给 url、或面板
 * 不可用时加载一个一次性隐藏窗口。窗口复用面板 partition，登录态与面板一致，
 * 也接受同一套权限闸门；URL 走 browser-urls 白名单（file: 限受信根）。
 */
import { BrowserWindow } from "electron";
import { BROWSER_PARTITION } from "./browser-permissions";
import { isAllowedBrowserUrl } from "./browser-urls";
import { noteMainOp } from "./slow-ops";

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
  if (!isAllowedBrowserUrl(url)) {
    throw new Error(
      `browser_shot: blocked unsupported url: ${url} (http/https, or file inside the workspace)`,
    );
  }
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
      // 与面板同一持久化分区：已登录页面拍到的就是已登录状态，而不是登录墙。
      partition: BROWSER_PARTITION,
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
    // 这一圈 resize/toJPEG 是同步的（只在这条「显式 url」回退路径上）；重页面
    // 噪声大时会连续编码多档，留痕便于把 [lag] 归因到具体步骤。
    const encodeStart = Date.now();
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
    noteMainOp("browser:shot-ladder", Date.now() - encodeStart);
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
