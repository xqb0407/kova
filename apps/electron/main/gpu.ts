/**
 * 硬件加速开关（对齐 gpu.rs）：kv gpu.disabled="1" 关加速。
 * Electron 等价：建窗前读 kv，关闭则 appendSwitch('disable-gpu')——
 * 与 旧桌面壳 相同的时序要求（Chromium 参数只在环境创建时读取）。
 */
import { app } from "electron";
import { kvGet, kvSet, kvDelete } from "./store";

export const DISABLED_KV_KEY = "gpu.disabled";

/** 建窗前调用（store 已 init） */
export function applyGpuFlag(): void {
  if (isAccelerationEnabled()) return;
  if (process.platform === "win32") {
    // WebView2 的 --disable-gpu 在 Electron 对应 GPU 进程禁用
    app.commandLine.appendSwitch("disable-gpu");
    app.disableHardwareAcceleration();
  } else {
    app.disableHardwareAcceleration();
  }
}

function isAccelerationEnabled(): boolean {
  try {
    return kvGet(DISABLED_KV_KEY) !== "1";
  } catch {
    return true;
  }
}

export function setupGpuCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("get_gpu_acceleration", () => isAccelerationEnabled());
  register("set_gpu_acceleration", (a) => {
    const enabled = Boolean(a.enabled);
    if (enabled) kvDelete(DISABLED_KV_KEY);
    else kvSet(DISABLED_KV_KEY, "1");
    return null;
  });
}
