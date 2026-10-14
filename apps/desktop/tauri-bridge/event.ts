/**
 * `@tauri-apps/api/event` 兼容实现：listen/emit。
 * 事件语义与 Tauri 一致：handler 收到 `{ event, payload }`；
 * listen 返回 Promise<UnlistenFn>（注册完成前的事件不投递——与 Tauri 同契约）。
 */
import { addEvent, invokeBridge } from "./_host";

export type UnlistenFn = () => void;

export interface Event<T = unknown> {
  event: string;
  id: number;
  payload: T;
}

export async function listen<T>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  const off = addEvent(event, (m) => {
    handler({ event: m.event, id: 0, payload: m.payload as T });
  });
  return off;
}

/** JS→全窗口广播（前端当前未用，保留 API 形状；经主进程转发）。 */
export async function emit(event: string, payload?: unknown): Promise<void> {
  await invokeBridge("bridge_emit", { event, payload: payload ?? null });
}

export async function emitTo(
  _target: string,
  event: string,
  payload?: unknown,
): Promise<void> {
  await invokeBridge("bridge_emit", { event, payload: payload ?? null });
}
