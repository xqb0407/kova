import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initHostTransport, resetStorageForTest, resolveHostResult } from "../../src/storage/hostdb";
import { buildScreenshotTool } from "../../src/tools/screenshot-tool";
import { projectToolResult } from "../../src/tools/image-parts";
import {
  resetBrowserConfigForTest,
  setBrowserConfigForTest,
} from "../../src/tools/browser-config";

/**
 * host 模式 fake transport：execute → hostScreenshotCall 写 host_query 行，
 * 测试手动 resolveHostResult 回 screenshot 数据；与 hostdb.test.ts 同款。
 */
describe("screenshot tool (host RPC)", () => {
  const captured: string[] = [];
  let origWrite: typeof process.stdout.write;

  beforeAll(() => {
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      captured.push(String(c));
      return true;
    };
    initHostTransport();
    // screenShot 默认关（读用户真实屏幕是唯一越界的能力），这组测的是 RPC
    // 链路不是门控，所以显式开；门控本身在下面那条测试里钉
    setBrowserConfigForTest({ enabled: true, pixelShot: false, screenShot: true });
  });

  afterAll(() => {
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
      origWrite as unknown as (c: unknown) => boolean;
    resetStorageForTest();
    resetBrowserConfigForTest();
  });

  const shotData = {
    base64: "aGVsbG8=", // "hello"
    mimeType: "image/jpeg",
    bytes: 5,
    width: 1920,
    height: 1200,
  };

  // 默认关是硬要求："应用自己操作自己、不动用户的电脑"。这条一旦被改回
  // 默认开，agent 就能在用户不知情时看到整块桌面
  test("默认关闭时婉拒，且提示改用 browser_shot 而不是重试", async () => {
    setBrowserConfigForTest({ screenShot: false });
    captured.length = 0;
    const res = await buildScreenshotTool("/tmp").execute("call-gate", {}, undefined);
    const text = res.content[0].type === "text" ? res.content[0].text : "";
    expect(text).toContain("disabled");
    expect(text).toContain("Do not retry");
    expect(text).toContain("browser_shot");
    expect(captured.join("")).not.toContain("host_query");
    setBrowserConfigForTest({ screenShot: true });
  });

  test("execute sends host tool query named screenshot", async () => {
    captured.length = 0;
    const tool = buildScreenshotTool("/tmp");
    const promise = tool.execute("call-1", { maxDim: 1600 });

    await new Promise((r) => setTimeout(r, 5));
    expect(captured.length).toBe(1);
    const sent = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(sent.type).toBe("host_query");
    expect(sent.kind).toBe("tool");
    const p = sent.params as Record<string, unknown>;
    expect(p.name).toBe("screenshot");
    expect(p.cwd).toBe("/tmp");
    expect(p.params).toEqual({ maxDim: 1600 });

    resolveHostResult({ type: "host_result", id: sent.id, ok: true, data: shotData });
    const result = await promise;
    expect(result.content[0]).toEqual({
      type: "text",
      text: "屏幕截图（1920×1200, JPEG 1 KB）",
    });
    expect(result.content[1]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/jpeg",
    });
    expect(result.details).toEqual({ bytes: 5, width: 1920, height: 1200 });
  });

  test("tool result projects into a data-image part (pipeline seam)", async () => {
    captured.length = 0;
    const tool = buildScreenshotTool("/tmp");
    const promise = tool.execute("call-2", {});
    await new Promise((r) => setTimeout(r, 5));
    const sent = JSON.parse(captured[0]) as Record<string, unknown>;
    resolveHostResult({ type: "host_result", id: sent.id, ok: true, data: shotData });
    const result = await promise;

    // 工具结果直接喂投影：应产出 image 块（bytes=Math.floor(8*3/4)=6 ≤ 2MiB）
    const { output, images } = projectToolResult(
      result.content as Parameters<typeof projectToolResult>[0],
      { toolCallId: "call-2", toolName: "screenshot" },
    );
    expect(images.length).toBe(1);
    expect(images[0].id).toBe("img-call-2-0");
    expect(images[0].data.mimeType).toBe("image/jpeg");
    expect(images[0].data.src).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(images[0].data.alt).toContain("屏幕截图");
    expect(output).toContain("屏幕截图");
  });

  test("host error rejects the tool call", async () => {
    captured.length = 0;
    const tool = buildScreenshotTool("/tmp");
    const promise = tool.execute("call-3", {});
    await new Promise((r) => setTimeout(r, 5));
    const sent = JSON.parse(captured[0]) as Record<string, unknown>;
    resolveHostResult({
      type: "host_result",
      id: sent.id,
      ok: false,
      error: "screenshot is only supported on macOS in this build",
    });
    await expect(promise).rejects.toThrow("only supported on macOS");
  });

  test("missing dims degrade the text note without breaking the image", async () => {
    captured.length = 0;
    const tool = buildScreenshotTool("/tmp");
    const promise = tool.execute("call-4", {});
    await new Promise((r) => setTimeout(r, 5));
    const sent = JSON.parse(captured[0]) as Record<string, unknown>;
    resolveHostResult({
      type: "host_result",
      id: sent.id,
      ok: true,
      data: { ...shotData, width: 0, height: 0 },
    });
    const result = await promise;
    expect(result.content[0]).toEqual({ type: "text", text: "屏幕截图（JPEG 1 KB）" });
    // image 块不依赖尺寸，照常返回
    expect((result.content[1] as { type: string }).type).toBe("image");
  });
});
