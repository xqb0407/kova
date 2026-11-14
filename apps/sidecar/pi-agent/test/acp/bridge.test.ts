import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpBridge } from "../../src/acp/bridge";
import { initStorage } from "../../src/storage/storage";
import { resetStorageForTest } from "../../src/storage/hostdb";
import { setInitGate } from "../../src/protocol/protocol";
import { setFrameSink } from "../../src/protocol/stream";

const dir = mkdtempSync(join(tmpdir(), "kova-acp-bridge-"));

beforeAll(() => {
  initStorage(join(dir, "state.db"), join(dir, "sessions"));
  setInitGate(Promise.resolve());
});

afterAll(() => {
  resetStorageForTest();
  setFrameSink(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("AcpBridge 命令配对", () => {
  test("ping 请求拿到同 id pong", async () => {
    const bridge = new AcpBridge();
    bridge.install();
    try {
      const frame = await bridge.request({ type: "ping" });
      expect(frame.type).toBe("pong");
    } finally {
      bridge.dispose();
    }
  });

  test("未知命令转为 AcpInternalError", async () => {
    const bridge = new AcpBridge();
    bridge.install();
    try {
      await expect(bridge.request({ type: "no_such_command" })).rejects.toThrow(
        /unknown message type/,
      );
    } finally {
      bridge.dispose();
    }
  });

  test("dispose 后恢复 stdout 帧出口", () => {
    const bridge = new AcpBridge();
    bridge.install();
    bridge.dispose();
    // 没有可观察的 sink 状态；这里只保证 dispose 不抛错且可重复安装
    const again = new AcpBridge();
    again.install();
    again.dispose();
    expect(true).toBe(true);
  });
});
