/// <reference path="./bun-test.d.ts" />
import { describe, expect, mock, test } from "bun:test";

/**
 * 企业微信适配器状态回归：SDK 的 authenticated 事件必须在 connect() 后被
 * 接住并翻成 connected。用假 WSClient 替代真实长连接，避免测试联网/抢真实
 * Bot 的连接。
 */
type Handler = (...args: unknown[]) => void;
const clients: FakeWsClient[] = [];

class FakeWsClient {
  readonly handlers = new Map<string, Handler>();
  constructor(readonly opts: Record<string, unknown>) {
    clients.push(this);
  }
  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }
  connect(): this {
    queueMicrotask(() => this.handlers.get("authenticated")?.());
    return this;
  }
  disconnect(): void {}
  async replyStream(): Promise<unknown> {
    return {};
  }
}

mock.module("@wecom/aibot-node-sdk", () => ({
  WSClient: FakeWsClient,
  generateReqId: (prefix: string) => `${prefix}-test`,
}));

const { WeComAdapter } = await import("../main/im/adapters/wecom/wecom-adapter");
import type { ImChannelStatus } from "../main/im/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WeComAdapter 状态", () => {
  test("authenticated 事件把 connecting 翻成 connected 并上报", async () => {
    const statuses: ImChannelStatus[] = [];
    const adapter = new WeComAdapter("ch-wecom-status");
    try {
      await adapter.start(
        {
          channelId: "ch-wecom-status",
          credentials: { botId: "bot-1", secret: "secret-1" },
          onStatus: (s) => statuses.push(s),
        },
        () => {},
      );
      expect(statuses.map((s) => s.state)).toEqual(["connecting"]);
      await sleep(30);
      expect(adapter.status().state).toBe("connected");
      expect(statuses.map((s) => s.state)).toEqual(["connecting", "connected"]);
      const client = clients.at(-1);
      expect(client?.opts.botId).toBe("bot-1");
      expect(client?.opts.secret).toBe("secret-1");
    } finally {
      await adapter.stop();
    }
  });
});
