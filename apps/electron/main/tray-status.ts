/**
 * 托盘状态投影（L1c）：把 sidecar 自发帧折成「待处理 / 运行中」两个数，
 * 交给 tray 展示（菜单文案 + macOS 菜单栏数字 + Dock badge）。
 *
 * 帧源与渲染层同一份：inbox_changed.counts.needsAction、
 * automation_fired / automation_run_done。这里只在 main 侧另记一份投影，
 * 不改动既有帧流；窗口关闭后托盘是唯一的状态可见面。
 */
import { applyTrayStatus } from "./tray";

let running = 0;

/** inbox_changed 帧 → 待处理数（requiresAction 且未 snooze） */
export function noteInboxChanged(counts: Record<string, unknown> | undefined): void {
  if (!counts) return;
  const n = Number(counts.needsAction);
  if (!Number.isFinite(n)) return;
  applyTrayStatus({ needsAction: n });
}

/** automation_fired / automation_run_done → 运行中轮数（一次 run 一加一减） */
export function noteAutomationFrame(frame: { type?: unknown }): void {
  if (frame.type === "automation_fired") {
    running += 1;
    applyTrayStatus({ running });
  } else if (frame.type === "automation_run_done") {
    running = Math.max(0, running - 1);
    applyTrayStatus({ running });
  }
}

/** sidecar/调度进程换代：旧轮的 done 帧不会再来，清零避免角标卡在运行中 */
export function resetTrayRunning(): void {
  running = 0;
  applyTrayStatus({ running });
}
