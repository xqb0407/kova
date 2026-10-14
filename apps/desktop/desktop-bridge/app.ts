/** 桌面桥 · 应用信息：getVersion/getName（主进程 app 元信息）。 */
import { invokeBridge } from "./_host";

export async function getVersion(): Promise<string> {
  return invokeBridge<string>("bridge_app_version");
}

export async function getName(): Promise<string> {
  return invokeBridge<string>("bridge_app_name");
}

export async function getAppWindow(): Promise<{ width: number; height: number }> {
  return invokeBridge("bridge_app_window_size");
}

/** 运行时版本（关于页"Electron 版本"行）：主进程读 process.versions.electron */
export async function getRuntimeVersion(): Promise<string> {
  return invokeBridge<string>("bridge_runtime_version");
}
