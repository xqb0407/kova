import { describe, expect, it } from "bun:test";
import {
  splitPromptNotices,
  stripLibraryContextBlocks,
} from "./prompt-notices";

describe("stripLibraryContextBlocks", () => {
  it("剥掉 notes 块，保留前后正文", () => {
    const text = [
      "总结一下",
      "",
      "[[library-notes]]",
      'Referenced note "A":',
      "",
      "正文 A",
      "[[/library-notes]]",
    ].join("\n");
    expect(stripLibraryContextBlocks(text)).toBe("总结一下");
  });

  it("剥掉 refs 块（芯片保留在正文里）", () => {
    const text = [
      "看下 :library[周报]{name=library:notes%2Fa.md:%2Fl%2Fa.md}",
      "",
      "[[library-refs]]",
      "[资料库笔记] notes/a.md → `/l/a.md`",
      "[[/library-refs]]",
    ].join("\n");
    expect(stripLibraryContextBlocks(text)).toBe(
      "看下 :library[周报]{name=library:notes%2Fa.md:%2Fl%2Fa.md}",
    );
  });

  it("带随机边界的块（新格式）也能剥", () => {
    const text = [
      "看下 :library[周报]{name=library:notes%2Fa.md:%2Fl%2Fa.md}",
      "",
      "[[library-refs:ab12cd34]]",
      "[资料库笔记] notes/a.md → `/l/a.md`",
      "[[/library-refs:ab12cd34]]",
      "[[library-notes:ab12cd34]]",
      "Referenced note \"A\":",
      "",
      "正文",
      "[[/library-notes:ab12cd34]]",
    ].join("\n");
    expect(stripLibraryContextBlocks(text)).toBe(
      "看下 :library[周报]{name=library:notes%2Fa.md:%2Fl%2Fa.md}",
    );
  });

  it("自动召回提示块（hints）同样剥掉", () => {
    const text = [
      "继续上次那个部署",
      "",
      "[[library-hints:ab12cd34]]",
      "Possibly relevant library notes:",
      "- 部署手册 (path: 项目/demo/部署.md)",
      "[[/library-hints:ab12cd34]]",
    ].join("\n");
    expect(stripLibraryContextBlocks(text)).toBe("继续上次那个部署");
  });

  it("多块逐条剥（notes + refs 混排）", () => {
    const text = [
      "问题",
      "",
      "[[library-refs]]",
      "[资料库文件] a.pdf → `/l/a.pdf`",
      "[[/library-refs]]",
      "[[library-notes]]",
      "正文 B",
      "[[/library-notes]]",
    ].join("\n");
    expect(stripLibraryContextBlocks(text)).toBe("问题");
  });

  it("未闭合块剥到末尾（异常转录兜底）", () => {
    const text = "问题\n\n[[library-notes]]\n正文";
    expect(stripLibraryContextBlocks(text)).toBe("问题");
  });

  it("没有块 → 一字不动", () => {
    const text = "普通消息 [[not-a-block]]";
    expect(stripLibraryContextBlocks(text)).toBe(text);
  });
});

describe("splitPromptNotices × 资料库内联块", () => {
  it("气泡正文不含笔记块，原有注记剥离不受影响", () => {
    const text = [
      "看下这个",
      "",
      "[[library-notes]]",
      'Referenced note "A":',
      "",
      "正文 A",
      "[[/library-notes]]",
      "[图片已缩放：原图 4000x3000，本次按 0.5 缩放]",
    ].join("\n");
    const notices = splitPromptNotices(text);
    expect(notices.text).toBe("看下这个");
    expect(notices.hidden).toContain("[图片已缩放：原图 4000x3000，本次按 0.5 缩放]");
    expect(notices.warnings).toEqual([]);
  });

  it("只有内联块 → 正文为空", () => {
    const text = "[[library-notes]]\n正文\n[[/library-notes]]";
    expect(splitPromptNotices(text).text).toBe("");
  });
});
