/**
 * 内置浏览器 guest 的隔离 preload（对齐 X embeddedBrowserJavaScriptDialog）：
 * 网页调用 alert/confirm 之前先同步询问主进程，由宿主用系统 MessageBox 展示
 * 「<host> says」来源；agent 自动化期间主进程返回 handled:false，回落到 Chromium
 * 原生 Dialog，让 CDP 的 Page.javascriptDialogOpening / handleJavaScriptDialog 接管。
 *
 * 只暴露一个 alert/confirm 同步桥，不暴露 Node/IPC/文件能力。prompt() 不接管
 * （系统 MessageBox 没有同步文本输入，会破坏 prompt 的同步返回语义）。
 *
 * 另有一条**本地预览兼容规则**：file:// 页面默认隐藏 WebGPU（见下方注释）。
 */
import { contextBridge, ipcRenderer } from "electron";

const BRIDGE_KEY = "__kovaBrowserDialog__";
const CHANNEL = "kova:browser-dialog";

/**
 * file:// 本地预览（AI 生成的三维页占绝大多数）默认隐藏 WebGPU。
 *
 * 2026-11 实测：WebGPURenderer 遇到 WebGL 时代的材质（ShaderMaterial /
 * MeshStandardMaterial，RoomEnvironment 也在用）会持续报
 * `NodeMaterial: Material "ShaderMaterial" is not compatible`；对应的 pipeline
 * 创建/校验把共享 GPU 进程按住数秒，宿主窗口合成器一起不出帧——日志表现为
 * `[卡顿] 渲染帧冻结（主线程未漂移） 3892ms`，看起来像整个应用卡死。
 * 页面自己的 WebGL2 回退对这些材质是有效的，帧也只冻在页面内。
 *
 * 确实需要 WebGPU 的本地页面：URL 加 `?webgpu=1` 显式恢复（远端页面不受影响）。
 * 隐藏方式必须是 **delete Navigator.prototype.gpu**：页面用 `'gpu' in navigator`
 * 探测，仅把 getter 改成 undefined 会让 `in` 仍为 true，回退不会触发。
 */
function shouldHideWebGpu(): boolean {
  try {
    return (
      location.protocol === "file:" &&
      !/[?&]webgpu=1(?:&|$)/.test(location.search)
    );
  } catch {
    return false;
  }
}

if (shouldHideWebGpu()) {
  try {
    const result = contextBridge.executeInMainWorld({
      func: () => {
        try {
          delete (Navigator.prototype as { gpu?: unknown }).gpu;
        } catch {
          /* 属性不可删除（极老内核）：保持原样，页面仍可用 WebGPU */
        }
      },
      args: [],
    }) as unknown;
    // 当前 Electron 返回同步结果；若未来改为 Promise，也不能留 unhandled rejection
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    /* 主世界执行不可用：保留 WebGPU，别让 preload 整体失败、连带 dialog bridge 消失 */
  }
}

interface DialogBridgeResult {
  handled: boolean;
  value?: boolean;
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  show(type: "alert" | "confirm", message: string): DialogBridgeResult {
    try {
      const result = ipcRenderer.sendSync(CHANNEL, { type, message }) as unknown;
      if (typeof result !== "object" || result === null) return { handled: false };
      const candidate = result as Partial<DialogBridgeResult>;
      if (candidate.handled !== true) return { handled: false };
      return {
        handled: true,
        ...(typeof candidate.value === "boolean" ? { value: candidate.value } : {}),
      };
    } catch {
      // 主进程不可用：回落到 Chromium 原生 API，不能吞掉网页 Dialog。
      return { handled: false };
    }
  },
});

contextBridge.executeInMainWorld({
  func: (bridgeKey: string) => {
    type Bridge = {
      show: (type: "alert" | "confirm", message: string) => DialogBridgeResult;
    };
    const bridge = (window as unknown as Record<string, Bridge | undefined>)[bridgeKey];
    if (!bridge) return;

    const installedByWindow = new WeakMap<Window, Window["confirm"]>();
    const observedFrames = new WeakSet<HTMLIFrameElement>();

    const installInWindow = (target: Window): void => {
      try {
        if (installedByWindow.get(target) === target.confirm) return;
        const nativeAlert = target.alert.bind(target);
        const nativeConfirm = target.confirm.bind(target);
        target.alert = (message?: unknown): void => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("alert", text);
          if (!result.handled) nativeAlert(text);
        };
        const wrappedConfirm = (message?: string): boolean => {
          const text = message === undefined ? "" : String(message);
          const result = bridge.show("confirm", text);
          return result.handled ? result.value === true : nativeConfirm(text);
        };
        target.confirm = wrappedConfirm;
        installedByWindow.set(target, wrappedConfirm);
      } catch {
        // 跨源 frame 不允许宿主读取 Window；它在真实导航时会自行加载同一 preload。
      }
    };

    const installFrameTree = (target: Window): void => {
      installInWindow(target);
      try {
        const frames = Array.from(target.document.querySelectorAll("iframe"));
        for (const frame of frames) {
          if (!observedFrames.has(frame)) {
            observedFrames.add(frame);
            frame.addEventListener(
              "load",
              () => {
                if (frame.contentWindow) installFrameTree(frame.contentWindow);
              },
              true,
            );
          }
          if (frame.contentWindow) installFrameTree(frame.contentWindow);
        }
      } catch {
        // 跨源文档的 frame tree 由对应 frame 自己的 preload 处理。
      }
    };

    installFrameTree(window);
    const observeFrames = (): void => {
      installFrameTree(window);
      const root = window.document?.documentElement;
      if (!root) return;
      // 无 src 的继承型 about:blank iframe 不发生文档级导航，Electron 不会为它
      // 单独执行 preload；监听页面插入后从同源父 frame 安装同样的包装。
      new window.MutationObserver(() => installFrameTree(window)).observe(root, {
        childList: true,
        subtree: true,
      });
    };
    if (window.document?.documentElement) observeFrames();
    else window.addEventListener?.("DOMContentLoaded", observeFrames, { once: true });
  },
  args: [BRIDGE_KEY],
});
