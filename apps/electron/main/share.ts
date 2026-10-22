/**
 * 分享产物的宿主侧能力：
 * - share_render_image：渲染层把自包含 HTML 交过来，隐藏窗口加载后整页截图，
 *   直接写盘或写入剪贴板（不把 base64 大图再回传渲染层）。
 * - share_open_path：保存成功后用系统默认程序打开文件。
 *
 * 与 browser-shot.ts 同源做法（隐藏 BrowserWindow + capturePage），区别是
 * 这里要拍「整页」：优先走 CDP Page.captureScreenshot(captureBeyondViewport)，
 * 不受窗口高度限制；失败时退回 capturePage。
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  session,
  shell,
} from "electron";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const LOAD_TIMEOUT_MS = 20_000;
const FONT_IMAGE_TIMEOUT_MS = 6_000;
const SETTLE_MS = 120;
/** Chromium 纹理安全上限：单边超过这个像素数容易出现空图/内存暴涨 */
const MAX_DEVICE_PX = 16_384;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const DEFAULT_WIDTH = 900;

const clampNumber = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};

const waitForLoad = (win: BrowserWindow, filePath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("分享页加载超时，请重试")),
      LOAD_TIMEOUT_MS,
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new Error(message));
    };
    win.webContents.once("did-finish-load", done);
    win.webContents.once("did-fail-load", (_e, code, desc) =>
      fail(`分享页加载失败 (${code})：${desc}`),
    );
    win.loadFile(filePath).catch((err) => {
      fail(`分享页加载失败：${err instanceof Error ? err.message : String(err)}`);
    });
  });

type CaptureResult = {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
};

async function renderShareImage(
  html: string,
  width: number,
  scale: number,
): Promise<CaptureResult> {
  const tmpPath = join(
    app.getPath("temp"),
    `kova-share-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  writeFileSync(tmpPath, html, "utf8");

  let created: BrowserWindow | null = null;
  try {
    const win = new BrowserWindow({
      show: false,
      width,
      height: 900,
      backgroundColor: "#ffffff",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        // 内存分区：隐藏窗口只读一次本地 HTML，不写任何持久数据
        partition: "kova-share",
      },
    });
    created = win;

    // 分享页是静态快照：禁止导航/弹窗，防止产物里的链接把隐藏窗口带走
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) event.preventDefault();
    });

    await waitForLoad(win, tmpPath);

    // 字体与图片就位后再量高度，避免截到半张图/回退字体
    await win.webContents
      .executeJavaScript(
        `Promise.race([
          Promise.all([
            (document.fonts && document.fonts.ready) || Promise.resolve(),
            ...Array.from(document.images).map((img) =>
              typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve()
            ),
          ]),
          new Promise((resolve) => setTimeout(resolve, ${FONT_IMAGE_TIMEOUT_MS})),
        ]).then(() => true)`,
      )
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    const measured = (await win.webContents.executeJavaScript(
      `({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body ? document.body.scrollWidth : 0,
          1
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
          1
        ),
      })`,
    )) as { width: number; height: number };

    const contentWidth = Math.ceil(measured.width);
    const contentHeight = Math.ceil(measured.height);
    const budgetScale = Math.min(
      MAX_DEVICE_PX / contentWidth,
      MAX_DEVICE_PX / contentHeight,
    );
    if (budgetScale < MIN_SCALE) {
      throw new Error("内容过长，无法生成单张图片，请减少选择的消息后重试");
    }
    const effectiveScale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, scale, budgetScale),
    );

    let png: Buffer;
    let outWidth = Math.round(contentWidth * effectiveScale);
    let outHeight = Math.round(contentHeight * effectiveScale);
    let outScale = effectiveScale;
    try {
      const wc = win.webContents;
      wc.debugger.attach("1.3");
      try {
        await wc.debugger.sendCommand("Page.enable").catch(() => undefined);
        const shot = (await wc.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          fromSurface: true,
          clip: {
            x: 0,
            y: 0,
            width: contentWidth,
            height: contentHeight,
            scale: effectiveScale,
          },
        })) as { data?: string };
        if (!shot?.data) throw new Error("CDP 未返回图片数据");
        png = Buffer.from(shot.data, "base64");
      } finally {
        try {
          wc.debugger.detach();
        } catch {
          /* 已分离 */
        }
      }
    } catch {
      // 兜底：把隐藏窗口撑到内容高度再拍可视区（受系统窗口高度限制，
      // 但比整页截图失败后什么都没有强）
      const fallbackHeight = Math.min(
        contentHeight,
        Math.floor(MAX_DEVICE_PX / effectiveScale),
      );
      win.setContentSize(width, fallbackHeight);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) {
        throw new Error("截图失败：页面尚未绘制完成，请重试");
      }
      // 窗口高度被系统钳过时 capturePage 只拍到可视区：宁可报错也不产出半截图
      if (image.getSize().height + 2 < contentHeight) {
        throw new Error("内容过长，无法生成单张图片，请减少选择的消息后重试");
      }
      png = image.toPNG();
      // capturePage 走窗口 DIP 尺寸（toPNG 默认 1x），不能沿用 CDP 的缩放元数据
      const size = image.getSize();
      outWidth = size.width;
      outHeight = size.height;
      outScale = 1;
    }

    return {
      png,
      width: outWidth,
      height: outHeight,
      scale: outScale,
    };
  } finally {
    if (created && !created.isDestroyed()) created.destroy();
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 临时文件可能已被清理 */
    }
  }
}

export function setupShareCommands(
  register: (name: string, fn: (args: any, ctx: any) => any) => void,
): void {
  // 分享页是自包含产物：除了本地临时 HTML，任何远程请求都没有存在的理由。
  // 用一个专用内存分区把出站网络整体掐掉（产物里的外链图片/字体也不会偷跑）。
  const shareSession = session.fromPartition("kova-share");
  shareSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith("file:") ||
      details.url.startsWith("data:") ||
      details.url.startsWith("blob:");
    callback({ cancel: !allowed });
  });

  register("share_render_image", async (args) => {
    const html = String(args?.html ?? "");
    if (!html.trim()) throw new Error("分享内容为空");
    const width = Math.round(clampNumber(args?.width, DEFAULT_WIDTH, 420, 1600));
    const scale = clampNumber(args?.scale, 2, MIN_SCALE, MAX_SCALE);
    const savePath =
      typeof args?.savePath === "string" && args.savePath.length > 0
        ? args.savePath
        : null;
    if (savePath && !isAbsolute(savePath)) throw new Error("bad-path");

    const result = await renderShareImage(html, width, scale);

    // 先写盘再写剪贴板：落盘失败（权限/磁盘）时不留"剪贴板已被覆盖但报错"的中间态
    if (savePath) writeFileSync(savePath, result.png);
    if (args?.copy) {
      // Electron 44 起 clipboard 改为异步 W3C 形状（writeText/write(ClipboardItem[])）
      const bytes = new Uint8Array(result.png.byteLength);
      bytes.set(result.png);
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([bytes], { type: "image/png" }),
        }),
      ]);
    }

    return {
      path: savePath,
      copied: Boolean(args?.copy),
      width: result.width,
      height: result.height,
      scale: Number(result.scale.toFixed(2)),
      bytes: result.png.length,
    };
  });

  register("share_open_path", async (args) => {
    const filePath = String(args?.path ?? "");
    if (!isAbsolute(filePath) || !existsSync(filePath)) throw new Error("bad-path");
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    return null;
  });
}
