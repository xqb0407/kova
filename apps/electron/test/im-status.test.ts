import { describe, expect, test } from "bun:test";
import { effectiveChannelStatus } from "../main/im/status";

describe("effectiveChannelStatus", () => {
  test("未启动通道一律 unbound", () => {
    expect(
      effectiveChannelStatus({
        running: false,
        bound: true,
        adapterState: { state: "connected" },
        inboundActive: true,
      }),
    ).toEqual({ state: "unbound" });
  });

  test("已绑定但适配器还没连上：connecting（不显示未连接）", () => {
    expect(
      effectiveChannelStatus({
        running: true,
        bound: true,
        adapterState: { state: "unbound" },
        inboundActive: false,
      }),
    ).toEqual({ state: "connecting" });
  });

  test("收到过入站消息可把 connecting 纠偏为 connected", () => {
    expect(
      effectiveChannelStatus({
        running: true,
        bound: true,
        adapterState: { state: "connecting" },
        inboundActive: true,
      }),
    ).toEqual({ state: "connected" });
    expect(
      effectiveChannelStatus({
        running: true,
        bound: true,
        adapterState: { state: "unbound" },
        inboundActive: true,
      }),
    ).toEqual({ state: "connected" });
  });

  test("断线/错误/重新认证优先于入站兜底", () => {
    expect(
      effectiveChannelStatus({
        running: true,
        bound: true,
        adapterState: { state: "error", message: "boom" },
        inboundActive: true,
      }),
    ).toEqual({ state: "error", message: "boom" });
    expect(
      effectiveChannelStatus({
        running: true,
        bound: true,
        adapterState: { state: "reauth" },
        inboundActive: true,
      }),
    ).toEqual({ state: "reauth" });
  });

  test("已解绑的入站活跃标记不产生 connected", () => {
    expect(
      effectiveChannelStatus({
        running: true,
        bound: false,
        adapterState: { state: "unbound" },
        inboundActive: true,
      }),
    ).toEqual({ state: "unbound" });
  });
});
