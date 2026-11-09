/**
 * 本地工具宿主入口：ACP 模式在 initStorage 之后安装，退出时清理。
 *
 * 与桌面端的分工：桌面端由 Electron 主进程回答 host_query 的 tool kind；
 * ACP 模式没有 Electron，改由本进程的 src/local-host/tool-exec.ts 执行。
 */
import { randomUUID } from "node:crypto";
import { setLocalToolHandler } from "../storage/hostdb/local";
import {
  cancelTool,
  disposeLocalHost as disposeToolExec,
  handleTool,
} from "./tool-exec";

export { handleTool, cancelAllTools, cancelToolsByOwner } from "./tool-exec";

let installed = false;

/** 安装本地工具执行器（幂等） */
export function installLocalHost(): void {
  if (installed) return;
  installed = true;
  setLocalToolHandler(async (params, opts) => {
    // hostToolCall 的信封：{ name, cwd, owner, params, sandbox }。
    // opts.signal / opts.timeoutMs 来自 hostdb transport；bash/http 自己还有
    // 工具级超时，这里按本次工具 id 兜底取消前台进程树。
    const toolId = randomUUID();
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }
    const toolAbort = new AbortController();
    const onAbort = () => {
      // 精确取消本次工具；不按 owner 扫射，避免同线程并行工具被连坐。
      // 同时 abort 本工具的派生 signal，HTTP 这类没有 pid 的路径也能中断。
      cancelTool(toolId);
      toolAbort.abort();
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(onAbort, opts.timeoutMs);
      timer.unref?.();
    }
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await handleTool(toolId, params, toolAbort.signal);
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  });
}

/** 退出清理：结束前台/后台进程；允许之后重新安装（测试/热重启） */
export function disposeLocalHost(): void {
  disposeToolExec();
  setLocalToolHandler(null);
  installed = false;
}
