/**
 * Electron 宿主通道（渲染层内部模块，业务代码经 desktop-bridge/* 间接使用）。
 * preload 以 contextBridge 暴露 window.kovaHost；本文件收口订阅与分发：
 * - invoke：请求-响应；错误 reject 原始值（沿用旧桌面壳 `throw Err(String)` 的形状，
 *   业务侧 `String(e)` 取到的就是宿主错误字符串本身）。
 * - 事件/通道：主进程把所有事件广播过来，渲染层按事件名/通道 id 本地分发，
 *   因此 unlisten 是纯本地操作（规避 contextBridge 不能返回函数的限制）。
 */

export type InvokeResult = { ok: boolean; value?: unknown; error?: string };

type HostShape = {
  invoke(cmd: string, args: unknown): Promise<InvokeResult>;
  eventsOn(cb: (m: { event: string; payload: unknown }) => void): void;
  channelsOn(cb: (m: { id: string; data: unknown }) => void): void;
};

declare global {
  interface Window {
    kovaHost: HostShape;
    /** preload 注入的桌面标记（前端 isDesktop() 检测它；远程网页端没有） */
    __KOVA_DESKTOP__?: unknown;
  }
}

const host = (): HostShape => {
  if (typeof window === "undefined" || !window.kovaHost) {
    throw new Error("kovaHost missing: not running inside Kova Electron shell");
  }
  return window.kovaHost;
};

/* ---------------- 事件分发 ---------------- */

type EventMsg = { event: string; payload: unknown };
type EventHandler = (m: EventMsg) => void;

const eventHandlers = new Map<string, Set<EventHandler>>();
let eventsPumped = false;

export function addEvent(name: string, h: EventHandler): () => void {
  if (!eventsPumped) {
    eventsPumped = true;
    host().eventsOn((m) => {
      eventHandlers.get(m.event)?.forEach((fn) => fn(m));
    });
  }
  let set = eventHandlers.get(name);
  if (!set) eventHandlers.set(name, (set = new Set()));
  set.add(h);
  return () => {
    set!.delete(h);
  };
}

/* ---------------- Channel 分发（pty on_data 等） ---------------- */

type ChannelHandler = (data: unknown) => void;
const channelHandlers = new Map<string, ChannelHandler>();
let channelsPumped = false;

export function newChannelId(): string {
  return "ch-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function registerChannel(id: string, h: ChannelHandler): void {
  if (!channelsPumped) {
    channelsPumped = true;
    host().channelsOn((m) => {
      channelHandlers.get(m.id)?.(m.data);
    });
  }
  channelHandlers.set(id, h);
}

export function unregisterChannel(id: string): void {
  channelHandlers.delete(id);
}

/* ---------------- invoke（含 Channel 参数序列化） ---------------- */

function serializeArgs(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  if (v instanceof ChannelBase) return { __ch__: v.__channelId };
  if (Array.isArray(v)) return v.map(serializeArgs);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = serializeArgs(val);
  return out;
}

/** Channel 基类（core.ts 对外再导出）：主进程按 id 回推数据到 onmessage。 */
export class ChannelBase<T = unknown> {
  readonly __channelId = newChannelId();
  onmessage?: (data: T) => void;
  constructor() {
    registerChannel(this.__channelId, (d) => this.onmessage?.(d as T));
  }
}

export async function invokeBridge<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const res = await host().invoke(cmd, serializeArgs(args ?? {}));
  if (res.ok) return res.value as T;
  return Promise.reject(res.error ?? new Error(`command failed: ${cmd}`));
}
