/** `@tauri-apps/api/path` 兼容实现（项目仅用 appDataDir，join 为完备性保留） */
import { invokeBridge } from "./_host";

export async function appDataDir(): Promise<string> {
  return invokeBridge<string>("bridge_app_data_dir");
}

export async function join(...parts: string[]): Promise<string> {
  return invokeBridge<string>("bridge_path_join", { parts });
}

export async function homeDir(): Promise<string> {
  return invokeBridge<string>("bridge_home_dir");
}
