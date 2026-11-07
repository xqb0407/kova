import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTool, cancelToolsByOwner } from "../main/tool-exec";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kova-tool-exec-aff-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // 兜底清前台在飞工具（bgTasks 里的后台任务不在 inFlight 表，测试内已用
  // task_stop 显式停掉；sleep 类命令即使遗漏也会自行退出）
  cancelToolsByOwner(null);
});

describe("read 全文重读纠偏（wasted-call stub）", () => {
  test("同一文件连续两次全文 read：第二次返回 wasted-call 提示", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "hello world");
    const first = (await handleTool("r1", {
      name: "read",
      cwd: dir,
      params: { file_path: "a.txt" },
    })) as { output: string };
    expect(first.output).toContain("hello world");
    const second = (await handleTool("r2", {
      name: "read",
      cwd: dir,
      params: { file_path: "a.txt" },
    })) as { output: string };
    expect(second.output).toContain("Wasted call");
    expect(second.output).not.toContain("hello world");
  });

  test("带 offset 的重读放行（分页/定位是有目的的重读）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "b.txt"), "line1\nline2\nline3");
    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "b.txt" } });
    const again = (await handleTool("r2", {
      name: "read",
      cwd: dir,
      params: { file_path: "b.txt", offset: 2 },
    })) as { output: string };
    expect(again.output).toContain("line2");
    expect(again.output).not.toContain("Wasted call");
  });

  test("文件被外部修改后重读：返回新内容（哈希不匹配不拦）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "c.txt"), "before");
    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "c.txt" } });
    writeFileSync(join(dir, "c.txt"), "after");
    const second = (await handleTool("r2", {
      name: "read",
      cwd: dir,
      params: { file_path: "c.txt" },
    })) as { output: string };
    expect(second.output).toContain("after");
    expect(second.output).not.toContain("Wasted call");
  });

  test("stub 后带 offset 重读是逃生通道（压缩后上下文丢失场景）", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "d.txt"), "content");
    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "d.txt" } });
    const stub = (await handleTool("r2", {
      name: "read",
      cwd: dir,
      params: { file_path: "d.txt" },
    })) as { output: string };
    expect(stub.output).toContain("offset=1");
    const escape = (await handleTool("r3", {
      name: "read",
      cwd: dir,
      params: { file_path: "d.txt", offset: 1 },
    })) as { output: string };
    expect(escape.output).toContain("content");
  });
});

describe("write/edit 成功消息附新鲜提示", () => {
  test("write 输出带 file state is current 后缀", async () => {
    const dir = tempDir();
    const result = (await handleTool("w1", {
      name: "write",
      cwd: dir,
      params: { file_path: "a.txt", content: "data" },
    })) as { output: string };
    expect(result.output).toContain("Wrote 4 bytes");
    expect(result.output).toContain("no need to Read it back");
  });

  test("edit 输出带 file state is current 后缀", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "b.txt"), "foo bar");
    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "b.txt" } });
    const result = (await handleTool("e1", {
      name: "edit",
      cwd: dir,
      params: { file_path: "b.txt", old_string: "foo", new_string: "baz" },
    })) as { output: string };
    expect(result.output).toContain("Replaced 1 occurrence(s)");
    expect(result.output).toContain("no need to Read it back");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("baz bar");
  });

  test("append 输出同样带后缀", async () => {
    const dir = tempDir();
    await handleTool("w1", {
      name: "write",
      cwd: dir,
      params: { file_path: "c.txt", content: "one" },
    });
    const result = (await handleTool("w2", {
      name: "write",
      cwd: dir,
      params: { file_path: "c.txt", content: "two", mode: "append" },
    })) as { output: string };
    expect(result.output).toContain("Appended 3 bytes");
    expect(result.output).toContain("no need to Read it back");
  });
});

describe("read 截断带续读路标", () => {
  test("超 64KB 截断时提示 offset 续读行号", async () => {
    const dir = tempDir();
    // 每行 100 字节 × 1000 行 = 100KB，必然越过 64KB 截断线
    const lines = Array.from({ length: 1_000 }, (_, i) => `line-${String(i).padStart(4, "0")}-${"x".repeat(88)}`);
    writeFileSync(join(dir, "big.txt"), lines.join("\n"));
    const read = (await handleTool("r1", {
      name: "read",
      cwd: dir,
      params: { file_path: "big.txt" },
    })) as { output: string };
    expect(read.output).toContain("truncated — continue with offset=");
    const m = read.output.match(/offset=(\d+)/);
    expect(m).not.toBeNull();
    const nextOffset = Number(m![1]);
    expect(nextOffset).toBeGreaterThan(1);
    // 路标行号必须落在文件行数范围内（近似值，允许差一行）
    expect(nextOffset).toBeLessThanOrEqual(1_000 + 1);
    // 带 offset 续读确实能拿到后续内容
    const resume = (await handleTool("r2", {
      name: "read",
      cwd: dir,
      params: { file_path: "big.txt", offset: nextOffset, limit: 10 },
    })) as { output: string };
    expect(resume.output).toContain(`line-${String(nextOffset - 1).padStart(4, "0")}`);
  });
});

describe("bash 超时自动转后台（兜底：转换失败回落杀进程）", () => {
  test("超时不杀进程：降级为后台任务，taskId 可续读可停止", async () => {
    const dir = tempDir();
    const owner = "aff-thread-timeout";
    const started = Date.now();
    const result = (await handleTool("b1", {
      name: "bash",
      cwd: dir,
      owner,
      params: { command: "sleep 3 && echo done", timeout: 1_000 },
    })) as { output: string; taskId: number; running: boolean };
    const elapsed = Date.now() - started;
    // 不等满 3s 命令结束：1s 超时即返回
    expect(elapsed).toBeLessThan(2_500);
    expect(result.taskId).toBeGreaterThan(0);
    expect(result.running).toBe(true);
    expect(result.output).toContain("converted to background task");
    expect(result.output).not.toContain("output above is what was collected before the kill");
    // 后台任务还活着：task_output 可读且仍在跑
    const out = (await handleTool("o1", {
      name: "task_output",
      params: { taskId: result.taskId },
      owner,
    })) as { output: string; running: boolean };
    expect(out.running).toBe(true);
    // task_stop 停掉，避免测试遗留进程
    const stop = (await handleTool("s1", {
      name: "task_stop",
      params: { taskId: result.taskId },
      owner,
    })) as { output: string };
    expect(stop.output).toContain("killed");
  });

  test("正常完成的命令不受影响（超时前退出走原路径）", async () => {
    const dir = tempDir();
    const result = (await handleTool("b2", {
      name: "bash",
      cwd: dir,
      params: { command: "echo quick", timeout: 10_000 },
    })) as { output: string; taskId?: number };
    expect(result.output).toContain("quick");
    expect(result.taskId).toBeUndefined();
  });
});
