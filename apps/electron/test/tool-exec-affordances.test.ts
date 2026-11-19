import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTool,
  cancelToolsByOwner,
  listBgTasks,
  reownBgTasks,
  setBgTaskExitListener,
  reapOrphanBgTasks,
  setBgOrphanKv,
} from "../main/tool-exec";

/** 测试内 kv 镜像：孤儿登记走注入钩子（tool-exec 不静态依赖 store/electron） */
const orphanKv = new Map<string, string>();
setBgOrphanKv({
  get: (key) => orphanKv.get(key) ?? null,
  set: (key, value) => void orphanKv.set(key, value),
});

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

  test("bash 被信号杀死不谎报 timeout（#11613 同类文案矛盾）", async () => {
    const dir = tempDir();
    const result = (await handleTool("sig1", {
      name: "bash",
      cwd: dir,
      params: { command: "kill -TERM $$" },
    })) as { output: string };
    expect(result.output).not.toContain("timeout after");
    expect(result.output).toContain("terminated by signal");
  });

  test("bash 被信号杀死不谎报 timeout（#11613 同类文案矛盾）", async () => {
    const dir = tempDir();
    const result = (await handleTool("sig1", {
      name: "bash",
      cwd: dir,
      params: { command: "kill -TERM $$" },
    })) as { output: string };
    expect(result.output).not.toContain("timeout after");
    expect(result.output).toContain("terminated by signal");
  });

  test("write/edit 拒绝 symlink 越界（写根审批不可被词法路径绕过）", async () => {
    const dir = tempDir();
    const outside = mkdtempSync(join(tmpdir(), "kova-symlink-out-"));
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "top secret");
    symlinkSync(outsideFile, join(dir, "link.txt"));

    const rejects = async (p: Promise<unknown>, re: RegExp) => {
      let msg = "";
      try {
        await p;
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toMatch(re);
    };

    // 写穿 symlink → 拒绝，且真实目标内容不变
    await rejects(
      handleTool("sy1", { name: "write", cwd: dir, params: { file_path: "link.txt", content: "hacked" } }),
      /refused/,
    );
    expect(readFileSync(outsideFile, "utf8")).toBe("top secret");

    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "link.txt" } });
    await rejects(
      handleTool("sy2", {
        name: "edit",
        cwd: dir,
        params: { file_path: "link.txt", old_string: "top", new_string: "no" },
      }),
      /refused/,
    );
    expect(readFileSync(outsideFile, "utf8")).toBe("top secret");

    // 目录型 symlink：沿它创建新文件同样拒绝
    symlinkSync(outside, join(dir, "dirlink"));
    await rejects(
      handleTool("sy3", { name: "write", cwd: dir, params: { file_path: "dirlink/evil.txt", content: "x" } }),
      /refused/,
    );
    rmSync(outside, { recursive: true, force: true });
  });

  test("对抗回归：词法路径在区外的写入不做 symlink 判定（/tmp 脚本是合法路径）", async () => {
    const dir = tempDir();
    const outside = mkdtempSync(join(tmpdir(), "kova-outside-write-"));
    const target = join(outside, "script.sh");
    const result = (await handleTool("ow1", {
      name: "write",
      cwd: dir,
      params: { file_path: target, content: "echo hi" },
    })) as { output: string };
    expect(result.output).toContain("Wrote");
    expect(readFileSync(target, "utf8")).toBe("echo hi");
    rmSync(outside, { recursive: true, force: true });
  });

  test("edit 降级匹配：缩进偏差命中时输出附 matched via 提示且内容正确", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "d.txt"), "if (x) {\n    deep();\n}\n");
    await handleTool("r1", { name: "read", cwd: dir, params: { file_path: "d.txt" } });
    const result = (await handleTool("e1", {
      name: "edit",
      cwd: dir,
      params: {
        file_path: "d.txt",
        old_string: "if (x) {\n  deep();\n}",
        new_string: "if (x) {\n    deep();\n    done();\n}",
      },
    })) as { output: string };
    expect(result.output).toContain("Replaced 1 occurrence(s)");
    expect(result.output).toContain("matched via");
    expect(result.output).toContain("no need to Read it back");
    expect(readFileSync(join(dir, "d.txt"), "utf8")).toBe("if (x) {\n    deep();\n    done();\n}\n");
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
    })) as { output: string; taskId: number; running: boolean; timedOut?: boolean };
    const elapsed = Date.now() - started;
    // 不等满 3s 命令结束：1s 超时即返回
    expect(elapsed).toBeLessThan(2_500);
    expect(result.taskId).toBeGreaterThan(0);
    expect(result.running).toBe(true);
    expect(result.timedOut).toBe(true); // 诊断码数据源：timeout_backgrounded
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
    })) as { output: string; taskId?: number; timedOut?: boolean };
    expect(result.output).toContain("quick");
    expect(result.taskId).toBeUndefined();
    // 非超时路径不带标记（杀进程回落返回 false：timedOut && !cancelled）
    expect(result.timedOut === true).toBe(false);
  });

  test("显式 runInBackground 不带 timedOut（与超时转后台区分）", async () => {
    const dir = tempDir();
    const result = (await handleTool("b3", {
      name: "bash",
      cwd: dir,
      params: { command: "sleep 5 && echo bg", runInBackground: true },
    })) as { output: string; taskId: number; timedOut?: boolean };
    expect(result.taskId).toBeGreaterThan(0);
    expect(result.timedOut).toBeUndefined();
    const stop = (await handleTool("s2", {
      name: "task_stop",
      params: { taskId: result.taskId },
    })) as { output: string };
    expect(stop.output).toContain("killed");
  });
});

describe("后台任务退出推送（bg_task_exit 数据源）", () => {
  test("进程退出即回调终态，宿主任务表可按线程读出", async () => {
    const dir = tempDir();
    const owner = "aff-bg-exit-thread";
    let resolveExit!: (event: Record<string, unknown>) => void;
    const exited = new Promise<Record<string, unknown>>((resolve) => {
      resolveExit = resolve;
    });
    setBgTaskExitListener((event) => {
      resolveExit(event as unknown as Record<string, unknown>);
    });
    try {
      const started = (await handleTool("be1", {
        name: "bash",
        cwd: dir,
        owner,
        params: { command: "sleep 0.05; exit 3", runInBackground: true },
      })) as { taskId: number };
      expect(started.taskId).toBeGreaterThan(0);
      const event = await Promise.race([
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("exit notify timeout")), 5_000),
        ),
      ]);
      expect(event.taskId).toBe(started.taskId);
      expect(event.owner).toBe(owner);
      expect(event.exitCode).toBe(3);
      expect(event.stopped).toBe(false);
      expect(event.source).toBe("explicit");
      // 宿主表快照：按线程过滤，终态已落表
      const row = listBgTasks(owner).find((t) => t.taskId === started.taskId);
      expect(row?.running).toBe(false);
      expect(row?.exitCode).toBe(3);
      expect(listBgTasks("another-thread")).toEqual([]);
    } finally {
      setBgTaskExitListener(null);
    }
  });

  test("线程改绑：任务归属随线程走，改绑后可按新键读取/停止", async () => {
    const dir = tempDir();
    const started = (await handleTool("be2", {
      name: "bash",
      cwd: dir,
      owner: "draft-thread",
      params: { command: "sleep 5", runInBackground: true },
    })) as { taskId: number };
    expect(reownBgTasks("draft-thread", "sess-reowned")).toBeGreaterThanOrEqual(1);
    // 旧键不再可见、新键可见（不变量：task_output/task_stop 的归属校验同源）
    expect(listBgTasks("draft-thread").find((t) => t.taskId === started.taskId)).toBeUndefined();
    expect(listBgTasks("sess-reowned").find((t) => t.taskId === started.taskId)?.running).toBe(true);
    // 改绑后新线程可停止（宿主归属校验通过）
    const stop = (await handleTool("be2s", {
      name: "task_stop",
      params: { taskId: started.taskId },
      owner: "sess-reowned",
    })) as { output: string };
    expect(stop.output).toContain("killed");
  });
});

describe("SIGKILL 孤儿登记与回收", () => {
  test("注册任务即写 kv 登记；停止后自身行移除；reap 消费遗留登记", async () => {
    const dir = tempDir();
    const owner = "aff-orphan-thread";
    // 前序测试可能有未退尽的 sleep 任务在 kv 里：只关注本测试自己的行
    orphanKv.clear();
    const started = (await handleTool("or1", {
      name: "bash",
      cwd: dir,
      owner,
      params: { command: "sleep 30", runInBackground: true },
    })) as { taskId: number };
    const rows = () =>
      JSON.parse(orphanKv.get("bg_orphan_tasks") ?? "[]") as Array<{
        pgid: number;
        startedAt: number;
        command: string;
      }>;
    expect(rows().some((r) => r.command === "sleep 30")).toBe(true);

    // 停掉后本任务行移除（handleTaskStop 同步刷新登记，不等 exit 事件）
    await handleTool("or2", {
      name: "task_stop",
      params: { taskId: started.taskId },
      owner,
    });
    expect(rows().some((r) => r.command === "sleep 30")).toBe(false);

    // 遗留登记消费：活组且启动时间吻合才杀；消费完清空。
    // 本进程 pgid 存活但启动时间(0)与真实 lstart 差距巨大 → 跳过不杀（PID 复用守卫）
    orphanKv.set(
      "bg_orphan_tasks",
      JSON.stringify([{ pgid: process.pid, startedAt: 0, command: "gone" }]),
    );
    expect(reapOrphanBgTasks()).toBe(0);
    expect(JSON.parse(orphanKv.get("bg_orphan_tasks")!)).toEqual([]);
  });
});
