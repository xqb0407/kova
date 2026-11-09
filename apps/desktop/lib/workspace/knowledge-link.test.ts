import { describe, expect, it } from "bun:test";
import {
  consumePendingLibraryOpen,
  isSafeLibraryRel,
  parseKnowledgeHref,
  peekPendingLibraryOpen,
  requestOpenLibraryFile,
} from "./knowledge-link";

describe("parseKnowledgeHref", () => {
  it("解析资料库引用并解码 rel", () => {
    const href = `kova://library?rel=${encodeURIComponent("项目/kova/a.md")}&line=12`;
    expect(parseKnowledgeHref(href)).toEqual({
      kind: "library",
      rel: "项目/kova/a.md",
      line: 12,
    });
  });

  it("解析项目文件引用（带会话 cwd）", () => {
    expect(
      parseKnowledgeHref(
        `kova://project?path=${encodeURIComponent("docs/arch.md")}&line=3&cwd=${encodeURIComponent("/work/demo")}`,
      ),
    ).toEqual({
      kind: "project",
      path: "docs/arch.md",
      line: 3,
      cwd: "/work/demo",
    });
  });

  it("项目引用里的相对 cwd 被忽略，退回当前工作区", () => {
    expect(
      parseKnowledgeHref(
        `kova://project?path=${encodeURIComponent("docs/arch.md")}&cwd=${encodeURIComponent("../other")}`,
      ),
    ).toEqual({ kind: "project", path: "docs/arch.md" });
  });

  it("拒绝绝对路径、.. 与空路径", () => {
    expect(
      parseKnowledgeHref(`kova://library?rel=${encodeURIComponent("/etc/passwd")}`),
    ).toBeNull();
    expect(
      parseKnowledgeHref(`kova://library?rel=${encodeURIComponent("../a.md")}`),
    ).toBeNull();
    expect(parseKnowledgeHref("kova://library?rel=")).toBeNull();
    expect(
      parseKnowledgeHref(`kova://project?path=${encodeURIComponent("a/../b")}`),
    ).toBeNull();
  });

  it("非 kova / 未知 host 不受理", () => {
    expect(parseKnowledgeHref("https://example.com/a")).toBeNull();
    expect(parseKnowledgeHref("kova://unknown?rel=a.md")).toBeNull();
  });

  it("非法行号被忽略而不是拒绝整条引用", () => {
    expect(
      parseKnowledgeHref(
        `kova://library?rel=${encodeURIComponent("a.md")}&line=0`,
      ),
    ).toEqual({ kind: "library", rel: "a.md" });
  });
});

describe("isSafeLibraryRel", () => {
  it("允许普通相对路径", () => {
    expect(isSafeLibraryRel("a.md")).toBe(true);
    expect(isSafeLibraryRel("项目/kova/a.md")).toBe(true);
  });

  it("拒绝绝对路径、盘符与控制字符", () => {
    expect(isSafeLibraryRel("/a.md")).toBe(false);
    expect(isSafeLibraryRel("C:\\a.md")).toBe(false);
    expect(isSafeLibraryRel("a\u0000b.md")).toBe(false);
  });
});

describe("pending library open", () => {
  it("请求后取走一次即清空", () => {
    requestOpenLibraryFile("项目/kova/a.md", 3);
    expect(peekPendingLibraryOpen()).toEqual({
      rel: "项目/kova/a.md",
      line: 3,
    });
    expect(consumePendingLibraryOpen()).toEqual({
      rel: "项目/kova/a.md",
      line: 3,
    });
    expect(consumePendingLibraryOpen()).toBeNull();
  });

  it("非法 rel 不写入 pending", () => {
    consumePendingLibraryOpen();
    requestOpenLibraryFile("../escape.md");
    expect(peekPendingLibraryOpen()).toBeNull();
  });
});
