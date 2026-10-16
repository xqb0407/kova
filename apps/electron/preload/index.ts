/**
 * preload：暴露 window.kovaHost（渲染层 desktop-bridge 的唯一宿主通道）。
 * contextBridge 不跨界传函数：事件/通道在此侧订阅，回调留在渲染侧本地分发。
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kovaHost", {
  invoke: (cmd: string, args: unknown) => ipcRenderer.invoke("kova-invoke", { cmd, args }),
  eventsOn: (cb: (m: { event: string; payload: unknown }) => void) => {
    ipcRenderer.on("kova-event", (_e, m) => {
      try {
        cb(m);
      } catch {
        /* 渲染侧订阅者异常不拖垮通道（与 旧桌面壳 前端行为一致） */
      }
    });
  },
  channelsOn: (cb: (m: { id: string; data: unknown }) => void) => {
    ipcRenderer.on("kova-channel", (_e, m) => {
      try {
        cb(m);
      } catch {
        /* 同上 */
      }
    });
  },
});

// 桌面环境标记：前端 isDesktop() 检测 __KOVA_DESKTOP__（见 lib/desktop-env.ts），
// 缺了它整个 UI 会退化成"网页访客"（远程配对页）。invoke 一并挂上，保证任何
// 直接调用也有真实出口。
const internals = {
  invoke: (cmd: string, args?: unknown) => ipcRenderer.invoke("kova-invoke", { cmd, args: args ?? {} }),
  // 形状占位：真正的回调分发走 kovaHost；这里只需可被探测到且不抛异常
  // （返回随机 id，不跨桥回传函数）
  transformCallback: (_cb: unknown, _once?: boolean) => Math.floor(Math.random() * 1e9),
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};
contextBridge.exposeInMainWorld("__KOVA_DESKTOP__", internals);

/**
 * 窗口拖拽区桥接（旧桌面壳 `data-drag-region` → Electron JS 拖拽）。
 *
 * 为什么不用 CSS `-webkit-app-region: drag`：它把整块区域变成 Chromium 的"标题栏"
 * 捕捉区——整窗任意处可拖（连子元素一起），且滚轮事件被吞、面板滚不动
 * （用户实测反馈）。改为 JS 精确实现 旧桌面壳 `drag.js` 的判定语义，拖拽只由
 * mousedown 目标决定，不影响滚轮/点击：
 *   - "false"：截停（显式豁免子树，如可选中文本、交互槽）
 *   - "deep" ：子树内（交互元素除外）可拖
 *   - "true" ：仅该元素自身可拖（含其 padding，不深入子树）
 * 拖拽本体走 IPC：取窗口当前位置 → 按屏幕坐标增量 setPosition（rAF 节流），
 * 双击拖拽区 = 切换最大化（macOS 顶栏惯例）。
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
].join(",");

function isInteractive(el: Element | null): boolean {
  if (!el) return false;
  try {
    if (el.closest(INTERACTIVE_SELECTOR)) return true;
  } catch {
    /* ignore */
  }
  if ((el as HTMLElement).isContentEditable) return true;
  const ti = el.getAttribute("tabindex");
  if (ti !== null && ti !== "-1") return true;
  return false;
}

/** 对齐旧桌面壳 drag.js：返回"本次 mousedown 命中哪个拖拽区"，null = 不拖 */
function dragRegionFor(target: Element | null): Element | null {
  let el: Element | null = target;
  while (el && el !== document.body && el !== document.documentElement) {
    const v = el.getAttribute("data-drag-region");
    if (v === "false") return null; // 显式截停
    if (v === "deep") return isInteractive(target) ? null : el; // 子树可拖，交互元素除外
    if (v === "true") return el === target ? el : null; // 仅自身命中
    el = el.parentElement;
  }
  return null;
}

function invokeMain(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  return ipcRenderer.invoke("kova-invoke", { cmd, args });
}

async function beginWindowDrag(e: MouseEvent): Promise<void> {
  const startScreenX = e.screenX;
  const startScreenY = e.screenY;
  let startWinX = 0;
  let startWinY = 0;
  let originReady = false; // 窗口起点未知前 onMove 不动作（防按未 await 的 0,0 跳窗）
  let pending: { x: number; y: number } | null = null;
  let raf = 0;
  let ended = false;
  const flush = () => {
    raf = 0;
    if (pending) {
      const p = pending;
      pending = null;
      void invokeMain("win_set_position", p);
    }
  };
  const onMove = (ev: MouseEvent) => {
    if (!originReady) return;
    pending = { x: startWinX + (ev.screenX - startScreenX), y: startWinY + (ev.screenY - startScreenY) };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onUp = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("blur", onUp, true);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    pending = null;
  };
  // 监听器必须先于 await 同步挂上：旧实现等 win_get_position 往返（IPC 繁忙时
  // 可达秒级）才挂，抬手若发生在该窗口期内 mouseup 直接丢失，监听永不摘除——
  // 之后每次 mousemove 都发 win_set_position，窗口跟着光标"鬼拖"
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  // Windows 上鼠标移出窗口/焦点被他窗抢占时 mouseup 不再投递：blur 兜底结束拖拽
  window.addEventListener("blur", onUp, true);
  const pos = await invokeMain("win_get_position");
  if (!pos?.ok || ended) {
    onUp();
    return;
  }
  startWinX = Number(pos.value?.x ?? 0);
  startWinY = Number(pos.value?.y ?? 0);
  originReady = true;
}

function installDragRegionBridge(): void {
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const target = e.target as Element | null;
      if (isInteractive(target)) return; // 交互元素：点击/拖选/滚动照常，不拦
      if (!dragRegionFor(target)) return;
      e.preventDefault(); // 与 旧桌面壳 一致：拖拽区内不起文本选区
      void beginWindowDrag(e);
    },
    true,
  );
  document.addEventListener(
    "dblclick",
    (e) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (isInteractive(target) || !dragRegionFor(target)) return;
      e.preventDefault();
      void invokeMain("win_toggle_maximize"); // macOS 顶栏双击缩放惯例
    },
    true,
  );
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", installDragRegionBridge, { once: true });
} else {
  installDragRegionBridge();
}
