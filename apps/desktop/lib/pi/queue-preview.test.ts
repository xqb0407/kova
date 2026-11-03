import { describe, expect, test } from "bun:test";
import { previewQueueContent } from "./queue-preview";

describe("previewQueueContent（队列条引用/正文拆分）", () => {
  test("引用 + 正文", () => {
    expect(previewQueueContent("> 引用的原文\n\n问题是什么？")).toEqual({
      quote: "引用的原文",
      text: "问题是什么？",
      warnings: [],
    });
  });

  test("纯引用：正文为空", () => {
    expect(previewQueueContent("> 引用的原文")).toEqual({
      quote: "引用的原文",
      text: "",
      warnings: [],
    });
  });

  test("多行引用逐行还原，空行保留", () => {
    expect(
      previewQueueContent("> 第一行\n>\n> 第三行\n\n正文"),
    ).toEqual({
      quote: "第一行\n\n第三行",
      text: "正文",
      warnings: [],
    });
  });

  test("普通消息不受影响", () => {
    expect(previewQueueContent("普通消息")).toEqual({
      quote: null,
      text: "普通消息",
      warnings: [],
    });
  });

  test("引用 + 资料库隐藏块：隐藏块不进入正文", () => {
    const content =
      "> 引用\n\n问题\n\n[[library-refs:abc123]]\n- notes/a.md\n[[/library-refs:abc123]]";
    expect(previewQueueContent(content)).toEqual({
      quote: "引用",
      text: "问题",
      warnings: [],
    });
  });

  test("引用 + 图片注记：隐藏注记不进入正文", () => {
    const content = "> 引用\n\n问题\n\n[图片已缩放：坐标乘以 2]";
    expect(previewQueueContent(content)).toEqual({
      quote: "引用",
      text: "问题",
      warnings: [],
    });
  });

  test("图片省略告警保留在 warnings，供编辑回填提示", () => {
    const content = "> 引用\n\n问题\n\n[图片已省略：超过大小上限]";
    expect(previewQueueContent(content)).toEqual({
      quote: "引用",
      text: "问题",
      warnings: ["[图片已省略：超过大小上限]"],
    });
  });
});
