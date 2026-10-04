import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsPiChannel } from "./pi-ws-channel";
import { setPiChannel } from "./pi-channel";
import { piRequest } from "./pi-bridge";

/**
 * ws 链路的模型目录集成测试：用真实 WsPiChannel + piRequest 走一遍
 * 配对屏之后的「模型选择器取数」路径（list_models → models 应答），
 * 验证 app 端模型胶囊能拿到桌面端目录。FakeSocket 与 pi-ws-channel.test.ts
 * 同款：只模拟浏览器/RN 的 WebSocket 行为，不碰网络。
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

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  setPiChannel(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ws 链路 list_models", () => {
  it("auth 后经 piRequest 拉取模型目录，应答按 id 结算", async () => {
    const ch = new WsPiChannel("ws://192.168.1.5:8787/ws", "tok");
    setPiChannel(ch);
    const s = sockets[0];
    s.open();
    s.emit({ type: "authed" });

    const res = piRequest<{
      type: "models";
      models: import("./pi-bridge").PiModelSummary[];
      providers: import("./pi-bridge").PiProviderSummary[];
    }>({ type: "list_models" });

    // 请求帧已发出（authed 后直发），id 由通道注入
    await vi.waitFor(() => expect(s.sent.length).toBe(2));
    const frame = JSON.parse(s.sent[1]) as { type: string; id: string };
    expect(frame.type).toBe("list_models");

    // 网关还原 id 后回 models 应答（这里直接以客户端 id 模拟还原结果）
    const model = (
      provider: string,
      id: string,
      name: string,
    ): import("./pi-bridge").PiModelSummary => ({
      provider,
      providerName: provider,
      id,
      name,
      reasoning: true,
      contextWindow: 200_000,
      authed: true,
    });
    s.emit({
      id: frame.id,
      type: "models",
      models: [
        model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
        model("openai", "gpt-5", "GPT-5"),
      ],
      providers: [{ id: "anthropic", name: "Anthropic", authed: true }],
    });

    const r = await res;
    expect(r.type).toBe("models");
    expect(r.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
    ch.close();
  });

  it("网关回错误帧（如 REMOTE_DENIED）时 piRequest 抛错而非挂死", async () => {
    const ch = new WsPiChannel("ws://192.168.1.5:8787/ws", "tok");
    setPiChannel(ch);
    const s = sockets[0];
    s.open();
    s.emit({ type: "authed" });

    const res = piRequest({ type: "list_credentials" });
    await vi.waitFor(() => expect(s.sent.length).toBe(2));
    const frame = JSON.parse(s.sent[1]) as { id: string };
    s.emit({
      id: frame.id,
      type: "error",
      errorText: "该操作仅限桌面端",
      error: { code: "REMOTE_DENIED", source: "runtime", retryable: false },
    });

    await expect(res).rejects.toThrow("该操作仅限桌面端");
    ch.close();
  });
});
