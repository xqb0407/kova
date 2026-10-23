import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTool } from "../main/tool-exec";

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
