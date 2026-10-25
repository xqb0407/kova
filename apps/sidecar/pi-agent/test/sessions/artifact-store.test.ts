import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeSessionArtifacts,
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
