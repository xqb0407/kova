import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adoptSessionArtifacts,
  collectArtifactReferences,
  removeSessionArtifacts,
  rewriteArtifactReferences,
  sliceUtf8,
  writeToolArtifact,
} from "../../src/sessions/artifact-store";
import { initStorage } from "../../src/storage/storage";
import { resetStorageForTest } from "../../src/storage/hostdb";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kova-artifact-"));
  roots.push(root);
  return root;
}

function input(overrides: Record<string, string> = {}) {
  return {
    sessionId: "s1",
    turnId: "t1",
    toolCallId: "c1",
    toolName: "grep",
    text: "hello",
    ...overrides,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("artifact-store", () => {
  test("sliceUtf8 按字节切且切点对齐序列边界（CJK 不出替换字符）", () => {
    const text = "你".repeat(100); // 每字 3 字节
    const buffer = Buffer.from(text, "utf8");
    expect(sliceUtf8(buffer, 0, 10)).toBe("你".repeat(3));
    expect(sliceUtf8(buffer, buffer.length - 10, buffer.length)).toBe(
      "你".repeat(3),
    );
    expect(sliceUtf8(buffer, 0, buffer.length)).toBe(text);
  });

  test("storage 已初始化时会话根优先于 PI_SESSIONS_DIR（目录不分叉）", async () => {
    const storeRoot = await tempRoot();
    const envRoot = await tempRoot();
    const prevEnv = process.env.PI_SESSIONS_DIR;
    process.env.PI_SESSIONS_DIR = envRoot;
    try {
      initStorage(join(storeRoot, "t.db"), join(storeRoot, "sessions"));
      const artifact = await writeToolArtifact(input());
      // 事实源是 storage 的会话根；环境变量只是未初始化时的兜底。
      // reference 走 realpath（macOS 临时目录 /var → /private/var），比较同源。
      const realStore = await realpath(join(storeRoot, "sessions"));
      expect(artifact.reference.startsWith(join(realStore, "artifacts"))).toBe(
        true,
      );
      expect(artifact.reference.startsWith(await realpath(envRoot))).toBe(false);
    } finally {
      process.env.PI_SESSIONS_DIR = prevEnv;
      resetStorageForTest();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("正常写入落在 artifacts/<sessionId>/ 下", async () => {
    const root = await tempRoot();
    const artifact = await writeToolArtifact(input(), { root });
    expect(artifact.reference).toContain(join(root, "artifacts", "s1"));
    expect(artifact.reference.endsWith(".txt")).toBe(true);
  });

  test("路径段清洗：../ 不会逃出 session 目录", async () => {
    const root = await tempRoot();
    const artifact = await writeToolArtifact(
      input({ toolCallId: "../../evil", turnId: "../x", sessionId: "../s" }),
      { root },
    );
    const reference = artifact.reference;
    expect(
      reference.startsWith(join(await realpath(root), "artifacts", "_s")),
    ).toBe(true);
    // 路径分隔符已被清洗，不存在真正的目录穿越段。
    expect(reference).not.toContain("/../");
  });

  test("session 目录是指向根外的符号链接时拒绝写入", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(join(root, "artifacts"), { recursive: true });
    try {
      await symlink(outside, join(root, "artifacts", "s1"), "dir");
    } catch {
      // Windows 上无符号链接权限：跳过该用例。
      return;
    }
    await expect(writeToolArtifact(input(), { root })).rejects.toThrow(
      /escapes the artifacts root/,
    );
  });

  test("保留策略：超过 maxFiles 时淘汰旧文件", async () => {
    const root = await tempRoot();
    for (let index = 0; index < 3; index += 1) {
      await writeToolArtifact(input({ toolCallId: `c${index}` }), {
        root,
        maxFilesPerSession: 2,
      });
    }
    const files = await readdir(join(root, "artifacts", "s1"));
    expect(files.length).toBeLessThanOrEqual(2);
  });

  test("removeSessionArtifacts 删除会话目录", async () => {
    const root = await tempRoot();
    await writeToolArtifact(input(), { root });
    await removeSessionArtifacts("s1", { root });
    const entries = await readdir(join(root, "artifacts")).catch(() => []);
    expect(entries).not.toContain("s1");
  });
});

describe("artifact 收养（fork）", () => {
  test("collectArtifactReferences 提取回执路径（含空格）并去重", () => {
    const reference = "/tmp/a b/artifacts/s1/out.txt";
    const refs = collectArtifactReferences({
      role: "toolResult",
      content: [
        {
          type: "text",
          text: `[Tool output externalized]\nArtifact: ${reference}\nOriginal bytes: 1`,
        },
      ],
      details: { tool_output_budget: { reference } },
    });
    expect([...refs]).toEqual([reference]);
    expect(collectArtifactReferences("普通文本没有回执")).toEqual(new Set());
  });

  test("adoptSessionArtifacts 硬链收养：源目录删除后新文件仍可读", async () => {
    const root = await tempRoot();
    const artifact = await writeToolArtifact(
      input({ sessionId: "src", text: "FULL OUTPUT" }),
      { root },
    );
    const mapping = await adoptSessionArtifacts({
      sourceSessionId: "src",
      targetSessionId: "dst",
      references: [artifact.reference],
      options: { root },
    });
    const adopted = mapping.get(artifact.reference);
    expect(adopted).toBeTruthy();
    const realDst = await realpath(join(root, "artifacts", "dst"));
    expect(dirname(adopted!)).toBe(realDst);
    expect(await readFile(adopted!, "utf8")).toBe("FULL OUTPUT");

    // 父会话清理后硬链文件仍可读（inode 还在）
    await removeSessionArtifacts("src", { root });
    expect(await readFile(adopted!, "utf8")).toBe("FULL OUTPUT");
  });

  test("引用不存在 / 指向其它会话目录时不收养", async () => {
    const root = await tempRoot();
    // 让源目录存在，同时造一个别会话的文件
    await writeToolArtifact(input({ sessionId: "src" }), { root });
    const other = await writeToolArtifact(input({ sessionId: "other" }), { root });

    const missing = await adoptSessionArtifacts({
      sourceSessionId: "src",
      targetSessionId: "dst",
      references: [join(root, "artifacts", "src", "missing.txt")],
      options: { root },
    });
    expect(missing.size).toBe(0);

    const crossSession = await adoptSessionArtifacts({
      sourceSessionId: "src",
      targetSessionId: "dst",
      references: [other.reference],
      options: { root },
    });
    expect(crossSession.size).toBe(0);
    // 惰性建目录：全部引用无效时不留空的目标目录
    expect(existsSync(join(root, "artifacts", "dst"))).toBe(false);
  });

  test("硬链不可用时回退复制，并保持 0600", async () => {
    const root = await tempRoot();
    const artifact = await writeToolArtifact(
      input({ sessionId: "src" }),
      { root },
    );
    const mapping = await adoptSessionArtifacts({
      sourceSessionId: "src",
      targetSessionId: "dst",
      references: [artifact.reference],
      options: {
        root,
        linkFile: async () => {
          throw new Error("EXDEV: cross-device link");
        },
      },
    });
    const adopted = mapping.get(artifact.reference);
    expect(adopted).toBeTruthy();
    expect(await readFile(adopted!, "utf8")).toBe("hello");
    if (process.platform !== "win32") {
      expect((await stat(adopted!)).mode & 0o777).toBe(0o600);
    }
  });

  test("混合引用：只收养存在的文件，缺失项保留原路径", async () => {
    const root = await tempRoot();
    const existing = await writeToolArtifact(
      input({ sessionId: "src", text: "present" }),
      { root },
    );
    const missingRef = join(root, "artifacts", "src", "gone.txt");
    const mapping = await adoptSessionArtifacts({
      sourceSessionId: "src",
      targetSessionId: "dst",
      references: [existing.reference, missingRef],
      options: { root },
    });
    expect(mapping.size).toBe(1);
    expect(mapping.has(existing.reference)).toBe(true);
    expect(mapping.has(missingRef)).toBe(false);
  });

  test("源会话目录被替换成指向根外的符号链接时拒绝收养", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(join(root, "artifacts"), { recursive: true });
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    try {
      await symlink(outside, join(root, "artifacts", "src"), "dir");
    } catch {
      // Windows 上无符号链接权限：跳过该用例。
      return;
    }
    const mapping = await adoptSessionArtifacts({
      sourceSessionId: "src",
      targetSessionId: "dst",
      references: [outsideFile],
      options: { root },
    });
    expect(mapping.size).toBe(0);
  });

  test("rewriteArtifactReferences 长路径优先：前缀冲突不互相污染", () => {
    const shortFrom = "/tmp/artifacts/src/a.txt";
    const longFrom = "/tmp/artifacts/src/a.txt.txt";
    const shortTo = "/tmp/artifacts/dst/SHORT.txt";
    const longTo = "/tmp/artifacts/dst/LONG.txt";
    const line = JSON.stringify({
      agent: {
        content: [
          { type: "text", text: `Artifact: ${shortFrom}\nArtifact: ${longFrom}` },
        ],
      },
    });
    const [out] = rewriteArtifactReferences(
      [line],
      new Map([
        [shortFrom, shortTo],
        [longFrom, longTo],
      ]),
    );
    expect(JSON.parse(out!).agent.content[0].text).toBe(
      `Artifact: ${shortTo}\nArtifact: ${longTo}`,
    );
  });

  test("rewriteArtifactReferences 按 JSON 转义形态改写；未命中的行不变", () => {
    const from = "/tmp/artifacts/src/a b.txt";
    const to = "/tmp/artifacts/dst/a b.txt";
    const hit = JSON.stringify({
      agent: { content: [{ type: "text", text: `Artifact: ${from}` }] },
    });
    const miss = JSON.stringify({ agent: { content: [{ type: "text", text: "no ref" }] } });
    const [outHit, outMiss] = rewriteArtifactReferences(
      [hit, miss],
      new Map([[from, to]]),
    );
    expect(JSON.parse(outHit!).agent.content[0].text).toBe(`Artifact: ${to}`);
    expect(outMiss).toBe(miss);
  });
});
