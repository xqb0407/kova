import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTool, setReadStateCapForTests } from "../main/tool-exec";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kova-tool-exec-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeCall(id: string, dir: string, file: string, content: string) {
  return handleTool(id, {
    name: "write",
    cwd: dir,
    params: { file_path: file, content },
  }) as Promise<{ output: string }>;
}

describe("tool-exec write/read 的读前写约束", () => {
  test("新文件 40KB 一次写入成功（宿主没有 16KB 输入上限）", async () => {
    const dir = tempDir();
    const content = "x".repeat(40_000);
    const result = await writeCall("w1", dir, "big.txt", content);
    expect(result.output).toContain("Wrote 40000 bytes");
    expect(readFileSync(join(dir, "big.txt"), "utf8")).toBe(content);
  });

  test("write 成功后记录 read-state：不重新 read 也能再次 write", async () => {
    const dir = tempDir();
    await writeCall("w1", dir, "a.txt", "first");
    const result = await writeCall("w2", dir, "a.txt", "second");
    expect(result.output).toContain("Wrote 6 bytes");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("second");
  });

  test("外部创建的已存在文件未 read 就被拒绝", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "b.txt"), "outside");
    let message = "";
    try {
      await writeCall("w1", dir, "b.txt", "next");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("read it first");
  });

  test("read 之后写入成功", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "c.txt"), "outside");
    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "c.txt" } });
    const result = await writeCall("w1", dir, "c.txt", "next");
    expect(result.output).toContain("Wrote 4 bytes");
  });

  test("overwrite + append 分段写入成功", async () => {
    const dir = tempDir();
    await writeCall("w1", dir, "d.txt", "first");
    const result = (await handleTool("w2", {
      name: "write",
      cwd: dir,
      params: { file_path: "d.txt", content: "second", mode: "append" },
    })) as { output: string };
    expect(result.output).toContain("Appended 6 bytes");
    expect(readFileSync(join(dir, "d.txt"), "utf8")).toBe("firstsecond");
  });

  test("read 返回被截断时仍记录整档 read-state", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "e.txt"), "x".repeat(100_000));
    const read = (await handleTool("r1", {
      name: "read",
      cwd: dir,
      params: { file_path: "e.txt" },
    })) as { output: string };
    expect(read.output).toContain("truncated");
    const result = await writeCall("w1", dir, "e.txt", "next");
    expect(result.output).toContain("Wrote 4 bytes");
  });
});

describe("tool-exec write append 的 JSON 校验", () => {
  test("append 校验的是“已有内容 + 追加”的最终结果", async () => {
    const dir = tempDir();
    await writeCall("w1", dir, "ok.json", '{"a":1}');
    const result = (await handleTool("w2", {
      name: "write",
      cwd: dir,
      params: { file_path: "ok.json", content: "\n", mode: "append" },
    })) as { output: string };
    expect(result.output).toContain("Appended 1 bytes");
    expect(JSON.parse(readFileSync(join(dir, "ok.json"), "utf8"))).toEqual({ a: 1 });
  });

  test("append 后不是合法 JSON：拒绝且不改动文件", async () => {
    const dir = tempDir();
    await writeCall("w1", dir, "bad.json", '{"a":1}');
    let message = "";
    try {
      await handleTool("w2", {
        name: "write",
        cwd: dir,
        params: { file_path: "bad.json", content: ",", mode: "append" },
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("not be valid JSON");
    expect(readFileSync(join(dir, "bad.json"), "utf8")).toBe('{"a":1}');
  });
});

describe("tool-exec read 的 offset 防护", () => {
  test("offset 越过 EOF：显式报错而非空串", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    const result = (await handleTool("r1", {
      name: "read",
      cwd: dir,
      params: { file_path: "lines.txt", offset: 10 },
    })) as { output: string; totalLines: number };
    expect(result.output).toContain("beyond EOF");
    expect(result.output).toContain("3 total lines");
    expect(result.totalLines).toBe(3);
  });

  test("offset 恰好等于总行数：返回最后一行（不误判越界）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    const result = (await handleTool("r2", {
      name: "read",
      cwd: dir,
      params: { file_path: "lines.txt", offset: 3 },
    })) as { output: string };
    expect(result.output).toContain("3\tc");
    expect(result.output).not.toContain("beyond EOF");
  });

  test("offset 非法值回落 1（NaN 不再给空结果）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb");
    const result = (await handleTool("r3", {
      name: "read",
      cwd: dir,
      params: { file_path: "lines.txt", offset: "abc" },
    })) as { output: string };
    expect(result.output).toContain("1\ta");
  });
});

describe("tool-exec read-state LRU 驱逐", () => {
  test("容量驱逐下热点文件靠『最近使用』存活，其它文件按序挤出", async () => {
    // 容量测试缝调到 8：真实驱动驱逐路径（4096 的生产容量无法在小测里触顶）
    setReadStateCapForTests(8);
    try {
      const dir = tempDir();
      // 热点文件先登记（此时是 order 里最老的条目）
      await handleTool("h1", {
        name: "write",
        cwd: dir,
        params: { file_path: "hot.txt", content: "v1" },
      });
      // 7 个填充文件占满容量（热点 + 7 = 8）
      for (let i = 0; i < 7; i += 1) {
        await handleTool(`f${i}`, {
          name: "write",
          cwd: dir,
          params: { file_path: `fill-${i}.txt`, content: `fill ${i}` },
        });
      }
      // 持续用工具写热点（recordContent 应把它移到队尾）+ 新条目进队触发驱逐
      for (let i = 0; i < 12; i += 1) {
        const content = `v${i + 2}`;
        await handleTool(`hu${i}`, {
          name: "write",
          cwd: dir,
          params: { file_path: "hot.txt", content },
        });
        await handleTool(`x${i}`, {
          name: "write",
          cwd: dir,
          params: { file_path: `spill-${i}.txt`, content: `spill ${i}` },
        });
      }
      // 旧实现里热点按首次登记序早已被挤出：这里 hash 应仍新鲜，直接可写
      const result = (await handleTool("h2", {
        name: "write",
        cwd: dir,
        params: { file_path: "hot.txt", content: "final" },
      })) as { output: string };
      expect(result.output).toContain("Wrote 5 bytes");
    } finally {
      setReadStateCapForTests(4096);
    }
  });

  test("未被刷新的旧文件先被驱逐：写入时要求重读", async () => {
    setReadStateCapForTests(4);
    try {
      const dir = tempDir();
      await handleTool("a1", {
        name: "write",
        cwd: dir,
        params: { file_path: "stale.txt", content: "old" },
      });
      // 4 个新条目把 stale.txt 挤出（它是最老的未刷新条目）
      for (let i = 0; i < 4; i += 1) {
        await handleTool(`b${i}`, {
          name: "write",
          cwd: dir,
          params: { file_path: `later-${i}.txt`, content: `later ${i}` },
        });
      }
      let message = "";
      try {
        await handleTool("a2", {
          name: "write",
          cwd: dir,
          params: { file_path: "stale.txt", content: "new" },
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("read it first, then retry");
    } finally {
      setReadStateCapForTests(4096);
    }
  });
});

describe("tool-exec read 的 limit 钳制", () => {
  test("limit 为 0/负数：钳到 1 行，不再静默返回空切片", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    for (const limit of [0, -3]) {
      const result = (await handleTool(`l${limit}`, {
        name: "read",
        cwd: dir,
        params: { file_path: "lines.txt", offset: 2, limit },
      })) as { output: string };
      expect(result.output).toContain("2\tb");
      expect(result.output).toContain("1 more lines");
    }
  });
});
