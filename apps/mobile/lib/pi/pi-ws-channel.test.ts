import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsPiChannel } from "./pi-ws-channel";
import type { PiChannelStatus } from "./pi-channel";

/**
 * 通道状态机测试：只验远端链路上最容易在真机翻车的四件事——
 * auth 前排队、指数退避与上限、换连接时不误杀新 socket、auth 失败不再重连。
 * 计时器全部走 fake timers，抖动用「每次推进 31s（> 30s 封顶）」吃掉。
 */

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  /** 只置状态，不触发 onclose（与浏览器 close() 的异步性一致，
   *  本测试需要显式控制断开时机，故不模拟自动回调） */
  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  die() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[] = [];
let statuses: PiChannelStatus[] = [];

function newChannel() {
  const ch = new WsPiChannel("ws://192.168.1.5:8787/ws", "tok");
  ch.onStatusChange?.((s) => statuses.push(s));
  return ch;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  statuses = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WsPiChannel", () => {
  it("连接即发 auth，authed 之前的请求排队、之后按序补发", async () => {
    const ch = newChannel();
    const s = sockets[0];
    s.open();
    expect(JSON.parse(s.sent[0])).toEqual({ type: "auth", token: "tok" });

    const res = ch.request({ type: "list_running" });
    expect(s.sent.length).toBe(1); // 未认证不发业务帧，防 unauthorized 竞态

    s.emit({ type: "authed" });
    expect(s.sent.length).toBe(2);
    const frame = JSON.parse(s.sent[1]) as { type: string; id: string };
    expect(frame.type).toBe("list_running");
    expect(typeof frame.id).toBe("string");

    s.emit({ id: frame.id, type: "running", sessionIds: ["a"] });
    const r = await res;
    expect(r.type).toBe("running");
    ch.close();
  });

  it("断线按指数退避重连，连续失败到上限后交回 UI", async () => {
    const ch = newChannel();
    sockets[0].open();
    sockets[0].emit({ type: "authed" });
    sockets[0].die();

    // 首轮 3s、封顶 30s：每轮推进 31s 足够触发；共 8 次重连机会
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(31_000);
      sockets[sockets.length - 1].die();
    }

    expect(sockets.length).toBe(9); // 1 条初始 + 8 条重连
    expect(statuses.at(-1)).toEqual({ connected: false, error: "disconnected" });

    // 回前台：退避清零，立刻再给一次机会（不等下一轮退避）
    ch.reconnectNow();
    expect(sockets.length).toBe(10);
    ch.close();
  });

  it("重连换代时，旧 socket 的迟到 onclose 不误杀新连接", async () => {
    const ch = newChannel();
    const stale = sockets[0]; // 还在 CONNECTING，从未认证成功
    ch.reconnectNow();
    const next = sockets[1];
    expect(next).toBeDefined();

    stale.die(); // 迟到的断开回调：此时 this.ws 已是 next
    expect(sockets.length).toBe(2); // 不应再触发一轮重连
    expect(statuses.some((s) => s.error === "disconnected")).toBe(false);

    next.open();
    next.emit({ type: "authed" });
    const res = ch.request({ type: "get_app_mode" });
    const frame = JSON.parse(next.sent[1]) as { id: string };
    next.emit({ id: frame.id, type: "app_mode", mode: "work" });
    const r = await res;
    expect(r.type).toBe("app_mode");
    ch.close();
  });

  it("auth 明确失败视为终态：关闭连接且不再重连", async () => {
    const ch = newChannel();
    const s = sockets[0];
    s.open();
    s.emit({ type: "error", errorText: "invalid token" });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(1);
    expect(statuses.at(-1)).toEqual({ connected: false, error: "invalid token" });
    ch.close();
  });

  it("心跳 ping 无 pong 判半开：杀链重连，不等系统 onclose", async () => {
    const ch = newChannel();
    const s = sockets[0];
    s.open();
    s.emit({ type: "authed" });

    // 推进到一轮心跳：ping 已发出（auth 帧 + ping 帧）
    await vi.advanceTimersByTimeAsync(26_000);
    const ping = JSON.parse(s.sent.at(-1) ?? "{}") as { type: string; id: string };
    expect(ping.type).toBe("ping");

    // pong 不回 → ping 超时（8s）→ 半开判定：socket 被关、手动驱动重连
    await vi.advanceTimersByTimeAsync(8_500);
    expect(s.readyState).toBe(FakeSocket.CLOSED);

    // 退避重连照常起新链
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sockets.length).toBe(2);
    ch.close();
  });

  it("心跳 ping 得到 pong 则连接保留", async () => {
    const ch = newChannel();
    const s = sockets[0];
    s.open();
    s.emit({ type: "authed" });

    await vi.advanceTimersByTimeAsync(26_000);
    const ping = JSON.parse(s.sent.at(-1) ?? "{}") as { id: string };
    s.emit({ id: ping.id, type: "pong" });

    await vi.advanceTimersByTimeAsync(30_000); // 越过 ping 超时窗
    expect(s.readyState).not.toBe(FakeSocket.CLOSED);
    expect(sockets.length).toBe(1);
    ch.close();
  });
});
