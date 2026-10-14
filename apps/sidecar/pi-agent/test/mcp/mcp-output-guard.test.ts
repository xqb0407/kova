import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  boundMcpResult,
  formatMcpContent,
  guardMcpText,
  splitMcpContent,
  MCP_DETAILS_MAX_BYTES,
  MCP_OUTPUT_MAX_BYTES,
  MCP_OUTPUT_MAX_LINES,
  spillToTempFile,
  type McpCallResult,
} from "../../src/mcp/mcp-output-guard";

afterAll(() => {
  // 清掉本轮测试在系统临时目录留下的溢写目录
  try {
    for (const name of readdirSync(tmpdir())) {
      if (name.startsWith("kova-mcp-output-")) {
        rmSync(path.join(tmpdir(), name), { recursive: true, force: true });
      }
    }
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

describe("guardMcpText", () => {
  test("短文本原样返回不截断", () => {
    const g = guardMcpText("hello world");
    expect(g.truncated).toBe(false);
    expect(g.text).toBe("hello world");
    expect(g.fullOutputPath).toBeUndefined();
  });

  test("超行数截断 + 溢写文件存在且完整", () => {
    // 短行：只超行数（1100 行 × ~5B ≈ 6KB < 8KB 字节预算）
    const lines = Array.from({ length: MCP_OUTPUT_MAX_LINES + 100 }, (_, i) => `l${i}`);
    const g = guardMcpText(lines.join("\n"));
    expect(g.truncated).toBe(true);
    expect(g.fullOutputPath).toBeTruthy();
    expect(existsSync(g.fullOutputPath!)).toBe(true);
    // 溢写文件是完整原文
    expect(readFileSync(g.fullOutputPath!, "utf8")).toBe(lines.join("\n"));
    // 返回文本带截断通知
    expect(g.text).toContain("MCP 输出已截断");
    expect(g.text).toContain("l999");
    expect(g.text).not.toContain(`l${MCP_OUTPUT_MAX_LINES + 50}`);
  });

  test("超字节数截断（少行大块）", () => {
    const blob = "x".repeat(MCP_OUTPUT_MAX_BYTES + 5000);
    const g = guardMcpText(blob);
    expect(g.truncated).toBe(true);
    expect(Buffer.byteLength(g.text, "utf8")).toBeLessThanOrEqual(MCP_OUTPUT_MAX_BYTES + 300);
    expect(readFileSync(g.fullOutputPath!, "utf8")).toBe(blob);
  });

  test("多字节字符不会被劈开半截", () => {
    const blob = "汉".repeat(6000); // 18KB
    const g = guardMcpText(blob);
    expect(g.truncated).toBe(true);
    // 通知前正文全部由完整字符构成
    const body = g.text.split("\n[MCP 输出已截断")[0];
    expect(body.length * 3).toBeLessThanOrEqual(Buffer.byteLength(body, "utf8"));
  });
});

describe("formatMcpContent", () => {
  test("text 块拼接；合法图摘走、坏图与非图块占位", () => {
    const out = formatMcpContent([
      { type: "text", text: "part1" },
      { type: "image", mimeType: "image/png", data: "a".repeat(64) }, // 合法 → 摘出，不留字节
      { type: "image", mimeType: "image/png" }, // 坏（无 data）→ 占位
      { type: "text", text: "part2" },
      { type: "resource", uri: "file:///x.bin", mimeType: "application/octet-stream" },
    ]);
    expect(out).toContain("part1");
    expect(out).toContain("part2");
    expect(out).toContain("image 块 · image/png"); // 只剩坏图这一条占位
    expect(out.match(/image 块/g)).toHaveLength(1);
    expect(out).toContain("resource file:///x.bin");
    expect(out).not.toContain("aaaa");
  });

  test("字符串快捷路径", () => {
    expect(formatMcpContent("plain")).toBe("plain");
  });
});

describe("splitMcpContent", () => {
  test("合法 image 摘成 images，字节不进文本通道", () => {
    const { text, images } = splitMcpContent([
      { type: "text", text: "截图如下" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "image", mimeType: "image/jpeg", data: "x".repeat(40) },
    ]);
    expect(text).toContain("截图如下");
    expect(text).not.toContain("aGVsbG8=");
    expect(images).toEqual([
      { data: "aGVsbG8=", mimeType: "image/png" },
      { data: "x".repeat(40), mimeType: "image/jpeg" },
    ]);
  });

  test("坏 image 块降级为文本占位：无 data / data 非字符串 / 缺 mimeType", () => {
    const { text, images } = splitMcpContent([
      { type: "image", mimeType: "image/png" },
      { type: "image", data: 123, mimeType: "image/png" },
      { type: "image", data: "aaaa" },
    ]);
    expect(images).toEqual([]);
    expect(text.match(/image 块/g)).toHaveLength(3);
    expect(text).not.toContain("aaaa");
  });

  test("audio/resource 走占位不摘图；字符串快捷路径无图", () => {
    expect(splitMcpContent([{ type: "audio", mimeType: "audio/mp3", data: "ZZ".repeat(20) }]).images).toEqual([]);
    const str = splitMcpContent("hello");
    expect(str).toEqual({ text: "hello", images: [] });
  });

  test("文本部分照旧过截断护栏（图字节不计入）", () => {
    const big = "汉".repeat(6000); // 18KB > 8KB 上限
    const { text, images } = splitMcpContent([
      { type: "text", text: big },
      { type: "image", mimeType: "image/png", data: "a".repeat(64) },
    ]);
    expect(text).toContain("MCP 输出已截断");
    expect(images).toHaveLength(1);
  });
});

describe("boundMcpResult", () => {
  test("小结果原样通过", () => {
    const result: McpCallResult = { content: [{ type: "text", text: "ok" }] };
    const { summary, result: r } = boundMcpResult(result);
    expect(summary).toBeNull();
    expect(r).toEqual(result);
  });

  test("大结果出摘要并裁掉 structuredContent", () => {
    const result: McpCallResult = {
      content: [{ type: "text", text: "head" }],
      structuredContent: { blob: "y".repeat(MCP_DETAILS_MAX_BYTES) },
    };
    const { summary, result: r } = boundMcpResult(result);
    expect(summary).not.toBeNull();
    expect(summary!.contentBlocks).toBe(1);
    expect(summary!.structuredContentBytes).toBeGreaterThan(MCP_DETAILS_MAX_BYTES);
    expect(r?.structuredContent).toBeUndefined();
    // content（模型正文来源）保留
    expect((r?.content as Array<{ text?: string }>)[0].text).toBe("head");
  });

  test("超过 20 块的预览折叠为 omitted 行", () => {
    // 每块 ~1KB，30 块 ≈ 30KB 越过 16KB 摘要阈值
    const blocks = Array.from({ length: 30 }, (_, i) => ({
      type: "text",
      text: `t${i} ${"x".repeat(1024)}`,
    }));
    const { summary } = boundMcpResult({ content: blocks });
    expect(summary).not.toBeNull();
    expect(summary!.contentBlocks).toBe(30);
    expect(summary!.contentPreview).toHaveLength(21);
    expect(summary!.contentPreview[20].type).toBe("omitted");
  });
});

describe("spillToTempFile", () => {
  test("写入可读回", () => {
    const p = spillToTempFile("spilled content");
    expect(p).toBeTruthy();
    expect(readFileSync(p!, "utf8")).toBe("spilled content");
    rmSync(path.dirname(p!), { recursive: true, force: true });
  });
});
