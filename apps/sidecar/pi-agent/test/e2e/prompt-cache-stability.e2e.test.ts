/**
 * 提示词缓存稳定性 e2e：真 sidecar 进程 + 本地 mock OpenAI 兼容端点。
 *
 * 场景：两轮普通对话，中间通过协议 add_project_dir 增加一个外部项目目录。
 * 断言：
 * 1. 两轮主请求的首条 system 消息逐字节一致（externalDirs 段没有触发整体重写）；
 * 2. 日期提示与外部目录更新都以隐藏 user 消息（[[capability-reminder]]）投递；
 * 3. 首条 system 里既没有日期也没有外部目录（两者都不再进静态前缀）；
 * 4. 第二轮没有重复投递日期（同一天只发一次）。
 *
 * 为什么必须 e2e：这跨 protocol → resolveSession → Agent 请求体 → provider
 * 序列化四层，单测只能验证 syncRunPrompt 的状态机；"真实请求体里的 system
 * 字节是否一致"只有真进程跑一遍才算数。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Frame = Record<string, unknown>;
type Captured = { body: Record<string, unknown> };

const CLEANUPS: string[] = [];
const servers: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterAll(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of CLEANUPS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清扫失败非致命 */
    }
  }
});

/** 最小 OpenAI Chat Completions SSE mock：记录请求体，回复一条 stop 文本。 */
function startMockProvider(): Promise<{ baseUrl: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { raw };
      }
      requests.push({ body });
      const model = typeof body.model === "string" ? body.model : "mock-model";
      const id = `chatcmpl-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "ok" }, null))}\n\n`);
      res.write(
        `data: ${JSON.stringify(
          chunk({}, "stop", {
            prompt_tokens: 1_000,
            completion_tokens: 1,
            total_tokens: 1_001,
          }),
        )}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}/v1`, requests });
    });
  });
}

/** 最小 sidecar 协议客户端：按 id 取命令应答，prompt 等 finish chunk。 */
class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private frames: Frame[] = [];
  private stderrTail = "";
  private seq = 0;
  private waiters = new Set<() => void>();

  async start(cwd: string): Promise<void> {
    const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
    this.child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        // 无 PI_SESSIONS_DIR ⇒ 本地 SQLite 模式
        PI_DB_PATH: join(cwd, "state.db"),
        PI_TASK_CWD: join(cwd, "task-workspace"),
        PI_LIBRARY_ROOT: join(cwd, "library"),
        PI_LOG_LEVEL: "error",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(this.child);
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    await this.waitFor(
      (frame) => frame.type === "pi_restarted",
      20_000,
      "pi_restarted",
    );
  }

  private onStdout(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue;
      }
      this.frames.push(frame);
      for (const wake of this.waiters) wake();
    }
  }

  private waitFor(
    predicate: (frame: Frame) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Frame> {
    const hit = this.frames.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(
          new Error(
            `timed out waiting ${label}\nlast frames:\n${JSON.stringify(
              this.frames.slice(-20),
            )}\nstderr:\n${this.stderrTail}`,
          ),
        );
      }, timeoutMs);
      const wake = () => {
        const found = this.frames.find(predicate);
        if (!found) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(found);
      };
      this.waiters.add(wake);
    });
  }

  private send(payload: Record<string, unknown>): string {
    const id = `e2e-${++this.seq}`;
    this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    return id;
  }

  async command(payload: Record<string, unknown>): Promise<Frame> {
    const id = this.send(payload);
    const frame = await this.waitFor(
      (f) => f.id === id && !("chunk" in f),
      25_000,
      `${String(payload.type)} response`,
    );
    if (frame.type === "error") {
      throw new Error(`${String(payload.type)} failed: ${String(frame.errorText)}`);
    }
    return frame;
  }

  async prompt(input: {
    threadId: string;
    sessionId: string;
    cwd: string;
    text: string;
  }): Promise<void> {
    const id = this.send({ type: "prompt", ...input });
    const frame = await this.waitFor(
      (f) => f.id === id && (f.chunk as { type?: string } | undefined)?.type === "finish",
      30_000,
      `prompt finish (${input.text})`,
    );
    if (frame.type === "error") {
      throw new Error(`prompt failed: ${String(frame.errorText)}`);
    }
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          (part as { type?: string } | undefined)?.type === "text",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
};

const messagesOf = (body: Record<string, unknown>): { role?: string; content?: unknown }[] =>
  Array.isArray(body.messages)
    ? (body.messages as { role?: string; content?: unknown }[])
    : [];

const systemOf = (body: Record<string, unknown>): string =>
  textOf(messagesOf(body).find((message) => message.role === "system")?.content);

const userTextsOf = (body: Record<string, unknown>): string[] =>
  messagesOf(body)
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));

describe("提示词缓存稳定性 e2e", () => {
  test("外部目录变化后首条 system 不变，更新走隐藏尾部消息", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "kova-prompt-cache-e2e-")));
    CLEANUPS.push(root);
    const workspace = join(root, "workspace");
    const external = join(root, "external");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(external, { recursive: true });

    const mock = await startMockProvider();
    const harness = new SidecarHarness();
    await harness.start(root);

    // 注册本地 mock provider，并把全局默认模型指过去
    const added = await harness.command({
      type: "add_custom_provider",
      name: "mock",
      baseUrl: mock.baseUrl,
      apiKey: "test-key",
      api: "openai-chat",
      models: [
        {
          id: "mock-model",
          name: "Mock Model",
          contextWindow: 200_000,
          maxTokens: 8_192,
        },
      ],
    });
    const provider = String(added.provider ?? "");
    expect(provider).toBeTruthy();
    await harness.command({
      type: "set_model",
      provider,
      modelId: "mock-model",
    });

    const threadId = "e2e-cache-thread";
    const created = await harness.command({
      type: "new_session",
      threadId,
      cwd: workspace,
    });
    const sessionId = String(created.sessionId ?? "");
    expect(sessionId).toBeTruthy();
    await harness.prompt({ threadId, sessionId, cwd: workspace, text: "first" });

    // 两轮之间加一个外部项目目录：这正是曾经导致首条 system 整体重写的路径
    await harness.command({
      type: "add_project_dir",
      cwd: workspace,
      path: external,
    });
    await harness.prompt({ threadId, sessionId, cwd: workspace, text: "second" });

    // AGENTS.md 是第三段动态事实：同样不应改写首条 system
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "# Project rules\nUse tabs, not spaces.\n",
      "utf8",
    );
    await harness.prompt({ threadId, sessionId, cwd: workspace, text: "third" });

    // 标题总结是独立 one-shot 请求（无 tools），不是主对话请求
    const mainRequests = mock.requests
      .map((entry) => entry.body)
      .filter((body) => Array.isArray(body.tools) && body.tools.length > 0);
    expect(mainRequests.length).toBeGreaterThanOrEqual(3);
    const [first, second, third] = mainRequests;

    // 1) 首条 system 字节不变
    expect(systemOf(second)).toBe(systemOf(first));
    // 2) 日期不在静态前缀里；首轮以隐藏消息投递
    expect(systemOf(first)).not.toContain("Today's date is");
    expect(userTextsOf(first).some((text) => text.includes("Today's date is"))).toBe(true);
    // 3) 外部目录变化走隐藏尾部更新，不进 system
    expect(userTextsOf(second).some((text) => text.includes('"external directories"'))).toBe(true);
    expect(userTextsOf(second).some((text) => text.includes(external))).toBe(true);
    expect(systemOf(second)).not.toContain(external);
    // 4) 同一天不重复投递日期（第二轮与第一轮的历史日期消息数量一致）
    expect(
      userTextsOf(second).filter((text) => text.includes("Today's date is")).length,
    ).toBe(userTextsOf(first).filter((text) => text.includes("Today's date is")).length);
    // 5) AGENTS.md 变化走尾部更新，system 仍逐字节不变
    expect(systemOf(third)).toBe(systemOf(first));
    expect(
      userTextsOf(third).some((text) => text.includes('"project instructions"')),
    ).toBe(true);
    expect(
      userTextsOf(third).some((text) => text.includes("Use tabs, not spaces.")),
    ).toBe(true);
    expect(
      userTextsOf(third).filter((text) => text.includes("Today's date is")).length,
    ).toBe(1);
  }, 60_000);
});
