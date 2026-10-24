/**
 * 全局搜索 e2e：真进程直跑 sidecar（本地存储模式，无宿主），经 stdio NDJSON
 * 驱动完整链路 —— 建会话 / 写转录 / 放产物与资料库文件 / git 仓库，然后验证
 * 标题、正文、产物、资料库、项目五域命中，以及 %/_ 转义、归档可见性、
 * aroundSeq 居中窗、搜索历史、截断后重对账、派活不阻塞。
 *
 * 为什么必须 e2e：这些行为跨 sidecar ↔ SQLite ↔ 文件系统三层，单测只能覆盖
 * 抽取函数与 SQL 片段；"重建索引的时机""归档会话是否仍可搜""截断后旧内容
 * 是否还命中"只有真进程跑一遍才算数。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CLEANUPS: string[] = [];
afterAll(() => {
  for (const dir of CLEANUPS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清扫失败非致命 */
    }
  }
});

type Frame = Record<string, unknown>;

/** 极简协议客户端：按 id 配对应答，其余帧收进 backlog 供调试 */
class SidecarHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiters = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void }>();
  private backlog: Frame[] = [];
  private stderrTail = "";
  private seq = 0;

  async start(cwd: string): Promise<void> {
    const entry = join(import.meta.dir, "..", "..", "src", "index.ts");
    this.child = spawn(process.execPath, [entry], {
      cwd,
      env: {
        ...process.env,
        // 无 PI_SESSIONS_DIR ⇒ 本地 SQLite 模式（initStorage），会话落 <cwd>/sessions
        PI_DB_PATH: join(cwd, "state.db"),
        PI_TASK_CWD: join(cwd, "task-workspace"),
        PI_LIBRARY_ROOT: join(cwd, "library"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    // 等就绪：第一条自发帧（pi_restarted）之后协议才算能收命令
    await this.waitSelfEmitted("pi_restarted", 20_000);
  }

  stop(): void {
    try {
      this.child?.kill();
    } catch {
      /* 已退出 */
    }
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
        continue; // 非 JSON 行（诊断输出）忽略
      }
      const id = typeof frame.id === "string" ? frame.id : undefined;
      if (id) {
        const waiter = this.waiters.get(id);
        if (waiter) {
          this.waiters.delete(id);
          waiter.resolve(frame);
        }
        continue;
      }
      this.backlog.push(frame);
      const type = frame.type;
      if (typeof type === "string") {
        const waiter = this.waiters.get(`self:${type}`);
        if (waiter) {
          this.waiters.delete(`self:${type}`);
          waiter.resolve(frame);
        }
      }
    }
  }

  private waitSelfEmitted(type: string, timeoutMs: number): Promise<Frame> {
    const hit = this.backlog.find((f) => f.type === type);
    if (hit) return Promise.resolve(hit);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(`self:${type}`);
        reject(new Error(`timed out waiting self frame ${type}\nstderr:\n${this.stderrTail}`));
      }, timeoutMs);
      this.waiters.set(`self:${type}`, {
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject,
      });
    });
  }

  send(payload: Record<string, unknown>, timeoutMs = 25_000): Promise<Frame> {
    const id = `e2e-${++this.seq}`;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(
          new Error(
            `timed out: ${String(payload.type)} id=${id}\nstderr:\n${this.stderrTail}`,
          ),
        );
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: (f) => {
          clearTimeout(timer);
          if (f.type === "error") {
            reject(new Error(`${String(payload.type)} failed: ${String(f.errorText)}`));
          } else {
            resolve(f);
          }
        },
        reject,
      });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }
}

/** 写一段最小合法转录（header + message 行）；返回 sessionId */
function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: { seq: number; role: string; text: string }[],
): void {
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "header", schema: 1, id: sessionId, cwd: "/tmp/e2e" }),
    ...messages.map((m) =>
      JSON.stringify({
        type: "message",
        seq: m.seq,
        ui: null,
        agent: {
          role: m.role,
          // assistant 的 content 必须是块数组（pi-ai Message 契约）：裸字符串会被
          // 索引器按字符迭代，抽不出任何文本
          content: m.role === "assistant" ? [{ type: "text", text: m.text }] : m.text,
          timestamp: 0,
        },
      }),
    ),
  ];
  if (existsSync(file)) {
    appendFileSync(file, `${lines.slice(1).join("\n")}\n`);
  } else {
    writeFileSync(file, `${lines.join("\n")}\n`);
  }
}

describe("全局搜索 e2e（真进程）", () => {
  test("五域命中 + 转义 + 归档 + 居中窗 + 历史 + 截断重对账", async () => {
    const root = mkdtempSync(join(tmpdir(), "kova-search-e2e-"));
    CLEANUPS.push(root);
    const sessionsDir = join(root, "sessions");
    const harness = new SidecarHarness();
    await harness.start(root);

    try {
      // ---------- 建会话 ----------
      const created = await harness.send({ type: "new_session", threadId: "e2e-thread" });
      const sessionId = String(created.sessionId);
      expect(sessionId.length).toBeGreaterThan(0);

      // 标题含 % 与 _：同时测 LIKE 转义（曾经这两类查询零命中）
      await harness.send({
        type: "rename_session",
        sessionId,
        name: "折扣 100% 与 my_var 会话",
      });

      // 转录：100 条消息（aroundSeq 需要足够长的窗；内容含多组关键词）
      writeTranscript(
        sessionsDir,
        sessionId,
        Array.from({ length: 100 }, (_, i) => ({
          seq: i + 1,
          role: i % 2 === 0 ? "user" : "assistant",
          text:
            i === 9
              ? "我们把前后端跑起来吧 100% 完成"
              : i === 49
                ? "my_var 定义在部署脚本里"
                : `第 ${i + 1} 条普通消息`,
        })),
      );

      // ---------- 产物 / 资料库 / 项目 ----------
      const taskDir = join(root, "task-workspace", sessionId);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, "部署手册.md"), "# 部署手册\nsqlite 迁移步骤");

      const libDir = join(root, "library");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, "资料.md"), "资料库里的独有关键词");

      const projDir = join(root, "proj");
      mkdirSync(projDir, { recursive: true });
      execSync("git init --quiet", { cwd: projDir });
      writeFileSync(join(projDir, "app.ts"), "const NEEDLE_CODE = 1;\n");
      execSync("git add .", { cwd: projDir });
      execSync('git -c user.email=e2e@t -c user.name=e2e commit --quiet -m init', {
        cwd: projDir,
      });

      // ---------- 1) 正文命中（含工具输出之外的普通消息） ----------
      const content = await harness.send({ type: "search", query: "跑起来" });
      const messages = content.messages as {
        sessionId: string;
        seq: number;
        preview: string;
      }[];
      expect(messages.some((m) => m.sessionId === sessionId && m.seq === 10)).toBe(true);
      expect(messages.find((m) => m.seq === 10)?.preview).toContain("跑起来");

      // ---------- 2) % / _ 转义回归（标题 + 正文双路） ----------
      const pct = await harness.send({ type: "search", query: "100%" });
      expect((pct.sessions as { sessionId: string }[]).some((s) => s.sessionId === sessionId)).toBe(true);
      expect((pct.messages as { sessionId: string }[]).some((m) => m.sessionId === sessionId)).toBe(true);

      const underscore = await harness.send({ type: "search", query: "my_var" });
      expect(
        (underscore.sessions as { sessionId: string }[]).some((s) => s.sessionId === sessionId),
      ).toBe(true);
      expect(
        (underscore.messages as { sessionId: string }[]).some((m) => m.sessionId === sessionId),
      ).toBe(true);

      // ---------- 3) 产物文件（内容命中，归属本会话） ----------
      const artifact = await harness.send({ type: "search", query: "部署手册" });
      const artifactHits = artifact.artifacts as {
        sessionId: string;
        rel: string;
        preview: string;
      }[];
      const own = artifactHits.find((a) => a.sessionId === sessionId && a.rel === "部署手册.md");
      expect(own).toBeDefined();
      expect(own!.preview).toContain("sqlite");

      // ---------- 4) 资料库文件（__library__ 哨兵归属） ----------
      const library = await harness.send({ type: "search", query: "独有关键词" });
      expect(
        (library.artifacts as { sessionId: string; rel: string }[]).some(
          (a) => a.sessionId === "__library__" && a.rel === "资料.md",
        ),
      ).toBe(true);

      // ---------- 5) 项目域（git grep 优先，带行号） ----------
      const project = await harness.send({
        type: "search",
        query: "NEEDLE_CODE",
        projectCwd: projDir,
      });
      const projectResult = project.project as {
        files: { rel: string }[];
        contents: { rel: string; line: number; preview: string }[];
      };
      expect(projectResult.contents.some((c) => c.rel === "app.ts" && c.line === 1)).toBe(true);
      expect(projectResult.files.some((f) => f.rel === "app.ts")).toBe(true);

      // ---------- 6) aroundSeq 居中窗（100 条消息，锚 seq=50） ----------
      const history = await harness.send({
        type: "get_history",
        sessionId,
        tail: 10,
        aroundSeq: 50,
      });
      // 锚 = 最后一条 seq<=50 的消息（index 49），half=5 → 窗 [45..54]
      expect(history.firstSeq).toBe(45);
      expect(history.lastSeq).toBe(54);
      expect((history.messages as unknown[]).length).toBe(10);

      // ---------- 7) 搜索历史：添加 → 默认页可见 → 清空 ----------
      await harness.send({ type: "search_history_add", query: "跑起来" });
      const def = await harness.send({ type: "search_default", limit: 10 });
      expect(
        (def.history as { query: string }[]).some((h) => h.query === "跑起来"),
      ).toBe(true);
      await harness.send({ type: "search_history_clear" });
      const cleared = await harness.send({ type: "search_default", limit: 10 });
      expect((cleared.history as unknown[]).length).toBe(0);

      // ---------- 8) 归档会话仍可搜（archived 标记透出） ----------
      await harness.send({ type: "archive_session", sessionId, archived: true });
      // 正文命中仍在（消息组），且标题命中带 archived=true（归档只是列表隐藏）
      const archivedMessages = await harness.send({ type: "search", query: "跑起来" });
      expect(
        (archivedMessages.messages as { sessionId: string }[]).some(
          (m) => m.sessionId === sessionId,
        ),
      ).toBe(true);
      // 「100%」同时命中标题（sessions 组）与正文——用它验 archived 标记
      const archivedTitles = await harness.send({ type: "search", query: "100%" });
      const archivedSessionHit = (
        archivedTitles.sessions as { sessionId: string; archived: boolean }[]
      ).find((s) => s.sessionId === sessionId);
      expect(archivedSessionHit?.archived).toBe(true);

      // ---------- 9) 截断后重对账：被截掉的内容不再命中 ----------
      await harness.send({ type: "truncate_session", sessionId, beforeSeq: 10 });
      const afterTruncate = await harness.send({ type: "search", query: "跑起来" });
      expect(
        (afterTruncate.messages as { sessionId: string; seq: number }[]).some(
          (m) => m.sessionId === sessionId && m.seq === 10,
        ),
      ).toBe(false);
      // 保留段（seq 1..8）里的内容仍在
      const kept = await harness.send({ type: "search", query: "普通消息" });
      expect(
        (kept.messages as { sessionId: string; seq: number }[]).some(
          (m) => m.sessionId === sessionId,
        ),
      ).toBe(true);

      // ---------- 10) 派活不阻塞：search 与 list_sessions 背靠背都能回 ----------
      const [searchReply, listReply] = await Promise.all([
        harness.send({ type: "search", query: "普通消息" }),
        harness.send({ type: "list_sessions" }),
      ]);
      expect(searchReply.type).toBe("search_result");
      expect(listReply.type).toBe("sessions");
    } finally {
      harness.stop();
    }
  }, 120_000);
});
