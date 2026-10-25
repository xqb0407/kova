import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resetCapabilitiesForTest } from "../../src/agent/assembly";
import { handlers } from "../../src/protocol/handlers/capabilities";

let writeSpy: ReturnType<typeof spyOn> | undefined;
const writes: string[] = [];

function captureStdout(): void {
  writes.length = 0;
  writeSpy = spyOn(process.stdout, "write").mockImplementation(
    ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never,
  );
}

afterEach(() => {
  writeSpy?.mockRestore();
  writeSpy = undefined;
  resetCapabilitiesForTest();
});

describe("capabilities 协议 handler", () => {
  test("get_capabilities 返回诊断帧", async () => {
    captureStdout();
    await handlers.get_capabilities("req-cap-1", {});
    const frame = JSON.parse(writes[0] ?? "{}");
    expect(frame).toMatchObject({
      id: "req-cap-1",
      type: "capabilities",
      lifecycle: "new",
    });
    expect(Array.isArray(frame.items)).toBe(true);
    expect(Array.isArray(frame.failures)).toBe(true);
  });

  test("set_capabilities 全量应用并回帧", async () => {
    captureStdout();
    await handlers.set_capabilities("req-cap-2", {
      settings: { enabled: {}, params: {} },
    });
    const frame = JSON.parse(writes[0] ?? "{}");
    expect(frame).toMatchObject({ id: "req-cap-2", type: "capabilities" });
    expect(frame.settings).toEqual({ enabled: {}, params: {} });
  });

  test("set_capabilities 缺少 settings 时报参数错误", async () => {
    await expect(
      handlers.set_capabilities("req-cap-3", {}),
    ).rejects.toThrow(/settings is required/);
  });
});
