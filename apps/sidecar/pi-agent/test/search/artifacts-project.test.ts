import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactWatermark,
  buildArtifactIndexRows,
  extractSearchText,
  refreshArtifactsIndex,
} from "../../src/search/search-index";
import {
  scanProjectContent,
  searchProjectDirFull,
} from "../../src/search/project-search";
import { searchProjectDir } from "../../src/search/project-search";
import {
  execSync
} from "node:child_process";

function tmp(label: string): string {
  return mkdtempSync(join(tmpdir(), `kova-search-${label}-`));
}

describe("buildArtifactIndexRows（文件域抽取）", () => {
  test("文本文件进正文索引，非文本只剩文件名", () => {
    const dir = tmp("artifacts");
    try {
      writeFileSync(join(dir, "notes.md"), "# 部署手册\nsqlite 迁移步骤");
      writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(join(dir, "binary.json"), Buffer.from([0x00, 0x01, 0x02]));
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, "node_modules", "skip.js"), "should be skipped");

      const rows = buildArtifactIndexRows(dir);
      const byRel = new Map(rows.map((r) => [r.rel, r]));

      const md = byRel.get("notes.md");
      expect(md).toBeDefined();
      expect(md!.searchText).toContain("部署手册");
      expect(md!.searchText).toBe(md!.searchText.toLowerCase());

      const png = byRel.get("logo.png");
      expect(png).toBeDefined();
      expect(png!.searchText).toBe(""); // 非文本：只索引文件名
      expect(png!.name).toBe("logo.png");

      const bin = byRel.get("binary.json");
      expect(bin).toBeDefined();
      expect(bin!.searchText).toBe(""); // 含 NUL 的伪文本不进正文

      expect(byRel.has("node_modules/skip.js")).toBe(false); // 跳过目录
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("笔记 frontmatter 不进预览，但标题仍可被全文索引搜到", () => {
    const dir = tmp("artifact-frontmatter");
    try {
      writeFileSync(
        join(dir, "note.md"),
        '---\ntitle: "部署手册"\ntags: ["ops"]\n---\n\n# 部署手册\nsqlite 迁移步骤\n',
      );
      const rows = buildArtifactIndexRows(dir);
      const note = rows.find((r) => r.rel === "note.md")!;
      expect(note.preview).not.toContain("---");
      expect(note.preview).toContain("部署手册");
      expect(note.searchText).toContain("部署手册");
      expect(note.searchText).toContain("ops");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("水位对改名/移动敏感（mtime 与文件数都不变也必须重扫）", () => {
    const dir = tmp("artifact-rename");
    try {
      mkdirSync(join(dir, "a"));
      mkdirSync(join(dir, "b"));
      writeFileSync(join(dir, "a", "note.md"), "content");
      const before = artifactWatermark(dir);
      // rename 保持 mtime、文件数不变：旧水位 max(mtime)+count 不会变化
      renameSync(join(dir, "a", "note.md"), join(dir, "b", "note.md"));
      expect(artifactWatermark(dir)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("跳过点开头文件与 vendor/data 目录，深度有界", () => {
    const dir = tmp("artifact-skip");
    try {
      writeFileSync(join(dir, ".hidden.md"), "secret");
      mkdirSync(join(dir, "vendor"));
      writeFileSync(join(dir, "vendor", "x.js"), "vendored");
      mkdirSync(join(dir, "data"));
      writeFileSync(join(dir, "data", "y.json"), "{}");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "const deploy = 1;");
      const rows = buildArtifactIndexRows(dir);
      const rels = rows.map((r) => r.rel);
      expect(rels).toContain("src/a.ts");
      expect(rels).not.toContain(".hidden.md");
      expect(rels).not.toContain("vendor/x.js");
      expect(rels).not.toContain("data/y.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refreshArtifactsIndex 在 storage 未初始化时静默不抛", async () => {
    // 未 initHostTransport/initLocalStorage：内部 catch logErr 后返回
    await expect(refreshArtifactsIndex()).resolves.toBeUndefined();
  });
});

describe("searchProjectDir（项目域）", () => {
  test("git 仓库：内容命中带行号与 preview，文件名命中聚合", () => {
    const dir = tmp("proj-git");
    try {
      execSync("git init --quiet", { cwd: dir });
      writeFileSync(join(dir, "app.ts"), "const needle = 1;\nexport deploy();\n");
      execSync("git add .", { cwd: dir });
      execSync('git -c user.email=t@t -c user.name=t commit --quiet -m init', { cwd: dir });

      const result = searchProjectDir(dir, "needle");
      expect(result.contents.length).toBe(1);
      expect(result.contents[0]!.rel).toBe("app.ts");
      expect(result.contents[0]!.line).toBe(1);
      expect(result.contents[0]!.preview).toContain("needle");
      expect(result.files.map((f) => f.rel)).toContain("app.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git 仓库：cwd 是子目录时只搜子树，路径保持 cwd 相对", () => {
    const dir = tmp("proj-subdir");
    try {
      execSync("git init --quiet", { cwd: dir });
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "root.ts"), "const needle = 0;\n");
      writeFileSync(join(dir, "sub", "app.ts"), "const needle = 1;\n");
      execSync("git add .", { cwd: dir });
      execSync('git -c user.email=t@t -c user.name=t commit --quiet -m init', {
        cwd: dir,
      });

      const result = searchProjectDir(join(dir, "sub"), "needle");
      // 子目录 cwd：路径是 cwd 相对（app.ts），不是仓库根相对（sub/app.ts）；
      // cwd 之外的文件不进入结果（kb_read 按 cwd 解析，否则读不到/读错）。
      expect(result.contents.map((c) => c.rel)).toEqual(["app.ts"]);
      expect(result.files.map((f) => f.rel)).toEqual(["app.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git 仓库：未跟踪文件不进内容命中（git grep 语义），文件名扫描兜底", () => {
    const dir = tmp("proj-git-untracked");
    try {
      execSync("git init --quiet", { cwd: dir });
      writeFileSync(join(dir, "tracked.ts"), "const needle = 1;\n");
      execSync("git add .", { cwd: dir });
      execSync('git -c user.email=t@t -c user.name=t commit --quiet -m init', { cwd: dir });
      writeFileSync(join(dir, "untracked-helper.ts"), "const needle = 2;\n");

      const result = searchProjectDir(dir, "needle");
      // 内容：只有已跟踪的命中
      expect(result.contents.map((c) => c.rel)).toEqual(["tracked.ts"]);
      // 文件名：untracked-helper.ts 不含 "needle"…… 名字不含 → 不在文件命中
      // 但 tracked.ts 在（由内容命中聚合）
      expect(result.files.map((f) => f.rel)).toContain("tracked.ts");
      const nameResult = searchProjectDir(dir, "untracked-helper");
      expect(nameResult.files.map((f) => f.rel)).toContain("untracked-helper.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非 git 目录退化为文件名扫描", () => {
    const dir = tmp("proj-nogit");
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "deploy-utils.ts"), "const needle = 1;");
      writeFileSync(join(dir, "README.md"), "needle 在正文里");

      const result = searchProjectDir(dir, "deploy");
      expect(result.contents).toEqual([]); // 非 git：无内容域
      expect(result.files.map((f) => f.rel)).toContain("src/deploy-utils.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("空查询与不存在目录返回空", () => {
    expect(searchProjectDir("/no/such/dir", "x")).toEqual({
      files: [], contents: [], truncated: false,
    });
    const dir = tmp("proj-empty");
    try {
      expect(searchProjectDir(dir, "  ")).toEqual({
        files: [], contents: [], truncated: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractSearchText 边界补充", () => {
  test("user 图片块不产生索引文本", () => {
    const msg = {
      role: "user",
      content: [{ type: "image", data: "base64" }],
      timestamp: 0,
    } as unknown as Parameters<typeof extractSearchText>[0];
    expect(extractSearchText(msg)).toBe("");
  });

  test("user 消息里的资料库隐藏块不进索引", () => {
    const msg = {
      role: "user",
      content:
        "问题\n\n[[library-hints:abc]]\n- 部署手册 (path: a.md)\n[[/library-hints:abc]]",
      timestamp: 0,
    } as unknown as Parameters<typeof extractSearchText>[0];
    expect(extractSearchText(msg)).toBe("问题");
  });
});

describe("非 git 正文补扫", () => {
  test("scanProjectContent：命中行号，跳过二进制与依赖目录", async () => {
    const dir = tmp("content-scan");
    try {
      mkdirSync(join(dir, "docs"));
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(
        join(dir, "docs", "guide.md"),
        "# Guide\n\nthe needle is here\n",
      );
      writeFileSync(
        join(dir, "docs", "binary.md"),
        Buffer.from([0x00, 0x01, 0x02, 0x6e]),
      );
      writeFileSync(join(dir, "node_modules", "skip.md"), "needle");

      const result = await scanProjectContent(dir, "needle");
      expect(result.hits.map((hit) => hit.rel)).toEqual(["docs/guide.md"]);
      expect(result.hits[0]!.line).toBe(3);
      expect(result.hits[0]!.preview).toContain("needle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("searchProjectDirFull：文件名不命中时补正文命中", async () => {
    const dir = tmp("content-full");
    try {
      mkdirSync(join(dir, "docs"));
      writeFileSync(
        join(dir, "docs", "guide.md"),
        "# Guide\n\nunique phrase here\n",
      );
      const result = await searchProjectDirFull(dir, "unique phrase");
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]!.rel).toBe("docs/guide.md");
      expect(result.contents[0]!.line).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
