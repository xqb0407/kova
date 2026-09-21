import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOpenFileTool, displayPath } from "./open-file-tool";
import { buildTools } from "./tools";
import { setActiveReqId } from "../protocol/stream";

/** 面板唤起 chunk 断言：sendEventChunk 经 stream.send 写 stdout 一行 JSON */
describe("open_file tool", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-open-file-"));
  const captured: string[] = [];
  let origWrite: typeof process.stdout.write;

  beforeAll(() => {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      captured.push(String(c));
      return true;
    };
    setActiveReqId("t-open", "req-open");
  });

  afterAll(() => {
    setActiveReqId("t-open", null);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
      origWrite as unknown as (c: unknown) => boolean;
    rmSync(dir, { recursive: true, force: true });
  });

  const chunkOf = () => {
    const line = captured.find((l) => l.includes("data-panelOpen"));
    return line ? (JSON.parse(line) as { id: string; chunk: { type: string; data: unknown } }) : null;
  };

  test("相对路径：发 data-panelOpen file chunk 并回文本确认", async () => {
    captured.length = 0;
    const tool = buildOpenFileTool(dir, "t-open");
    const result = await tool.execute("c1", { path: "src/a.ts" });
    const sent = chunkOf();
    expect(sent).toBeTruthy();
    expect(sent!.id).toBe("req-open");
    expect(sent!.chunk.type).toBe("data-panelOpen");
    expect(sent!.chunk.data).toEqual({ type: "file", path: "src/a.ts", cwd: dir });
    expect((result.content[0] as { text: string }).text).toContain("已在面板打开 src/a.ts");
  });

  test("workspace 内绝对路径转相对；./ 前缀被 normalize", async () => {
    captured.length = 0;
    const tool = buildOpenFileTool(dir, "t-open");
    await tool.execute("c2", { path: path.join(dir, "src", "a.ts") });
    expect((chunkOf()!.chunk.data as { path: string }).path).toBe("src/a.ts");

    captured.length = 0;
    await tool.execute("c3", { path: "./src/a.ts" });
    expect((chunkOf()!.chunk.data as { path: string }).path).toBe("src/a.ts");
  });

  test("文件不存在：回文本错误且不发 chunk（不开空白标签）", async () => {
    captured.length = 0;
    const tool = buildOpenFileTool(dir, "t-open");
    const result = await tool.execute("c4", { path: "src/nope.ts" });
    expect(chunkOf()).toBeNull();
    expect((result.content[0] as { text: string }).text).toContain("文件不存在");
  });

  test("目录：回文本错误且不发 chunk", async () => {
    captured.length = 0;
    const tool = buildOpenFileTool(dir, "t-open");
    const result = await tool.execute("c5", { path: "src" });
    expect(chunkOf()).toBeNull();
    expect((result.content[0] as { text: string }).text).toContain("是目录不是文件");
  });

  test("无活动请求（线程无 prompt 在跑）：静默不发，文本照常返回", async () => {
    captured.length = 0;
    setActiveReqId("t-idle", "req-idle");
    const tool = buildOpenFileTool(dir, "t-idle");
    setActiveReqId("t-idle", null); // 模拟 turn 已结束
    const result = await tool.execute("c6", { path: "src/a.ts" });
    expect(chunkOf()).toBeNull();
    expect((result.content[0] as { text: string }).text).toContain("已在面板打开");
  });

  test("displayPath：workspace 外绝对路径原样保留", () => {
    expect(displayPath(dir, "/etc/hosts")).toBe("/etc/hosts");
    expect(displayPath("", "/etc/hosts")).toBe("/etc/hosts");
  });

  test("buildTools 装配 open_file", () => {
    expect(buildTools("/tmp", "t-wire").map((t) => t.name)).toContain("open_file");
  });
});
