import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initLocalStorage,
  knowledgeRefsStats,
  resetStorageForTest,
} from "../../src/storage/hostdb";
import {
  buildKnowledgeTools,
  frontmatterValue,
  isSafeRel,
  libraryCite,
  projectCite,
  sliceLines,
  splitFrontmatter,
  within,
} from "../../src/tools/knowledge-tools";

async function run(tool: { execute?: unknown }, params: unknown): Promise<string> {
  const result = await (tool.execute as (id: string, p: unknown) => Promise<{
    content: { type: string; text: string }[];
  }>)("call-1", params);
  return result.content.map((part) => part.text).join("\n");
}

describe("cite 格式", () => {
  it("资料库引用带编码 rel 与行号", () => {
    expect(libraryCite("项目/kova/a.md", "标题", 12)).toBe(
      `[资料库：标题](kova://library?rel=${encodeURIComponent("项目/kova/a.md")}&line=12)`,
    );
  });

  it("项目引用带编码 path 与会话 cwd", () => {
    expect(projectCite("docs/a b.md", 3, "/work/demo")).toBe(
      `[项目：docs/a b.md](kova://project?path=${encodeURIComponent("docs/a b.md")}&line=3&cwd=${encodeURIComponent("/work/demo")})`,
    );
  });

  it("标签里的 ] 不会截断链接", () => {
    expect(libraryCite("a.md", "a[b]")).toContain("[资料库：a b]");
  });
});

describe("路径安全", () => {
  it("允许库内相对路径", () => {
    expect(isSafeRel("a.md")).toBe(true);
    expect(isSafeRel("项目/kova/a.md")).toBe(true);
  });

  it("拒绝绝对、盘符、.. 与控制字符", () => {
    expect(isSafeRel("/a.md")).toBe(false);
    expect(isSafeRel("C:\\a.md")).toBe(false);
    expect(isSafeRel("../a.md")).toBe(false);
    expect(isSafeRel("a/../b.md")).toBe(false);
    expect(isSafeRel("a\u0000b.md")).toBe(false);
  });

  it("within 只认根与子树", () => {
    expect(within("/lib", "/lib/a.md")).toBe(true);
    expect(within("/lib", "/lib2/a.md")).toBe(false);
    expect(within("/lib", "/etc/passwd")).toBe(false);
  });
});

describe("frontmatter 与切片", () => {
  const note = `---\ntitle: "He said \\"hi\\""\ntags: ["api"]\n---\n\n# 正文\n第二行\n`;

  it("剥出 frontmatter 正文", () => {
    const { front, text } = splitFrontmatter(note);
    expect(front).toContain("title:");
    expect(text.startsWith("\n# 正文")).toBe(true);
  });

  it("读取 YAML 双引号标量", () => {
    const { front } = splitFrontmatter(note);
    expect(frontmatterValue(front, "title")).toBe('He said "hi"');
    expect(frontmatterValue(front, "tags")).toBe('["api"]');
  });

  it("没有 frontmatter 时原样返回", () => {
    expect(splitFrontmatter("# 正文")).toEqual({ front: "", text: "# 正文" });
  });

  it("按 1-based 行号切片并夹取越界", () => {
    expect(sliceLines("a\nb\nc", 2, 3)).toBe("b\nc");
    expect(sliceLines("a\nb\nc", 2)).toBe("b");
    expect(sliceLines("a\nb", 9, 10)).toBe("");
  });
});

describe("kb 工具", () => {
  const tools = buildKnowledgeTools({ cwd: "/tmp/project" });
  const search = tools.find((tool) => tool.name === "kb_search")!;
  const read = tools.find((tool) => tool.name === "kb_read")!;

  it("注册 kb_search / kb_read", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["kb_search", "kb_read"]);
  });

  it("空查询直接拒绝，不触发任何索引", async () => {
    expect(await run(search, { query: "  " })).toContain("query is required");
  });

  it("kb_read 库内路径越界直接拒绝", async () => {
    expect(await run(read, { source: "library", path: "../etc/passwd" })).toContain(
      "relative path",
    );
    expect(await run(read, { source: "library", path: "/etc/passwd" })).toContain(
      "relative path",
    );
  });

  it("kb_read 项目路径越界直接拒绝", async () => {
    expect(await run(read, { source: "project", path: "../../x" })).toContain(
      "relative path",
    );
  });

  it("未知 source 返回可操作说明", async () => {
    expect(await run(read, { source: "web", path: "a.md" })).toContain(
      "must be 'library', 'project' or 'memory'",
    );
  });
});

describe("kb 工具成功路径（local storage）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kb-tools-ok-"));
  const library = join(tmp, "library");
  const project = join(tmp, "project");
  const external = join(tmp, "backend");
  const prevLibrary = process.env.PI_LIBRARY_ROOT;
  const prevTask = process.env.PI_TASK_CWD;

  beforeAll(() => {
    mkdirSync(join(library, "项目", "demo"), { recursive: true });
    writeFileSync(
      join(library, "项目", "demo", "部署.md"),
      '---\ntitle: "部署手册"\ntags: ["ops"]\n---\n\n# 部署手册\n\nsqlite 迁移步骤\n',
    );
    // 超过 64KB 的长笔记：验证 startLine 在截断区之后仍能读到
    const longLines = Array.from({ length: 2200 }, (_, i) =>
      i === 1799 ? "LINE-1800 长笔记目标行" : `line ${i} ${"x".repeat(40)}`,
    );
    writeFileSync(join(library, "项目", "demo", "长笔记.md"), longLines.join("\n"));
    mkdirSync(join(project, "docs"), { recursive: true });
    writeFileSync(join(project, "docs", "arch.md"), "# Architecture\n\ncore modules\n");
    mkdirSync(join(external, "docs"), { recursive: true });
    writeFileSync(join(external, "docs", "external.md"), "# External\n\nbackend modules\n");
    process.env.PI_LIBRARY_ROOT = library;
    process.env.PI_TASK_CWD = join(tmp, "task-workspace");
    initLocalStorage(join(tmp, "state.db"));
  });

  afterAll(() => {
    resetStorageForTest();
    if (prevLibrary === undefined) delete process.env.PI_LIBRARY_ROOT;
    else process.env.PI_LIBRARY_ROOT = prevLibrary;
    if (prevTask === undefined) delete process.env.PI_TASK_CWD;
    else process.env.PI_TASK_CWD = prevTask;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("kb_read library：读正文、剥 frontmatter、给资料库 cite", async () => {
    const tools = buildKnowledgeTools({ cwd: project });
    const read = tools.find((tool) => tool.name === "kb_read")!;
    const text = await run(read, {
      source: "library",
      path: "项目/demo/部署.md",
    });
    expect(text).toContain("title: 部署手册");
    expect(text).toContain("cite: [资料库：部署手册]");
    expect(text).toContain("sqlite 迁移步骤");
    expect(text).not.toContain("source_session");
  });

  it("kb_read library：成功读取会记 knowledge_refs", async () => {
    const tools = buildKnowledgeTools({
      cwd: project,
      getSessionId: () => "sess-usage",
    });
    const read = tools.find((tool) => tool.name === "kb_read")!;
    await run(read, { source: "library", path: "项目/demo/部署.md" });
    // 统计是 fire-and-forget（不拖慢 kb_read），这里轮询等它落库
    let stat = { count: 0, lastTs: null as number | null };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      stat = await knowledgeRefsStats({
        source: "library",
        scopeId: library,
        path: "项目/demo/部署.md",
      });
      if (stat.count > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(stat.count).toBe(1);
  });

  it("kb_read project：读正文并给带 cwd 的 cite", async () => {
    const tools = buildKnowledgeTools({ cwd: project });
    const read = tools.find((tool) => tool.name === "kb_read")!;
    const text = await run(read, {
      source: "project",
      path: "docs/arch.md",
      startLine: 1,
      endLine: 1,
    });
    expect(text).toContain("# Architecture");
    expect(text).toContain("cite: [项目：docs/arch.md]");
    expect(text).toContain(`cwd=${encodeURIComponent(project)}`);
  });

  it("附加根：kb_search project 返回 root，kb_read 按 root 读取", async () => {
    const tools = buildKnowledgeTools({
      cwd: project,
      getExternalDirs: () => [{ path: external, label: "backend" }],
    });
    const search = tools.find((tool) => tool.name === "kb_search")!;
    const found = await run(search, { query: "external", scope: "project" });
    expect(found).toContain(`root=${external}`);
    expect(found).toContain("path=docs/external.md");

    // 非 git 目录：文件名不命中时补扫正文
    const byContent = await run(search, {
      query: "backend modules",
      scope: "project",
    });
    expect(byContent).toContain("path=docs/external.md:3");

    const read = tools.find((tool) => tool.name === "kb_read")!;
    const text = await run(read, {
      source: "project",
      root: external,
      path: "docs/external.md",
    });
    expect(text).toContain("backend modules");
    expect(text).toContain(`root: ${external}`);
    expect(text).toContain(`cwd=${encodeURIComponent(external)}`);

    // 文档地图里看到的是 [backend] 标签，kb_read 也接受标签
    const byLabel = await run(read, {
      source: "project",
      root: "backend",
      path: "docs/external.md",
    });
    expect(byLabel).toContain("backend modules");
  });

  it("kb_read project 拒绝不在项目根白名单里的 root", async () => {
    const tools = buildKnowledgeTools({
      cwd: project,
      getExternalDirs: () => [{ path: external, label: "backend" }],
    });
    const read = tools.find((tool) => tool.name === "kb_read")!;
    const text = await run(read, {
      source: "project",
      root: join(tmp, "elsewhere"),
      path: "docs/external.md",
    });
    expect(text).toContain("root is not part of this project");
  });

  it("kb_read library：超过 64KB 的行号仍能按 startLine 读到", async () => {
    const tools = buildKnowledgeTools({ cwd: project });
    const read = tools.find((tool) => tool.name === "kb_read")!;
    const text = await run(read, {
      source: "library",
      path: "项目/demo/长笔记.md",
      startLine: 1800,
      endLine: 1800,
    });
    expect(text).toContain("LINE-1800");
    expect(text).not.toContain("line 1799");
  });

  it("kb_search library：命中刚存入的笔记", async () => {
    const tools = buildKnowledgeTools({ cwd: project });
    const search = tools.find((tool) => tool.name === "kb_search")!;
    const text = await run(search, { query: "迁移", scope: "library" });
    expect(text).toContain("path=项目/demo/部署.md");
    expect(text).toContain("## library");
  });
});
