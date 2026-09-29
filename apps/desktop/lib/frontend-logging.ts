/**
 * 前端日志落盘转发：Tauri 桌面端把 console.warn/error 与全局崩溃
 * 旁路到 Rust 的 frontend_log 命令（写 <app_log_dir>/<日期>/web.log）。
 * - 仅桌面端生效；浏览器 dev / 远程网页端保持原生 console 行为
 * - 原有 console 行为不受影响（先原样输出，再旁路转发）
 * - 转发失败静默忽略，绝不再触发 console.error（防递归）
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

const MSG_MAX = 8000;
let installed = false;

/** 序列化 console 参数为单行文本（对象安全 stringify，超长截断）。
 *  Error 特判：Error 的可枚举属性为空，直接 JSON.stringify 只剩 "{}"，
 *  排查订阅者抛错这类问题等于没日志——这里展开 name/message/stack。 */
function formatArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) {
      const stack = arg.stack ? ` @ ${arg.stack.split("\n").slice(1, 4).join(" <- ").trim()}` : "";
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
  if (!isTauri()) {
    console.error(message);
    return;
  }
  send("error", message);
}

/** 显式上报一条非致命的告警（卡顿、资源加载失败等），同样不依赖 window 监听 */
export function reportFrontendWarning(message: string): void {
  if (!isTauri()) {
    console.warn(message);
    return;
  }
  send("warn", message);
}

export function installFrontendLogging(): void {
  if (installed || !isTauri()) return;
  installed = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    send("warn", formatArgs(args));
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    send("error", formatArgs(args));
  };

  window.addEventListener("error", (event) => {
    send(
      "error",
      `uncaught: ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("error", `unhandledrejection: ${String(event.reason)}`);
  });
}
