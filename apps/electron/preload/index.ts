/**
 * preload：暴露 window.kovaHost（渲染层 desktop-bridge 的唯一宿主通道）。
 * contextBridge 不跨界传函数：事件/通道在此侧订阅，回调留在渲染侧本地分发。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("kovaHost", {
  invoke: (cmd: string, args: unknown) => ipcRenderer.invoke("kova-invoke", { cmd, args }),
  /**
   * 拖拽落下的 File → 磁盘绝对路径。Electron 32 起 File.path 已移除，官方
   * 推荐在 preload 用 webUtils.getPathForFile 取（资料库「拖入导入」用）；
   * 非真实磁盘文件（如从浏览器拖来的虚拟文件）返回空串。
   */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
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
 * 双击拖拽区 = 切换最大化（macOS 顶栏惯例）。Windows 上最大化窗口按原生
 * drag-to-restore：越过拖拽阈值后先还原再跟手；全屏（没有标题栏）不响应。
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

/** Windows 原生拖拽阈值（SM_CXDRAG 默认 4px）：阈值内单击标题栏保持最大化 */
const DRAG_RESTORE_THRESHOLD = 4;
/** 只有 Windows 有"拖最大化标题栏先还原"的原生语义；macOS 缩放窗口可直接移动 */
const IS_WIN32 = process.platform === "win32";

type DragBounds = { x: number; y: number; width: number; height: number };

async function beginWindowDrag(e: MouseEvent): Promise<void> {
  let startScreenX = e.screenX;
  let startScreenY = e.screenY;
  let lastScreenX = e.screenX;
  let lastScreenY = e.screenY;
  let startWinX = 0;
  let startWinY = 0;
  let originReady = false; // 窗口起点未知前不做位移（防按未 await 的 0,0 跳窗）
  let pending: { x: number; y: number } | null = null;
  let raf = 0;
  let ended = false;
  // 最大化窗口的还原态：非 null 表示还没跨过阈值，第一次有效拖动要先还原
  let maximizedBounds: DragBounds | null = null;
  let restoring = false;
  const flush = () => {
    raf = 0;
    if (pending) {
      const p = pending;
      pending = null;
      void invokeMain("win_set_position", p).catch(() => {});
    }
  };
  const applyMove = (screenX: number, screenY: number) => {
    if (!originReady || restoring) return;
    if (maximizedBounds) {
      if (
        Math.abs(screenX - startScreenX) < DRAG_RESTORE_THRESHOLD &&
        Math.abs(screenY - startScreenY) < DRAG_RESTORE_THRESHOLD
      ) {
        return;
      }
      const bounds = maximizedBounds;
      maximizedBounds = null;
      restoring = true;
      pending = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      const cursorX = screenX;
      const cursorY = screenY;
      // 主进程原子完成「取普通尺寸 → unmaximize → 落位」，避免两次 IPC 之间
      // 闪一帧还原窗；grabOffsetY 保持按下时光标在标题栏内的相对位置
      void invokeMain("win_unmaximize_at", {
        cursorX,
        cursorY,
        grabOffsetY: startScreenY - bounds.y,
      })
        .then((r) => {
          if (ended) return;
          restoring = false;
          if (!r?.ok || !r.value) {
            originReady = false; // 还原失败就结束本次拖拽，不再挪最大化窗口
            return;
          }
          startWinX = Number(r.value.x ?? startWinX);
          startWinY = Number(r.value.y ?? startWinY);
          startScreenX = cursorX;
          startScreenY = cursorY;
          // 还原 IPC 往返期间的光标位移：按最后一次位置补上，松手前也能跟手
          if (lastScreenX !== cursorX || lastScreenY !== cursorY) {
            applyMove(lastScreenX, lastScreenY);
          }
        })
        .catch(() => {
          // IPC 通道异常（窗口销毁等）：别让 restoring 卡死后续拖拽
          if (ended) return;
          restoring = false;
          originReady = false;
        });
      return;
    }
    pending = { x: startWinX + (screenX - startScreenX), y: startWinY + (screenY - startScreenY) };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onMove = (ev: MouseEvent) => {
    lastScreenX = ev.screenX;
    lastScreenY = ev.screenY;
    applyMove(ev.screenX, ev.screenY);
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
  let state: any;
  try {
    state = await invokeMain("win_get_drag_state");
  } catch {
    onUp(); // IPC 异常也要摘监听，否则后续 mousemove 会继续拖窗
    return;
  }
  if (!state?.ok || !state.value || ended) {
    onUp();
    return;
  }
  const v = state.value;
  // 全屏没有标题栏可拖：标准应用同样不响应（也避免把全屏窗口挪出屏幕）
  if (v.fullscreen) {
    onUp();
    return;
  }
  startWinX = Number(v.x ?? 0);
  startWinY = Number(v.y ?? 0);
  if (IS_WIN32 && v.maximized) {
    maximizedBounds = {
      x: Number(v.x ?? 0),
      y: Number(v.y ?? 0),
      width: Number(v.width ?? 0),
      height: Number(v.height ?? 0),
    };
  }
  originReady = true;
  // 起点查询期间光标已经移动：补一次，避免用户停住时要再动一下才跟手
  if (lastScreenX !== startScreenX || lastScreenY !== startScreenY) {
    applyMove(lastScreenX, lastScreenY);
  }
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
