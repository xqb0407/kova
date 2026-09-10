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

/** 序列化 console 参数为单行文本（对象安全 stringify，超长截断） */
function formatArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    if (typeof arg === "string") return arg;
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
