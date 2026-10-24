import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("sidecar 换代广播只投递给订阅者，退订后不再投递", () => {
    const ch = newChannel();
    const s = sockets[0];
    s.open();
    s.emit({ type: "authed" });

    const hits: number[] = [];
    const off = ch.subscribeSidecarRestart(() => hits.push(1));
    s.emit({ type: "pi_restarted" });
    expect(hits).toHaveLength(1);

    // 无关自发帧不误触
    s.emit({ type: "sessions_changed", op: "updated", sessionId: "x" });
    expect(hits).toHaveLength(1);

    off();
    s.emit({ type: "pi_restarted" });
    expect(hits).toHaveLength(1);
    ch.close();
  });

  test("换代广播在未订阅/未连接时无害", () => {
    const ch = newChannel();
    const s = sockets[0];
    // 未 open、未 authed：网关不会下发，即便下发也不能炸
    s.emit({ type: "pi_restarted" });
    s.open();
    s.emit({ type: "authed" });
    s.emit({ type: "pi_restarted" });
    ch.close();
  });
});

describe("跨进程契约：网关白名单 ↔ 通道分发能力", () => {
  test("remote.ts 的 BROADCAST_TYPES 放行 pi_restarted", () => {
    // 这条是远程端换代对账的命门：白名单一旦漏掉，通道分支永远收不到帧，
    // 而两侧各自的单测都不会红（通道桩直接 emit，白名单无人消费）。源码钉住。
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "..", "electron", "main", "remote.ts"),
      "utf8",
    );
    const block = /BROADCAST_TYPES[\s\S]*?\]\);/.exec(src);
    expect(block, "remote.ts 的 BROADCAST_TYPES 结构变化，同步本测试").not.toBeNull();
    expect(block![0]).toContain('"pi_restarted"');
  });
});
