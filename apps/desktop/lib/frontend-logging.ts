/**
 * 前端日志落盘转发：桌面端把 console.warn/error 与全局崩溃
 * 旁路到 Rust 的 frontend_log 命令（写 <app_log_dir>/<日期>/web.log）。
 * - 仅桌面端生效；浏览器 dev / 远程网页端保持原生 console 行为
 * - 原有 console 行为不受影响（先原样输出，再旁路转发）
 * - 转发失败静默忽略，绝不再触发 console.error（防递归）
 */
import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";

const MSG_MAX = 8000;
let installed = false;

/** 序列化 console 参数为单行文本（对象安全 stringify，超长截断）。
 *  Error 特判：Error 的可枚举属性为空，直接 JSON.stringify 只剩 "{}"，
 *  排查订阅者抛错这类问题等于没日志——这里展开 name/message/stack。 */
function formatArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) {
      // slice 上限放宽：React 的"Maximum update depth"类错误把组件归因帧
      //（at XxxComponent）挂在 React 内部帧之后，只留 3 帧等于把唯一线索切掉
      const stack = arg.stack ? ` @ ${arg.stack.split("\n").slice(1, 24).join(" <- ").trim()}` : "";
      // AggregateError（store 广播多订阅者抛错的聚合形态）内层展开，否则又只剩空壳
      const inner =
        arg instanceof AggregateError && Array.isArray(arg.errors)
          ? ` [${arg.errors.map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))).join(" | ")}]`
          : "";
      return `${arg.name}: ${arg.message}${inner}${stack}`;
    }
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  let text = parts.join(" ");
  if (text.length > MSG_MAX) {
    text = `${text.slice(0, MSG_MAX)}…`;
  }
  return text;
}

function send(level: "info" | "warn" | "error", message: string) {
  invoke("frontend_log", { level, message }).catch(() => {});
}

/**
 * 显式上报一条错误。
 *
 * 有错误边界后，渲染期抛出的错误被 React 接在边界里就不再冒泡到 window，
 * installFrontendLogging 装的 error 监听收不到它（unhandledrejection 和事件
 * 回调里的错误不受影响）。边界在 componentDidCatch 里走这里补上落盘。
 */
export function reportFrontendError(message: string): void {
  if (!isDesktop()) {
    console.error(message);
    return;
  }
  send("error", message);
}

/** 显式上报一条非致命的告警（卡顿、资源加载失败等），同样不依赖 window 监听 */
export function reportFrontendWarning(message: string): void {
  if (!isDesktop()) {
    console.warn(message);
    return;
  }
  send("warn", message);
}

/**
 * webview 管道噪声：Electron <webview> 的元素与 GUEST_VIEW_MANAGER_CALL
 * 通道跑在主渲染器里，导航被后续导航顶掉时该通道以 ERR_ABORTED 拒绝。
 * 两条冒出处都要认：unhandledrejection 拒绝，与 Chromium 内部经
 * console.error 中继的「Unexpected error while loading URL」。后者还有个
 * 不带 ERR_ABORTED 字样的变体（只有 "Error: (-3) loading"，Windows 实测）。
 * 页面本身是隔离的、这不是应用缺陷，折叠成 warn 落日志即可。
 *
 * console.error 中继这一路必须**在调用原 console.error 之前**分流：Next dev
 * 浮层是在 console.error 上挂钩的，照旧原样输出会让每次开预览/切浏览器标签
 * 都弹一张 "Console Error" 卡（reason 里带 file:// 的加载最常见）。
 *
 * unhandledrejection 的拦截主力在 app/layout.tsx 的 head 内联
 * WEBVIEW_ABORT_GUARD（先于 Next dev 浮层注册 + stopImmediatePropagation，
 * 浮层弹不出来；本模块在 useEffect 期才装，preventDefault 只能压控制台
 * 裸错，这里保留作兜底）。签名口径两处必须同步。
 */
function isWebviewAbortNoise(text: string): boolean {
  if (!text.includes("GUEST_VIEW_MANAGER_CALL")) return false;
  return text.includes("ERR_ABORTED") || text.includes("(-3)");
}

export function installFrontendLogging(): void {
  if (installed || !isDesktop()) return;
  installed = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    send("warn", formatArgs(args));
  };
  console.error = (...args: unknown[]) => {
    const text = formatArgs(args);
    // 同签名噪声经 console.error 中继（Electron webview 内部按 error 输出）：
    // 不交给原 console.error，dev 浮层就不会把它当成应用错误弹卡；控制台仍留
    // 一条 warn 备查，落日志同样按 warn 记，web.log 不再被刷屏 ERROR
    if (isWebviewAbortNoise(text)) {
      origWarn(`webview 管道噪声（导航被顶掉，已折叠）: ${text}`);
      send("warn", `webview 管道噪声（导航被顶掉，已折叠）: ${text}`);
      return;
    }
    origError(...args);
    send("error", text);
  };

  let resizeObserverNoiseLogged = false;
  window.addEventListener("error", (event) => {
    // ResizeObserver 的循环通知是浏览器规范行为：回调里改了布局导致同一帧
    // 再次 resize，浏览器已截断循环，不是应用异常。默认会刷 ERROR 并触发
    // Next dev 浮层；这里折叠掉，仅每个会话留一条 warn 备查。
    if (event.message?.includes("ResizeObserver loop")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!resizeObserverNoiseLogged) {
        resizeObserverNoiseLogged = true;
        send("warn", "ResizeObserver 布局循环（浏览器已截断，后续同类不再记录）");
      }
      return;
    }
    send(
      "error",
      `uncaught: ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    const text = String(event.reason);
    // 已知的宿主机制噪声：见 isWebviewAbortNoise。窄匹配后 preventDefault()：
    // 阻断默认的控制台输出（浮层因此看不到），仍以 warn 记进 web.log 备查；
    // 其余任何 rejection 一律照旧裸露、照旧按 error 上报。
    if (isWebviewAbortNoise(text)) {
      event.preventDefault();
      send("warn", `webview 管道噪声（导航被顶掉，已折叠）: ${text}`);
      return;
    }
    send("error", `unhandledrejection: ${text}`);
  });
}
