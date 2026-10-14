/**
 * `@tauri-apps/plugin-fs` 兼容实现（项目仅用 writeTextFile 绝对路径写出，
 * 来源为 dialog 用户亲选——与 File input 同等的用户授权语义）。
 */
import { invokeBridge } from "./_host";

export async function writeTextFile(path: string | { path: string }, data: string): Promise<void> {
  const p = typeof path === "string" ? path : path.path;
  await invokeBridge("bridge_fs_write_text", { path: p, content: data });
}

export async function readTextFile(path: string | { path: string }): Promise<string> {
  const p = typeof path === "string" ? path : path.path;
  return invokeBridge<string>("bridge_fs_read_text", { path: p });
}
