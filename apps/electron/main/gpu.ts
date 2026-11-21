/**
 * 硬件加速开关（对齐 gpu.rs）：kv gpu.disabled="1" 关加速。
 * Electron 等价：建窗前读 kv，关闭则 appendSwitch('disable-gpu')——
 * 与 旧桌面壳 相同的时序要求（Chromium 参数只在环境创建时读取）。
 */
import { app } from "electron";
import { kvGet, kvSet, kvDelete } from "./store";
import { logInfo, logWarn } from "./logging";

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

/**
 * 启动后记录 GPU 特性/设备（ready 之后调用，异步不拖启动）。
 *
 * 为什么值得留这一行：Windows 上一旦 WebGL 落到 software（SwiftShader / 驱动回退），
 * 60fps 3D 页面会在**主进程里**把整个应用冻住几秒再恢复——看起来像"主进程卡死"，
 * 实际是 GPU 进程/驱动在 CPU 上慢慢编译 shader。事后只有这条日志能一眼分清
 * 「驱动回退」和「主进程同步阻塞（[slow-op] 会点名）」；`child-process-gone
 * type=GPU` 则对应 GPU 进程崩溃/TDR 恢复。
 */
export async function logGpuStatus(): Promise<void> {
  try {
    const s = app.getGPUFeatureStatus();
    logInfo(
      `[gpu] acceleration=${isAccelerationEnabled() ? "on" : "off"} ` +
        `gpu_compositing=${s.gpu_compositing ?? "?"} webgl=${s.webgl ?? "?"} ` +
        `webgl2=${s.webgl2 ?? "?"} video_decode=${s.video_decode ?? "?"}`,
    );
  } catch (e: any) {
    logWarn(`[gpu] feature status unavailable: ${e?.message ?? e}`);
  }
  try {
    const info = (await app.getGPUInfo("basic")) as {
      gpuDevice?: Array<Record<string, unknown>>;
    };
    const dev = info?.gpuDevice?.[0] ?? {};
    const str = (k: string) => (typeof dev[k] === "string" ? String(dev[k]).slice(0, 120) : "?");
    logInfo(
      `[gpu] device vendor=${String(dev.vendorId ?? "?")} device=${String(dev.deviceId ?? "?")} ` +
        `vendorString=${str("vendorString")} driverVendor=${str("driverVendor")}`,
    );
  } catch (e: any) {
    logWarn(`[gpu] device info unavailable: ${e?.message ?? e}`);
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
