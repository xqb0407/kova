/**
 * 桌面桥 · 事件：listen/emit 的 Electron 实现（事件经主进程广播，语义同旧桌面壳：
 * handler 收到 `{ event, payload }`，listen 返回 Promise<UnlistenFn>）。
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
