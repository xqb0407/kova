/**
 * 桌面桥 · 文件读写：写/读用户经对话框亲选的绝对路径（file input 同授权语义）。
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
