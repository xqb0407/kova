import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@assistant-ui/react";
import { createPanelActivityStore } from "@/lib/panel-activity";
import { isDeliverable, threadArtifacts, toFileUrl } from "@/lib/artifacts";

/* ------------------------------ 消息构造器 ------------------------------ */

type ToolPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
};

function tool(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  result?: unknown,
  isError?: boolean,
): ToolPart {
  const p: ToolPart = { type: "tool-call", toolCallId, toolName, args };
  if (result !== undefined) p.result = result;
  if (isError !== undefined) p.isError = isError;
  return p;
}

function msg(id: string, role: "user" | "assistant", parts: ToolPart[]): ThreadMessage {
  return { id, role, content: parts } as unknown as ThreadMessage;
}

/** 走真实 panel-activity 派生链路拿文件变更组（产物标签页的数据源形状） */
function deriveFiles(messages: ThreadMessage[]) {
  const store = createPanelActivityStore();
  return store.derive(messages).files;
}

/* ------------------------------ threadArtifacts ------------------------------ */

describe("threadArtifacts", () => {
  test("write 交付物进清单：文件名/大小/快照锚点来自 write 条目", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "index.html", content: "<html>你好</html>" }, "ok"),
      ]),
    ]);
    const artifacts = threadArtifacts(files);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual({
      toolCallId: "w1",
      path: "index.html",
      base: "index.html",
      size: new TextEncoder().encode("<html>你好</html>").length,
    });
  });

  test("非交付物扩展名不收录（与消息产物卡同一白名单）", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "src/app.ts", content: "export {};" }, "ok"),
      ]),
    ]);
    expect(threadArtifacts(files)).toHaveLength(0);
  });

  test("write 后再 edit：仍收录，锚点/大小停留在最后一次 write", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "page.html", content: "<p>a</p>" }, "ok"),
      ]),
      msg("m2", "assistant", [
        tool(
          "e1",
          "edit",
          { file_path: "page.html", old_string: "<p>a</p>", new_string: "<p>bbbb</p>" },
          "ok",
        ),
      ]),
    ]);
    const artifacts = threadArtifacts(files);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.toolCallId).toBe("w1");
    expect(artifacts[0]?.size).toBe(new TextEncoder().encode("<p>a</p>").length);
  });

  test("只有 edit 没有过 write 的路径不收录", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool(
          "e1",
          "edit",
          { file_path: "notes.md", old_string: "a", new_string: "b" },
          "ok",
        ),
      ]),
    ]);
    expect(threadArtifacts(files)).toHaveLength(0);
  });

  test("在途与失败的 write 不收录；早前成功的 write 仍是当前版本", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "a.html", content: "<p>v1</p>" }, "ok"),
      ]),
      msg("m2", "assistant", [
        tool("w2", "write", { file_path: "a.html", content: "<p>v2</p>" }),
        tool("w3", "write", { file_path: "b.html", content: "<p>x</p>" }, "boom", true),
      ]),
    ]);
    const artifacts = threadArtifacts(files);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.toolCallId).toBe("w1");
    expect(artifacts[0]?.path).toBe("a.html");
  });

  test("同路径跨消息重写：最后一次成功 write 胜出", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "index.html", content: "<p>v1</p>" }, "ok"),
      ]),
      msg("m2", "assistant", [
        tool("w2", "write", { file_path: "index.html", content: "<p>v2-longer</p>" }, "ok"),
      ]),
    ]);
    const artifacts = threadArtifacts(files);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.toolCallId).toBe("w2");
    expect(artifacts[0]?.size).toBe(new TextEncoder().encode("<p>v2-longer</p>").length);
  });

  test("多路径按最新产出排序（倒序输出，新的在上）；子目录路径取 basename", () => {
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "docs/readme.md", content: "# r" }, "ok"),
      ]),
      msg("m2", "assistant", [
        tool("w2", "write", { file_path: "site/index.html", content: "<p>1</p>" }, "ok"),
      ]),
    ]);
    const artifacts = threadArtifacts(files);
    expect(artifacts.map((a) => a.base)).toEqual(["index.html", "readme.md"]);
    expect(artifacts.map((a) => a.toolCallId)).toEqual(["w2", "w1"]);
  });

  test("md/txt 等文本交付物同样收录（isDeliverable 口径）", () => {
    expect(isDeliverable("report.md")).toBe(true);
    expect(isDeliverable("data.csv")).toBe(true);
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool("w1", "write", { file_path: "report.md", content: "# 报告" }, "ok"),
      ]),
    ]);
    expect(threadArtifacts(files)).toHaveLength(1);
  });

  test("svg 动画/图形是文本 write 可产出的交付物，且走浏览器预览", () => {
    expect(isDeliverable("pelican-ride-bike.svg")).toBe(true);
    expect(isDeliverable("icon.SVG")).toBe(true);
    const files = deriveFiles([
      msg("m1", "assistant", [
        tool(
          "w1",
          "write",
          { file_path: "pelican-ride-bike.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
          "ok",
        ),
      ]),
    ]);
    const artifacts = threadArtifacts(files);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.base).toBe("pelican-ride-bike.svg");
  });
});

/* ------------------------------ toFileUrl ------------------------------ */

describe("toFileUrl", () => {
  test("相对路径拼接 cwd", () => {
    expect(toFileUrl("/home/u/ws", "index.html")).toBe("file:///home/u/ws/index.html");
    expect(toFileUrl("/home/u/ws/", "site/index.html")).toBe("file:///home/u/ws/site/index.html");
  });

  test("绝对路径原样使用", () => {
    expect(toFileUrl("/any/cwd", "/tmp/x/a.html")).toBe("file:///tmp/x/a.html");
  });

  test("Windows 盘符走三斜杠", () => {
    expect(toFileUrl("C:\\ws", "a.html")).toBe("file:///C:/ws/a.html");
    expect(toFileUrl("C:/ws", "C:/other/b.html")).toBe("file:///C:/other/b.html");
  });

  test("逐段编码空格与中文", () => {
    expect(toFileUrl("/home/u/my ws", "我的 页面.html")).toBe(
      "file:///home/u/my%20ws/%E6%88%91%E7%9A%84%20%E9%A1%B5%E9%9D%A2.html",
    );
  });
});
