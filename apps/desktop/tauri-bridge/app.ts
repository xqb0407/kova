/** `@tauri-apps/api/app` 兼容实现 */
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

/** 兼容占位：前端用它显示 Tauri 版本行，桥环境下给出可诊断值 */
export async function getTauriVersion(): Promise<string> {
  return "2.0-electron-compat";
}
