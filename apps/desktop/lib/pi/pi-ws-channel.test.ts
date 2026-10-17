import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WsPiChannel } from "./pi-ws-channel";
import type { PiChannelStatus } from "./pi-channel";

/**
 * 远程通道断线语义测试：不依赖真实计时器，用 reconnectNow 立即换链。
 * 覆盖：authed 前 prompt 不丢、未确认 prompt 重连重发、accepted 后不重发、
 * 无连接的管理请求快速失败、状态订阅立即回放。
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

function frames(socket: FakeSocket, type: string): Record<string, unknown>[] {
  return socket.sent
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((frame) => frame.type === type);
}

function prompt(requestId: string) {
  return {
    requestId,
    text: "hello",
    threadId: "sess-1",
    cwd: null,
    attachments: null,
    steer: false,
  };
}

function newChannel() {
  return new WsPiChannel("ws://192.168.1.5:8787/ws", "tok");
}

beforeEach(() => {
  sockets = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = undefined as unknown as typeof WebSocket;
});

describe("WsPiChannel 断线语义", () => {
  test("authed 前发送的 prompt 进 outbox，认证后补发", () => {
    const ch = newChannel();
    const s = sockets[0];
    s.open();
    expect(ch.sendPromptFrame(prompt("p1"))).toBe(true);
    // 认证前不发业务帧（只有 auth）
    expect(frames(s, "prompt")).toHaveLength(0);

    s.emit({ type: "authed", accepted: true });
    expect(frames(s, "prompt").map((f) => f.id)).toEqual(["p1"]);
    ch.close();
  });

  test("未确认的 prompt 在重连 authed 后重发；accepted 后不再重发", () => {
    const ch = newChannel();
    const first = sockets[0];
    first.open();
    first.emit({ type: "authed", accepted: true });
    expect(ch.sendPromptFrame(prompt("p1"))).toBe(true);
    expect(frames(first, "prompt")).toHaveLength(1);

    // 断开时 prompt 还没收到任何同 id 回帧 → 换链后必须重发
    first.die();
    ch.reconnectNow();
    const second = sockets[1];
    second.open();
    second.emit({ type: "authed", accepted: true });
    expect(frames(second, "prompt").map((f) => f.id)).toEqual(["p1"]);

    // 网关投递确认（或任意同 id 流帧）即出账，再断线不重发
    second.emit({ id: "p1", type: "accepted" });
    second.die();
    ch.reconnectNow();
    const third = sockets[2];
    third.open();
    third.emit({ type: "authed", accepted: true });
    expect(frames(third, "prompt")).toHaveLength(0);
    ch.close();
  });

  test("老网关（authed 不带 accepted）不重发已投递的 prompt，避免重复执行", () => {
    const ch = newChannel();
    const first = sockets[0];
    first.open();
    first.emit({ type: "authed" });
    expect(ch.sendPromptFrame(prompt("p1"))).toBe(true);
    expect(frames(first, "prompt")).toHaveLength(1);

    first.die();
    ch.reconnectNow();
    const second = sockets[1];
    second.open();
    second.emit({ type: "authed" });
    expect(frames(second, "prompt")).toHaveLength(0);
    ch.close();
  });

  test("无连接时管理请求立即失败，不空等 15s", async () => {
    const ch = newChannel();
    sockets[0].die();
    await expect(ch.request({ type: "list_running" })).rejects.toThrow("not connected");
    ch.close();
  });

  test("状态订阅立即回放当前状态", () => {
    const ch = newChannel();
    const seen: PiChannelStatus[] = [];
    ch.onStatusChange((s) => seen.push(s));
    expect(seen[0]).toEqual({ connected: false });
    ch.close();
  });
});
