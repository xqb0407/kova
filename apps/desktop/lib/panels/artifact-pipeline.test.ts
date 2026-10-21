import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  ARTIFACT_CANDIDATE_LIMIT,
  ARTIFACT_VISIBLE_LIMIT,
  checkpointFilesToCandidates,
  collectTurnArtifactCandidates,
  finalizeArtifactCandidates,
  mergeArtifactCandidates,
  openModeFor,
  type ArtifactCandidate,
} from "@/lib/panels/artifacts";
import { extractArtifactFileReferences } from "@/lib/panels/artifact-file-references";
import type { FsStatEntry } from "@/lib/workspace/fs";

const CWD = "/workspace";
const TURN_START = 1_000_000;

function write(
  toolCallId: string,
  filePath: string,
  content: string,
  result: unknown = "ok",
) {
  return {
    type: "tool-call" as const,
    toolCallId,
    toolName: "write",
    args: { file_path: filePath, content },
    argsText: "",
    result,
  };
}

function edit(toolCallId: string, filePath: string, result: unknown = "ok") {
  return {
    type: "tool-call" as const,
    toolCallId,
    toolName: "edit",
    args: {
      file_path: filePath,
      old_string: "a",
      new_string: "b",
    },
    argsText: "",
    result,
  };
}

function text(value: string) {
  return { type: "text" as const, text: value };
}

function task(toolCallId: string) {
  return {
    type: "tool-call" as const,
    toolCallId,
    toolName: "Task",
    args: { description: "写报告" },
    argsText: "",
    result: "done",
  };
}

function partsOf(
  parts: readonly unknown[],
): ThreadMessage["content"] {
  return parts as ThreadMessage["content"];
}

function stat(
  path: string,
  options: Partial<FsStatEntry> = {},
): FsStatEntry {
  return {
    path,
    exists: true,
    isFile: true,
    size: 100,
    mtimeMs: TURN_START,
    ...options,
  };
}

describe("collectTurnArtifactCandidates", () => {
  test("edit-only 的交付文件也进候选（deck/表格逐页续写的主路径）", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([edit("e1", "deck.deck.canvas.json")]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe("edit");
    expect(candidates[0]?.absPath).toBe("/workspace/deck.deck.canvas.json");
  });

  test("write 后再 edit：同路径只留一个候选，write 的 toolCallId 保留，order 取最新", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([
        write("w1", "report.md", "# v1"),
        edit("e1", "report.md"),
      ]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe("write");
    expect(candidates[0]?.toolCallId).toBe("w1");
    expect(candidates[0]?.order).toBe(1);
  });

  test("失败的 write/edit 不收录", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([
        write("w1", "failed.md", "x", "[exit code: 1]"),
        { ...edit("e1", "rejected.md"), isError: true },
      ]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    expect(candidates).toHaveLength(0);
  });

  test("子代理 write/edit 路径并入父轮候选", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([task("t1")]),
      cwd: CWD,
      turnStartMs: TURN_START,
      subagentPaths: new Map([["t1", ["notes.md", "slides.pptx"]]]),
    });
    expect(candidates.map((c) => c.base).sort()).toEqual(["notes.md", "slides.pptx"]);
    expect(candidates.every((c) => c.source === "subagent")).toBe(true);
  });

  test("正文引用：Markdown 链接、file://、绝对路径都能解析", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([
        text(
          "报告见 [季度报告](reports/q3.pdf)，幻灯片 file:///tmp/deck.pptx，图片 /tmp/chart.png",
        ),
      ]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    const paths = candidates.map((c) => c.absPath).sort();
    expect(paths).toEqual([
      "/tmp/chart.png",
      "/tmp/deck.pptx",
      "/workspace/reports/q3.pdf",
    ]);
    expect(candidates.every((c) => c.source === "text")).toBe(true);
  });

  test("同一路径多次出现：保留最后一次（正文越靠后越接近最终交付）", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([
        text("[初版](report.md)"),
        text("[终版](report.md)"),
      ]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.order).toBeGreaterThan(0.999);
  });

  test("同路径多次 write：保留最后一次 write 的 toolCallId", () => {
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf([
        write("w1", "report.md", "# v1"),
        write("w2", "report.md", "# v2"),
      ]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.toolCallId).toBe("w2");
  });

  test("候选按最新优先排序并截断 15 个", () => {
    const writes = Array.from({ length: 20 }, (_, index) =>
      write(`w${index}`, `file-${index}.md`, "x"),
    );
    const candidates = collectTurnArtifactCandidates({
      parts: partsOf(writes),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    expect(candidates).toHaveLength(ARTIFACT_CANDIDATE_LIMIT);
    expect(candidates[0]?.base).toBe("file-19.md");
  });
});

describe("mergeArtifactCandidates", () => {
  test("来源优先级 write > edit > subagent > text", () => {
    const base: Omit<ArtifactCandidate, "source" | "order"> = {
      path: "report.md",
      absPath: "/workspace/report.md",
      relPath: "report.md",
      base: "report.md",
      touched: true,
    };
    const merged = mergeArtifactCandidates([
      { ...base, source: "text", order: 9, touched: false },
      { ...base, source: "subagent", order: 8 },
      { ...base, source: "edit", order: 7 },
      { ...base, source: "write", order: 1, toolCallId: "w1" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("write");
    expect(merged[0]?.toolCallId).toBe("w1");
    expect(merged[0]?.order).toBe(9);
  });
});

describe("checkpointFilesToCandidates", () => {
  test("收文档/办公/媒体，跳过删除、冲突和配置类扩展名", () => {
    const candidates = checkpointFilesToCandidates({
      cwd: CWD,
      turnStartMs: TURN_START,
      orderBase: 10,
      files: [
        { path: "reports/q3.pdf", status: "A" },
        { path: "slides/deck.pptx", status: "M" },
        { path: "chart.png", status: "?" },
        { path: "old.md", status: "D" },
        { path: "conflict.md", status: "U" },
        { path: "package.json", status: "M" },
        { path: "config.yaml", status: "M" },
      ],
    });
    expect(candidates.map((c) => c.base).sort()).toEqual([
      "chart.png",
      "deck.pptx",
      "q3.pdf",
    ]);
    expect(candidates.every((c) => c.source === "checkpoint")).toBe(true);
    expect(candidates.every((c) => c.touched)).toBe(true);
    expect(candidates.every((c) => c.turnStartMs === TURN_START)).toBe(true);
  });

  test("同路径有 write 候选时 checkpoint 让位（来源优先级最低）", () => {
    const sync = collectTurnArtifactCandidates({
      parts: partsOf([write("w1", "report.md", "# v1")]),
      cwd: CWD,
      turnStartMs: TURN_START,
    });
    const checkpoint = checkpointFilesToCandidates({
      cwd: CWD,
      turnStartMs: TURN_START,
      orderBase: 10,
      files: [{ path: "report.md", status: "M" }],
    });
    const merged = mergeArtifactCandidates([...sync, ...checkpoint]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("write");
    expect(merged[0]?.toolCallId).toBe("w1");
  });
});

describe("mergeArtifactCandidates（会话级）", () => {
  test("保留候选所属轮次的 turnStartMs，并支持自定义上限", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      path: `file-${index}.md`,
      absPath: `/workspace/file-${index}.md`,
      relPath: `file-${index}.md`,
      base: `file-${index}.md`,
      source: "write" as const,
      order: index,
      touched: true,
      turnStartMs: TURN_START + index,
    }));
    const merged = mergeArtifactCandidates(candidates, 3);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.turnStartMs).toBe(TURN_START + 19);
  });
});

describe("finalizeArtifactCandidates", () => {
  const candidate = (
    overrides: Partial<ArtifactCandidate> = {},
  ): ArtifactCandidate => ({
    path: "report.md",
    absPath: "/workspace/report.md",
    relPath: "report.md",
    base: "report.md",
    source: "write",
    order: 1,
    touched: true,
    fallbackSize: 10,
    ...overrides,
  });

  test("用磁盘大小覆盖 write content 大小；不存在的文件丢弃", () => {
    const stats = new Map([
      ["/workspace/report.md", stat("/workspace/report.md", { size: 4096 })],
      ["/workspace/missing.md", stat("/workspace/missing.md", { exists: false })],
    ]);
    const artifacts = finalizeArtifactCandidates(
      [
        candidate(),
        candidate({ path: "missing.md", absPath: "/workspace/missing.md" }),
      ],
      stats,
      { turnStartMs: TURN_START },
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.size).toBe(4096);
  });

  test("正文引用的文本类文件：旧 mtime 且本轮没动过 → 丢弃", () => {
    const stats = new Map([
      [
        "/workspace/README.md",
        stat("/workspace/README.md", { mtimeMs: TURN_START - 10 * 60_000 }),
      ],
    ]);
    const artifacts = finalizeArtifactCandidates(
      [
        candidate({
          path: "README.md",
          absPath: "/workspace/README.md",
          source: "text",
          touched: false,
        }),
      ],
      stats,
      { turnStartMs: TURN_START },
    );
    expect(artifacts).toHaveLength(0);
  });

  test("正文引用的文本类文件：mtime 在本轮内 → 保留（bash 刚生成的 html）", () => {
    const stats = new Map([
      [
        "/workspace/report.html",
        stat("/workspace/report.html", { mtimeMs: TURN_START + 1000 }),
      ],
    ]);
    const artifacts = finalizeArtifactCandidates(
      [
        candidate({
          path: "report.html",
          absPath: "/workspace/report.html",
          source: "text",
          touched: false,
        }),
      ],
      stats,
      { turnStartMs: TURN_START },
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.openMode).toBe("browser");
  });

  test("跨轮汇总：用候选自带的 turnStartMs，而不是汇总入口的默认值", () => {
    const stats = new Map([
      [
        "/workspace/README.md",
        stat("/workspace/README.md", { mtimeMs: TURN_START + 5_000 }),
      ],
    ]);
    const artifacts = finalizeArtifactCandidates(
      [
        candidate({
          path: "README.md",
          absPath: "/workspace/README.md",
          source: "text",
          touched: false,
          turnStartMs: TURN_START,
        }),
      ],
      stats,
      { turnStartMs: 0 },
    );
    expect(artifacts).toHaveLength(1);
  });

  test("Office/PDF/媒体不受 mtime 门控", () => {
    const stats = new Map([
      ["/workspace/deck.pptx", stat("/workspace/deck.pptx", { mtimeMs: 1 })],
      ["/workspace/report.pdf", stat("/workspace/report.pdf", { mtimeMs: 1 })],
    ]);
    const artifacts = finalizeArtifactCandidates(
      [
        candidate({
          path: "deck.pptx",
          absPath: "/workspace/deck.pptx",
          base: "deck.pptx",
          source: "text",
          touched: false,
        }),
        candidate({
          path: "report.pdf",
          absPath: "/workspace/report.pdf",
          base: "report.pdf",
          source: "text",
          touched: false,
        }),
      ],
      stats,
      { turnStartMs: TURN_START },
    );
    expect(artifacts.map((a) => a.base)).toEqual(["deck.pptx", "report.pdf"]);
  });

  test("没有 Host stat（web/dev-preview）：保留 write/edit，丢弃正文引用/子代理/checkpoint", () => {
    const artifacts = finalizeArtifactCandidates(
      [
        candidate({ fallbackSize: 42 }),
        candidate({
          path: "report.pdf",
          absPath: "/workspace/report.pdf",
          base: "report.pdf",
          source: "text",
          touched: false,
        }),
        candidate({
          path: "notes.md",
          absPath: "/workspace/notes.md",
          base: "notes.md",
          source: "subagent",
          touched: true,
        }),
        candidate({
          path: "chart.png",
          absPath: "/workspace/chart.png",
          base: "chart.png",
          source: "checkpoint",
          touched: true,
        }),
      ],
      null,
      { turnStartMs: TURN_START },
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.size).toBe(42);
    expect(artifacts[0]?.source).toBe("write");
  });

  test("最终最多渲染 10 张", () => {
    const candidates = Array.from({ length: 15 }, (_, index) =>
      candidate({
        path: `file-${index}.md`,
        absPath: `/workspace/file-${index}.md`,
        base: `file-${index}.md`,
        order: index,
      }),
    );
    const stats = new Map(
      candidates.map((entry) => [entry.absPath, stat(entry.absPath)]),
    );
    const artifacts = finalizeArtifactCandidates(candidates, stats, {
      turnStartMs: TURN_START,
    });
    expect(artifacts).toHaveLength(ARTIFACT_VISIBLE_LIMIT);
  });
});

describe("openModeFor", () => {
  test("html/pdf → browser；md/图片 → file；office/媒体 → system", () => {
    expect(openModeFor("report.html")).toBe("browser");
    expect(openModeFor("report.pdf")).toBe("browser");
    expect(openModeFor("report.md")).toBe("file");
    expect(openModeFor("chart.png")).toBe("file");
    expect(openModeFor("deck.pptx")).toBe("system");
    expect(openModeFor("clip.mp4")).toBe("system");
  });
});

describe("extractArtifactFileReferences", () => {
  const isDeliverable = (path: string) => /\.(md|pdf|pptx|html)$/i.test(path);

  test("相对路径以 workspace 为锚，绝对路径原样保留", () => {
    const refs = extractArtifactFileReferences(
      "见 [报告](reports/q3.pdf) 与 /tmp/deck.pptx",
      CWD,
      { isDeliverable },
    );
    expect(refs.map((ref) => ref.path).sort()).toEqual([
      "/tmp/deck.pptx",
      "/workspace/reports/q3.pdf",
    ]);
  });

  test("拒绝 ../ 越界与 http 链接", () => {
    const refs = extractArtifactFileReferences(
      "[a](../outside.md) [b](https://example.com/x.pdf)",
      CWD,
      { isDeliverable },
    );
    expect(refs).toHaveLength(0);
  });

  test("代码块里的示例不参与抽取", () => {
    const refs = extractArtifactFileReferences(
      "```md\n[示例](report.md)\n```\n真实文件 [报告](report.md)",
      CWD,
      { isDeliverable },
    );
    expect(refs).toHaveLength(1);
  });
});
