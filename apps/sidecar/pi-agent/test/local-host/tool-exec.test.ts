import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeLocalHost, handleTool } from "../../src/local-host/tool-exec";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kova-local-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  disposeLocalHost();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, dir: string, params: Record<string, unknown>) {
  return (await handleTool(`${name}-${Math.random()}`, {
    name,
    cwd: dir,
    params,
  })) as Record<string, unknown> & { output?: string };
}

describe("local-host read/write/edit", () => {
  test("新文件可直接 write，且写入后可再次覆盖", async () => {
    const dir = tempDir();
    const first = await call("write", dir, { file_path: "a.txt", content: "one" });
    expect(first.output).toContain("Wrote 3 bytes");
    const second = await call("write", dir, { file_path: "a.txt", content: "two" });
    expect(second.output).toContain("Wrote 3 bytes");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two");
  });

  test("外部创建的已存在文件未 read 就 write 被拒绝", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "b.txt"), "outside");
    await expect(call("write", dir, { file_path: "b.txt", content: "next" })).rejects.toThrow(
      /read it first/,
    );
  });

  test("read 后 write 成功；重复全文 read 返回 wasted call", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "c.txt"), "line1\nline2");
    const read = await call("read", dir, { file_path: "c.txt" });
    expect(read.output).toContain("1\tline1");
    const again = await call("read", dir, { file_path: "c.txt" });
    expect(again.output).toContain("Wasted call");
    const write = await call("write", dir, { file_path: "c.txt", content: "changed" });
    expect(write.output).toContain("Wrote 7 bytes");
  });

  test("edit 精确替换且 replace_all 生效", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "d.txt"), "foo bar foo");
    await call("read", dir, { file_path: "d.txt" });
    await expect(
      call("edit", dir, { file_path: "d.txt", old_string: "foo", new_string: "baz" }),
    ).rejects.toThrow(/appears 2 times/);
    const result = await call("edit", dir, {
      file_path: "d.txt",
      old_string: "foo",
      new_string: "baz",
      replace_all: true,
    });
    expect(result.output).toContain("Replaced 2 occurrence");
    expect(readFileSync(join(dir, "d.txt"), "utf8")).toBe("baz bar baz");
  });

  test("write append 模式追加内容", async () => {
    const dir = tempDir();
    await call("write", dir, { file_path: "e.txt", content: "a" });
    await call("write", dir, { file_path: "e.txt", content: "b", mode: "append" });
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("ab");
  });

  test("JSON 文件写入非法内容被拒绝", async () => {
    const dir = tempDir();
    await expect(
      call("write", dir, { file_path: "x.json", content: "{oops" }),
    ).rejects.toThrow(/valid JSON/);
  });

  test("read 图片返回 base64 与 mimeType", async () => {
    const dir = tempDir();
    // 1x1 png
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(join(dir, "p.png"), png);
    const result = await call("read", dir, { file_path: "p.png" });
    expect(result.mimeType).toBe("image/png");
    expect(result.base64).toBe(png.toString("base64"));
    expect(result.output).toContain("Image attached");
  });
});

describe("local-host bash/task/http", () => {
  test("bash 返回 stdout 与退出码，非零退出不抛错", async () => {
    const dir = tempDir();
    const ok = await call("bash", dir, { command: "echo hello" });
    expect(ok.output).toContain("hello");
    expect(ok.exitCode).toBe(0);
    const fail = await call("bash", dir, { command: "exit 7" });
    expect(fail.exitCode).toBe(7);
    expect(fail.output).toContain("exit code: 7");
  });

  test("bash runInBackground 返回 taskId，task_output/task_stop 可用", async () => {
    const dir = tempDir();
    const started = await call("bash", dir, {
      command: "echo bg-output; sleep 5",
      runInBackground: true,
    });
    const taskId = Number(started.taskId);
    expect(taskId).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    const out = await call("task_output", dir, { taskId });
    expect(String(out.output)).toContain("bg-output");
    const stopped = await call("task_stop", dir, { taskId });
    expect(String(stopped.output)).toContain("killed");
  });

  test("http 返回文本响应与状态", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("pong", { headers: { "content-type": "text/plain" } });
      },
    });
    try {
      const dir = tempDir();
      const result = await call("http", dir, {
        url: `http://127.0.0.1:${server.port}/`,
        method: "GET",
      });
      expect(result.output).toBe("pong");
      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("screenshot 在 ACP 模式明确报错", async () => {
    const dir = tempDir();
    await expect(call("screenshot", dir, {})).rejects.toThrow(/not available in ACP/);
  });
});
