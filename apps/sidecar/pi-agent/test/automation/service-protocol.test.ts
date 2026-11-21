/**
 * kova-automation 进程协议集成测试：不 mock 调度器，直接拉起 entry.ts，
 * 走 create → run_now → automation_run_request → result → runHistory 全链。
 *
 * main ↔ sidecar 的 Electron 侧仍建议手工/打包验证；这里覆盖调度进程自己的
 * 协议契约（ready 先于补跑、RPC 应答、runner 结果结算）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

describe("kova-automation service protocol", () => {
  let sessionsDir: string;
  let proc: ChildProcessWithoutNullStreams | null = null;
  let nextMessage: Promise<Record<string, unknown>>;
  let resolveMessage: (message: Record<string, unknown>) => void = () => {};
  let messageBuffer: Record<string, unknown>[] = [];

  const pushMessage = (message: Record<string, unknown>): void => {
    if (resolveMessage) {
      const resolve = resolveMessage;
      resolveMessage = () => {};
      resolve(message);
    } else {
      messageBuffer.push(message);
    }
  };

  const next = (): Promise<Record<string, unknown>> => {
    const buffered = messageBuffer.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      resolveMessage = resolve;
    });
  };

  const send = (message: unknown): void => {
    if (!proc) throw new Error("automation process not started");
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const expectMessage = async (
    match: (message: Record<string, unknown>) => boolean,
    label: string,
  ): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const message = await withTimeout(next(), TIMEOUT_MS, label);
      if (match(message)) return message;
    }
    throw new Error(`${label}: expected message never arrived`);
  };

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "kova-automation-"));
    proc = spawn(
      process.execPath,
      [join(import.meta.dir, "../../src/automation/entry.ts")],
      {
        env: {
          ...process.env,
          PI_SESSIONS_DIR: sessionsDir,
          KOVA_SESSIONS_DIR: sessionsDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;

    nextMessage = Promise.resolve({ type: "__none__" });
    const stdout = createInterface({ input: proc.stdout });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        pushMessage(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // stderr 已记录；协议测试只关心 JSON 帧
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      // 保留失败排查信息；正常启动日志不落 test 输出
      if (process.env.KOVA_TEST_VERBOSE) process.stderr.write(`[automation] ${chunk}`);
    });
  });

  afterEach(async () => {
    try {
      send({ type: "shutdown" });
    } catch {
      /* already closed */
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
        proc.once("close", resolve);
      }),
      2_000,
      "shutdown",
    ).catch(() => proc?.kill());
    proc = null;
    messageBuffer = [];
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("readies before catch-up and runs create/run_now through the host runner", async () => {
    const ready = await withTimeout(expectMessage(
      (message) => message.type === "automation_service_ready",
      "ready",
    ), TIMEOUT_MS, "ready");
    expect(typeof ready.pid).toBe("number");

    send({
      id: "create-1",
      method: "create",
      params: {
        input: {
          type: "interval",
          schedule: "1h",
          intervalSeconds: 3600,
          prompt: "integration test",
          enabled: true,
          model: { provider: "", model: "" },
          toolPolicyProfile: "read-only",
          sessionId: "automation-manual",
        },
      },
    });
    const created = await withTimeout(next(), TIMEOUT_MS, "create");
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;

    send({ id: "run-1", method: "run_now", params: { taskId } });
    const request = await withTimeout(expectMessage(
      (message) => message.type === "automation_run_request",
      "run request",
    ), TIMEOUT_MS, "run request");
    expect((request.task as { id?: string }).id).toBe(taskId);

    send({
      type: "automation_run_result",
      requestId: request.requestId,
      ok: true,
      sessionId: "session-integration",
    });

    // run result 的结算和 run_now RPC 应答异步完成：轮询 list 直到历史落账。
    const deadline = Date.now() + TIMEOUT_MS;
    let task: { id: string; runCount: number; runHistory?: Array<{ status: string }> } | undefined;
    while (Date.now() < deadline) {
      send({ id: `list-${Date.now()}`, method: "list" });
      const listed = await withTimeout(next(), TIMEOUT_MS, "list");
      expect(listed.ok).toBe(true);
      const tasks = listed.data as Array<{
        id: string;
        runCount: number;
        runHistory?: Array<{ status: string }>;
      }>;
      task = tasks.find((row) => row.id === taskId);
      if (task && task.runCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(task?.runCount).toBe(1);
    expect(task?.runHistory?.some((entry) => entry.status === "success")).toBe(true);
  }, TIMEOUT_MS + 2_000);
});
