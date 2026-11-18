import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeLocalHost, handleTool, setReadStateCapForTests } from "../../src/local-host/tool-exec";

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
    ).rejects.toThrow(/Found 2 candidate blocks/);
    const result = await call("edit", dir, {
      file_path: "d.txt",
      old_string: "foo",
      new_string: "baz",
      replace_all: true,
    });
    expect(result.output).toContain("Replaced 2 occurrence");
    expect(readFileSync(join(dir, "d.txt"), "utf8")).toBe("baz bar baz");
  });

  test("edit 降级匹配：行号前缀 old_string 命中并回写干净内容", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "f.txt"), "function a() {\n  return 1;\n}\n");
    await call("read", dir, { file_path: "f.txt" });
    // 模型把 read 输出（N\t 行号）原样当 old_string 贴回来
    const result = await call("edit", dir, {
      file_path: "f.txt",
      old_string: "1\tfunction a() {\n2\t  return 1;\n3\t}",
      new_string: "function a() {\n  return 42;\n}",
    });
    expect(result.output).toContain("matched via line_number_prefix_stripped");
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("function a() {\n  return 42;\n}\n");
  });

  test("edit 降级匹配：缩进偏差命中且 not_found 文案给出恢复指引", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "g.ts"), "if (x) {\n    deep();\n}\n");
    await call("read", dir, { file_path: "g.ts" });

    // 缩进偏差（4 空格文件 vs 2 空格 old_string）→ line_trimmed 命中
    const ok = await call("edit", dir, {
      file_path: "g.ts",
      old_string: "if (x) {\n  deep();\n}",
      new_string: "if (x) {\n    deep();\n    done();\n}",
    });
    expect(ok.output).toContain("Replaced 1 occurrence");
    expect(ok.output).toContain("matched via");
    expect(readFileSync(join(dir, "g.ts"), "utf8")).toBe("if (x) {\n    deep();\n    done();\n}\n");

    // 彻底不存在的内容 → 自愈式 not_found
    writeFileSync(join(dir, "g.ts"), "if (x) {\n    deep();\n}\n");
    await call("read", dir, { file_path: "g.ts" });
    await expect(
      call("edit", dir, { file_path: "g.ts", old_string: "no such content", new_string: "x" }),
    ).rejects.toThrow(/Re-read the file with read/);
  });

  test("edit CRLF 文件：宽匹配命中且不引入混合行尾", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n");
    await call("read", dir, { file_path: "crlf.txt" });
    const result = await call("edit", dir, {
      file_path: "crlf.txt",
      old_string: "alpha\nbeta",
      new_string: "alpha\nbeta2",
    });
    expect(result.output).toContain("matched via");
    expect(readFileSync(join(dir, "crlf.txt"), "utf8")).toBe("alpha\r\nbeta2\r\ngamma\r\n");
  });

  test("edit exact 成功路径输出格式不变（回归守护）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "h.txt"), "hello world");
    await call("read", dir, { file_path: "h.txt" });
    const result = await call("edit", dir, {
      file_path: "h.txt",
      old_string: "world",
      new_string: "kova",
    });
    expect(result.output).toBe(
      `Replaced 1 occurrence(s) in h.txt (file state is current in your context — no need to Read it back)`,
    );
    expect(result.output).not.toContain("matched via");
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

describe("local-host read 的 offset 防护", () => {
  test("offset 越过 EOF：显式报错而非空串", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    const result = (await call("read", dir, { file_path: "lines.txt", offset: 10 })) as {
      output: string;
      totalLines: number;
    };
    expect(result.output).toContain("beyond EOF");
    expect(result.output).toContain("3 total lines");
    expect(result.totalLines).toBe(3);
  });

  test("offset 恰好等于总行数：返回最后一行（不误判越界）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    const result = (await call("read", dir, { file_path: "lines.txt", offset: 3 })) as {
      output: string;
    };
    expect(result.output).toContain("3\tc");
    expect(result.output).not.toContain("beyond EOF");
  });

  test("offset 非法值回落 1（NaN 不再给空结果）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb");
    const result = (await call("read", dir, { file_path: "lines.txt", offset: "abc" })) as {
      output: string;
    };
    expect(result.output).toContain("1\ta");
  });
});

describe("local-host read-state LRU 驱逐", () => {
  test("容量驱逐下热点文件靠『最近使用』存活，其它文件按序挤出", async () => {
    setReadStateCapForTests(8);
    try {
      const dir = tempDir();
      await call("write", dir, { file_path: "hot.txt", content: "v1" });
      for (let i = 0; i < 7; i += 1) {
        await call("write", dir, { file_path: `fill-${i}.txt`, content: `fill ${i}` });
      }
      for (let i = 0; i < 12; i += 1) {
        await call("write", dir, { file_path: "hot.txt", content: `v${i + 2}` });
        await call("write", dir, { file_path: `spill-${i}.txt`, content: `spill ${i}` });
      }
      const result = (await call("write", dir, { file_path: "hot.txt", content: "final" })) as {
        output: string;
      };
      expect(result.output).toContain("Wrote 5 bytes");
    } finally {
      setReadStateCapForTests(4096);
    }
  });

  test("未被刷新的旧文件先被驱逐：写入时要求重读", async () => {
    setReadStateCapForTests(4);
    try {
      const dir = tempDir();
      await call("write", dir, { file_path: "stale.txt", content: "old" });
      for (let i = 0; i < 4; i += 1) {
        await call("write", dir, { file_path: `later-${i}.txt`, content: `later ${i}` });
      }
      let message = "";
      try {
        await call("write", dir, { file_path: "stale.txt", content: "new" });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("read it first, then retry");
    } finally {
      setReadStateCapForTests(4096);
    }
  });
});

describe("local-host read 的 limit 钳制", () => {
  test("limit 为 0/负数：钳到 1 行，不再静默返回空切片", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "lines.txt"), "a\nb\nc");
    for (const limit of [0, -3]) {
      const result = (await call("read", dir, { file_path: "lines.txt", offset: 2, limit })) as {
        output: string;
      };
      expect(result.output).toContain("2\tb");
      expect(result.output).toContain("1 more lines");
    }
  });
});
