import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, sessionPath } from "../../src/storage/storage";
import {
  sessionInsert,
  sessionGet,
  sessionRename,
  sessionTouch,
  getLocalDb,
  modelsReplace,
} from "../../src/storage/hostdb";
import { dispatch, dispatchPrompt, handleLine, setInitGate } from "../../src/protocol/protocol";
import { rulesFilePath, soulFilePath } from "../../src/agent/personalization";
import { dropRun, ensureTaskSessionDir, noteActiveTurn, resolveSession, running, trackSessionRun } from "../../src/sessions/sessions";
import { setActiveReqId } from "../../src/protocol/stream";
import { scanTranscript } from "../../src/sessions/transcript";
import {
  registerCustomProvider,
  setCurrentModelKey,
  setCurrentThinkingLevel,
} from "../../src/model/model-catalog";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-protocol-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  // set_personalization 会写身份文件：钉到临时目录，避免触碰开发者真实 ~/.kova/
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
});

/** 捕获协议流（send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
});

afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

const last = (): Record<string, unknown> =>
  JSON.parse(lines[lines.length - 1]);

describe("dispatch: basic commands", () => {
  test("ping answers pong", async () => {
    await dispatch("p1", { type: "ping" });
    expect(last()).toEqual({ id: "p1", type: "pong" });
  });

  test("unknown type yields an error response", async () => {
    await dispatch("p2", { type: "nope" });
    expect(last()).toEqual({
      id: "p2",
      type: "error",
      errorText: "unknown message type: nope",
      // §8 加性归因字段：未知命令是本地路由错，不可重试
      error: { code: "UNKNOWN_MESSAGE_TYPE", source: "runtime", retryable: false },
    });
  });

  test("abort without id is accepted", async () => {
    await dispatch("p3", { type: "abort" }); // 无活动会话，不应抛错
  });

  test("turn 起止广播 turn_changed；list_running 反映在跑会话与请求 id", async () => {
    await dispatch("lr0", { type: "list_running" });
    expect(last()).toEqual({ id: "lr0", type: "running", sessionIds: [], turns: [] });

    noteActiveTurn("th-turn", true, "sess-A", "run-1");
    // 双广播（设计文档 §2）：旧 turn_changed 保留一版本周期 + 新 session_state
    expect(lines[lines.length - 2] && JSON.parse(lines[lines.length - 2])).toEqual({
      type: "turn_changed",
      sessionId: "sess-A",
      active: true,
    });
    const started = last();
    expect(started).toMatchObject({
      type: "session_state",
      sessionId: "sess-A",
      phase: "running",
    });
    expect(typeof started.eventSeq).toBe("number");
    await dispatch("lr1", { type: "list_running" });
    expect(last()).toEqual({
      id: "lr1",
      type: "running",
      sessionIds: ["sess-A"],
      // turns：会话与请求 id 齐备的明细，供前端 webview 存储丢失时重建在飞流登记
      turns: [{ sessionId: "sess-A", requestId: "run-1" }],
    });

    // 收尾不带 sessionId：从登记里取（广播成对）
    noteActiveTurn("th-turn", false);
    expect(lines[lines.length - 2] && JSON.parse(lines[lines.length - 2])).toEqual({
      type: "turn_changed",
      sessionId: "sess-A",
      active: false,
    });
    const ended = last();
    expect(ended).toMatchObject({ type: "session_state", sessionId: "sess-A", phase: "idle" });
    // 水印单调（§3）：同会话两帧连号
    expect(ended.eventSeq).toBe((started.eventSeq as number) + 1);
    await dispatch("lr2", { type: "list_running" });
    expect(last()).toEqual({ id: "lr2", type: "running", sessionIds: [], turns: [] });
  });

  test("缺请求 id 的轮次不入 turns（sessionIds 仍反映）", async () => {
    noteActiveTurn("th-norid", true, "sess-B"); // 不带 requestId
    await dispatch("lr4", { type: "list_running" });
    expect(last()).toEqual({
      id: "lr4",
      type: "running",
      sessionIds: ["sess-B"],
      turns: [],
    });
    noteActiveTurn("th-norid", false);
  });

  test("会话未定的轮次不广播、不出现在 list_running", async () => {
    const before = lines.length;
    noteActiveTurn("th-anon", true); // 无 sessionId 且非常驻会话
    await dispatch("lr3", { type: "list_running" });
    expect(last()).toEqual({ id: "lr3", type: "running", sessionIds: [], turns: [] });
    noteActiveTurn("th-anon", false);
    // 仅 list_running 响应行，无 turn_changed
    expect(lines.length).toBe(before + 1);
  });
});

describe("dispatch: sessions", () => {
  let sessionId = "";

  test("new_session creates an index row and JSONL header", async () => {
    await dispatch("s1", { type: "new_session", threadId: "th1", cwd: tmp });
    const res = last();
    expect(res.type).toBe("session");
    expect(res.threadId).toBe("th1");
    sessionId = res.sessionId as string;
    expect(existsSync(sessionPath(sessionId))).toBe(true);
    const header = JSON.parse(readFileSync(sessionPath(sessionId), "utf8"));
    expect(header.type).toBe("header");
    expect(header.cwd).toBe(tmp);
  });

  test("get_history returns empty for a fresh session", async () => {
    await dispatch("s2", { type: "get_history", sessionId });
    // M2 新增应答字段（§4 pending / §6 窗口元数据）：空会话全量窗
    expect(last()).toEqual({
      id: "s2",
      type: "history",
      messages: [],
      pending: [],
      firstSeq: null,
      lastSeq: null,
      hasMore: false,
    });
  });

  test("M2：交互行回放 + list_pending + tail 分页", async () => {
    const interaction = {
      interactionId: "ap-x",
      kind: "permission",
      anchorToolCallId: "tc-x",
      payload: { approvalId: "ap-x", toolCallId: "tc-x", toolName: "bash", input: null },
      createdAt: "2026-09-22T00:00:00.000Z",
    };
    appendFileSync(
      sessionPath(sessionId),
      [
        JSON.stringify({ type: "message", seq: 0, agent: { role: "user", content: "旧问题" } }),
        JSON.stringify({ type: "message", seq: 1, agent: { role: "user", content: "新问题" } }),
        JSON.stringify({ type: "pending_interaction", interaction }),
        JSON.stringify({ type: "pending_interaction", interaction: { ...interaction, interactionId: "ap-gone" } }),
        JSON.stringify({
          type: "interaction_resolved",
          interactionId: "ap-gone",
          resolution: "approved",
          resolvedAt: "x",
        }),
      ].join("\n") + "\n",
    );

    await dispatch("h1", { type: "get_history", sessionId });
    let res = last();
    expect((res.messages as unknown[]).length).toBe(2);
    expect(res.pending).toEqual([interaction]); // 已结算的 ap-gone 配对剔除
    expect(res.firstSeq).toBe(0);
    expect(res.lastSeq).toBe(1);
    expect(res.hasMore).toBe(false);

    // 分页窗：tail=1 只回尾部一条，元数据如实
    await dispatch("h2", { type: "get_history", sessionId, tail: 1 });
    res = last();
    expect((res.messages as unknown[]).length).toBe(1);
    expect(res).toMatchObject({ firstSeq: 1, lastSeq: 1, hasMore: true });

    // list_pending：按会话权威拉取，不依赖驻留；按线程未绑定 → 空表
    await dispatch("lp1", { type: "list_pending", sessionId });
    expect(last()).toEqual({ id: "lp1", type: "pending", items: [interaction] });
    await dispatch("lp2", { type: "list_pending", threadId: "thread-never-bound" });
    expect(last()).toEqual({ id: "lp2", type: "pending", items: [] });
  });

  test("rename_session updates the title", async () => {
    await dispatch("s3", { type: "rename_session", sessionId, name: "My Chat" });
    expect(last()).toEqual({ id: "s3", type: "renamed" });
    const row = getLocalDb()!
      .query<{ title: string }, [string]>(
        "SELECT title FROM sessions WHERE id = ?",
      )
      .get(sessionId)!;
    expect(row.title).toBe("My Chat");
    // §6 M4：改名先落转录 session_info 行（真值），索引 title 列退为投影
    expect(scanTranscript(sessionId).name).toBe("My Chat");
  });

  test("list_sessions only includes sessions with messages", async () => {
    const withMsgs = "seeded-session";
    const now = new Date().toISOString();
    await sessionInsert(withMsgs, tmp);
    writeFileSync(
      sessionPath(withMsgs),
      JSON.stringify({ type: "header", schema: 1, id: withMsgs, cwd: tmp, created_at: now }) +
        "\n" +
        JSON.stringify({ type: "message", seq: 0, ui: {}, agent: {} }) +
        "\n" +
        JSON.stringify({ type: "message", seq: 1, ui: {}, agent: {} }) +
        "\n",
      "utf8",
    );
    // 迭代 4 不变式：消息行只会经 persist 落盘并随 session_touch 计入索引；
    // 测试直接造文件时补一次 touch 等价还原该不变式
    await sessionTouch(withMsgs, "", "", 2);

    await dispatch("s4", { type: "list_sessions" });
    const res = last();
    expect(res.type).toBe("sessions");
    const sessions = res.sessions as { sessionId: string; messageCount: number }[];
    const seeded = sessions.find((s) => s.sessionId === withMsgs)!;
    expect(seeded.messageCount).toBe(2);
    // "My Chat" 会话还没有消息，不出现
    expect(sessions.find((s) => s.sessionId !== withMsgs)).toBeUndefined();
  });

  test("archive_session toggles the flag and list_sessions reports it", async () => {
    const id = "archived-session";
    const now = new Date().toISOString();
    await sessionInsert(id, tmp);
    writeFileSync(
      sessionPath(id),
        JSON.stringify({ type: "header", schema: 1, id, cwd: tmp, created_at: now }) +
        "\n" +
        JSON.stringify({ type: "message", seq: 0, ui: {}, agent: {} }) +
        "\n",
      "utf8",
    );
    await sessionTouch(id, "", "", 1); // 同上：直接造文件需补 touch 维持计数不变式

    await dispatch("sa0", { type: "list_sessions" });
    let sessions = last().sessions as { sessionId: string; archived?: boolean }[];
    expect(sessions.find((s) => s.sessionId === id)?.archived).toBe(false);

    await dispatch("sa1", { type: "archive_session", sessionId: id, archived: true });
    expect(last()).toEqual({ id: "sa1", type: "archived" });
    await dispatch("sa2", { type: "list_sessions" });
    sessions = last().sessions as { sessionId: string; archived?: boolean }[];
    expect(sessions.find((s) => s.sessionId === id)?.archived).toBe(true);

    await dispatch("sa3", { type: "archive_session", sessionId: id, archived: false });
    await dispatch("sa4", { type: "list_sessions" });
    sessions = last().sessions as { sessionId: string; archived?: boolean }[];
    expect(sessions.find((s) => s.sessionId === id)?.archived).toBe(false);
  });

  test("fork_session 复制转录与索引行为新会话（分支对话）", async () => {
    const srcId = "fork-source";
    const now = new Date().toISOString();
    await sessionInsert(srcId, tmp);
    writeFileSync(
      sessionPath(srcId),
      JSON.stringify({ type: "header", schema: 1, id: srcId, cwd: tmp, created_at: now }) +
        "\n" +
        JSON.stringify({ type: "message", seq: 0, ui: {}, agent: {} }) +
        "\n" +
        JSON.stringify({ type: "compaction", seq: 1, summary: "s", tokensBefore: 1, throughSeq: 0, createdAt: now }) +
        "\n" +
        // §6 M4 设定行：不占 seq，验证不进分支复制（新会话按全局/偏好默认打开）
        JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt-4o", timestamp: now }) +
        "\n" +
        JSON.stringify({ type: "session_info", name: "设定命名", timestamp: now }) +
        "\n" +
        JSON.stringify({ type: "message", seq: 2, ui: {}, agent: {} }) +
        "\n" +
        "{ 撕裂的尾行",
      "utf8",
    );
    await sessionTouch(srcId, "", "", 2);
    await sessionRename(srcId, "原始标题");

    await dispatch("fk1", { type: "fork_session", sessionId: srcId });
    const res = last();
    expect(res.type).toBe("forked");
    const newId = res.sessionId as string;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(srcId);

    // 新 JSONL：header 换新 id/cwd，数据行原样复制（compaction 行保留、seq 不变），
    // 撕裂尾行与设定行不进分支（本期文件复制行为不变，§6）
    const forkLines = readFileSync(sessionPath(newId), "utf8").trim().split("\n");
    expect(forkLines).toHaveLength(4);
    expect(JSON.parse(forkLines[0])).toMatchObject({
      type: "header",
      id: newId,
      cwd: tmp,
      parentSession: srcId, // fork 溯源（§6 M4）：上游 header 同名可选字段，值取源会话 id
    });
    expect(JSON.parse(forkLines[1])).toMatchObject({ type: "message", seq: 0 });
    expect(JSON.parse(forkLines[2])).toMatchObject({ type: "compaction", seq: 1 });
    expect(JSON.parse(forkLines[3])).toMatchObject({ type: "message", seq: 2 });
    const forkScan = scanTranscript(newId);
    expect(forkScan.model).toBeNull();
    expect(forkScan.name).toBeNull();

    // 索引行：标题加「（分支）」后缀；message_count 只按实拷消息行计
    const row = getLocalDb()!
      .query<{ title: string; message_count: number }, [string]>(
        "SELECT title, message_count FROM sessions WHERE id = ?",
      )
      .get(newId)!;
    expect(row.title).toBe("原始标题（分支）");
    expect(row.message_count).toBe(2);
  });

  test("fork_session 源会话不存在时报错", async () => {
    await expect(
      dispatch("fk2", { type: "fork_session", sessionId: "fork-nope" }),
    ).rejects.toThrow("session not found: fork-nope");
  });

  test("delete_session removes row and file", async () => {
    await dispatch("s5", { type: "delete_session", sessionId: "seeded-session" });
    expect(last()).toEqual({ id: "s5", type: "deleted" });
    expect(existsSync(sessionPath("seeded-session"))).toBe(false);
    expect(await sessionGet("seeded-session")).toBeNull();
  });

  test("未选目录建的会话，后续请求带 cwd 时补绑（修复代码写到主目录）", async () => {
    const threadId = "th-rebind";
    // 建会话时不带 cwd：运行 cwd 兜底任务工作区下的会话子目录
    // （<PI_TASK_CWD>/<sessionId>，按会话隔离产物），持久化 cwd 为空
    const taskCwd = path.join(tmp, "task-cwd");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("rb1", { type: "new_session", threadId });
      const sessionId = last().sessionId as string;
      const run = running.get(threadId)!;
      expect(run.cwd).toBe(path.join(taskCwd, sessionId));
      expect(run.persistedCwd).toBe("");

      // 用户选了工作目录后的任意请求（这里用 context_info 走同一条 resolveSession）
      const workspace = path.join(tmp, "workspace");
      await dispatch("rb2", { type: "context_info", threadId, sessionId, cwd: workspace });

      // 内存 run：运行 cwd/持久化 cwd 都换过去，工具与系统提示词已按新 cwd 重建
      expect(run.cwd).toBe(workspace);
      expect(run.persistedCwd).toBe(workspace);
      expect(run.agent.state.tools.length).toBeGreaterThan(0);
      expect(run.agent.state.systemPrompt).toContain(workspace);
      // DB 索引行与 JSONL header 同步回写
      expect((await sessionGet(sessionId))!.cwd).toBe(workspace);
      const header = JSON.parse(readFileSync(sessionPath(sessionId), "utf8"));
      expect(header.cwd).toBe(workspace);

      // 已绑定目录的会话不再被后续 cwd 改动（换目录开新会话是前端职责）
      await dispatch("rb3", {
        type: "context_info",
        threadId,
        sessionId,
        cwd: path.join(tmp, "other"),
      });
      expect(run.persistedCwd).toBe(workspace);
    } finally {
      delete process.env.PI_TASK_CWD;
    }
  });

  test("无目录会话按会话子目录隔离，互不覆盖", async () => {
    const taskCwd = path.join(tmp, "task-isolated");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("iso1", { type: "new_session", threadId: "th-iso-a" });
      const idA = last().sessionId as string;
      await dispatch("iso2", { type: "new_session", threadId: "th-iso-b" });
      const idB = last().sessionId as string;
      const runA = running.get("th-iso-a")!;
      const runB = running.get("th-iso-b")!;
      expect(runA.cwd).toBe(path.join(taskCwd, idA));
      expect(runB.cwd).toBe(path.join(taskCwd, idB));
      expect(runA.cwd).not.toBe(runB.cwd);
      // 解析阶段只算路径、不建目录：此刻还没有任何东西要落盘（启动时的草稿
      // 线程也走这一步，无条件建就是空壳目录）。真正落盘在轮初，见下面那条用例。
      expect(existsSync(runA.cwd)).toBe(false);
      expect(existsSync(runB.cwd)).toBe(false);
    } finally {
      delete process.env.PI_TASK_CWD;
    }
  });

  test("任务工作区目录推迟到轮初落盘，解析阶段不建空壳", async () => {
    const taskCwd = path.join(tmp, "task-lazy");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("lz1", { type: "new_session", threadId: "th-lazy" });
      const sessionId = last().sessionId as string;
      const run = running.get("th-lazy")!;
      expect(existsSync(run.cwd)).toBe(false);
      // 轮初 ensure 之后目录才在——agent 真要往里写产物时它必须存在
      ensureTaskSessionDir(run);
      expect(existsSync(run.cwd)).toBe(true);
      // 幂等：重复调用不报错、不换目录
      ensureTaskSessionDir(run);
      expect(existsSync(run.cwd)).toBe(true);
      // 自选了工作目录的会话不该被凭空多建一个任务目录
      const withCwd = running.get("th-lazy")!;
      withCwd.cwd = tmp;
      ensureTaskSessionDir(withCwd);
      expect(existsSync(path.join(taskCwd, sessionId))).toBe(true);
    } finally {
      delete process.env.PI_TASK_CWD;
    }
  });

  test("delete_session 连同产物子目录递归删除", async () => {
    const taskCwd = path.join(tmp, "task-del");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("ds1", { type: "new_session", threadId: "th-del" });
      const sessionId = last().sessionId as string;
      const dir = path.join(taskCwd, sessionId);
      // 目录由轮初/产物写入时落盘（解析阶段不建），这里直接摆出待删的产物
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "out.txt"), "artifact");
      await dispatch("ds2", { type: "delete_session", sessionId });
      expect(last()).toEqual({ id: "ds2", type: "deleted" });
      expect(await sessionGet(sessionId)).toBeNull();
      expect(existsSync(dir)).toBe(false);
    } finally {
      delete process.env.PI_TASK_CWD;
    }
  });
});

describe("dispatch: context_info / compact", () => {
  let sessionId = "";

  test("context_info 返回完整读数（无凭据环境：占位模型，零消息零用量）", async () => {
    await dispatch("x1", { type: "new_session", threadId: "th-ctx", cwd: tmp });
    sessionId = last().sessionId as string;
    await dispatch("x2", {
      type: "context_info",
      threadId: "th-ctx",
      sessionId,
    });
    const res = last() as Record<string, unknown>;
    expect(res.type).toBe("context_info");
    // 无凭据时 state.model 是占位模型（unknown），容量走兜底常量
    expect(res.model).not.toBeNull();
    expect(res.contextWindow).toBeGreaterThan(0);
    expect(res.hardLimit).toBeGreaterThan(0);
    expect(res.messageTokens).toBe(0);
    expect(res.systemPromptTokens).toBeGreaterThan(0); // 模式系统提示词总在
    expect(res.generation).toBe(0);
    expect(res.needsCompaction).toBe(false);
    expect(res.cacheHitRate).toBeNull();
    expect(res.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("compact 空上下文被拒绝（错误经 dispatch 上抛）", async () => {
    await expect(
      dispatch("x3", { type: "compact", threadId: "th-ctx", sessionId }),
    ).rejects.toThrow("No new context is available to compact");
  });
});

describe("dispatch: credentials", () => {
  test("set/list/delete roundtrip", async () => {
    await dispatch("c1", { type: "set_credential", provider: "prov-x", apiKey: "sk-x" });
    expect(last()).toEqual({ id: "c1", type: "credential", provider: "prov-x" });

    await dispatch("c2", { type: "list_credentials" });
    const res = last();
    expect(res.type).toBe("credentials");
    expect((res.credentials as { providerId: string }[]).map((c) => c.providerId)).toContain("prov-x");

    await dispatch("c3", { type: "delete_credential", provider: "prov-x" });
    expect(last()).toEqual({ id: "c3", type: "credential_deleted", provider: "prov-x" });
  });

  test("set_credential validates input", async () => {
    await expect(
      dispatch("c4", { type: "set_credential", provider: "", apiKey: "k" }),
    ).rejects.toThrow("provider and apiKey are required");
  });
});

describe("dispatch: 删除 provider 后的全局选中键", () => {
  const add = (providerId: string, name: string) => ({
    type: "add_custom_provider",
    providerId,
    name,
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: `sk-${providerId}`,
    api: "openai-chat",
    models: [{ id: `${providerId}-m1` }],
  });

  test("删掉挂着全局键的 provider：键改指别的可用模型，不清成 null", async () => {
    const { getCurrentModelKey } = await import("../../src/model/model-catalog");
    const { kvGet } = await import("../../src/storage/hostdb");

    await dispatch("r1", add("custom-repoint-b", "留下"));
    await dispatch("r2", add("custom-repoint-a", "删掉"));
    setCurrentModelKey({ provider: "custom-repoint-a", modelId: "custom-repoint-a-m1" });

    await dispatch("r3", { type: "delete_custom_provider", provider: "custom-repoint-a" });

    // 清成 null 会让所有「没有会话级记忆」的会话同时变成未选择（它们显示的
    // 就是这一个全局值），且与 sidecar 发送时实际回落的模型分叉
    const key = getCurrentModelKey();
    expect(key).not.toBeNull();
    expect(key!.provider).not.toBe("custom-repoint-a");
    // kv 同步落新键：否则重启后 initCurrentModelKey 把已删 provider 读回来
    const row = await kvGet("pi.model");
    expect(JSON.parse(row!.value as string)).toEqual(key);

    // 收尾：把测试建的 provider 也删掉，别漏进后续用例的目录
    await dispatch("r4", { type: "delete_custom_provider", provider: "custom-repoint-b" });
  });

  test("删的不是当前选中 provider：全局键原样不动", async () => {
    const { getCurrentModelKey } = await import("../../src/model/model-catalog");
    await dispatch("r5", add("custom-repoint-c", "另一个"));
    await dispatch("r6", add("custom-repoint-d", "当前"));
    setCurrentModelKey({ provider: "custom-repoint-d", modelId: "custom-repoint-d-m1" });

    await dispatch("r7", { type: "delete_custom_provider", provider: "custom-repoint-c" });
    expect(getCurrentModelKey()).toEqual({
      provider: "custom-repoint-d",
      modelId: "custom-repoint-d-m1",
    });

    await dispatch("r8", { type: "delete_custom_provider", provider: "custom-repoint-d" });
  });
});

describe("dispatch: provider key masking", () => {
  const KEY = "sk-secret-abcdef999";
  const addMsg = (apiKey: string) => ({
    type: "add_custom_provider",
    providerId: "custom-mask",
    name: "掩码测试",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey,
    api: "openai-chat",
    models: [{ id: "m1" }],
  });

  test("list_custom_providers 只回掩码；空 key 保存保留原凭据", async () => {
    await dispatch("k1", addMsg(KEY));
    expect(last()).toEqual({ id: "k1", type: "custom_provider", provider: "custom-mask" });

    await dispatch("k2", { type: "list_custom_providers" });
    let row = ((last() as Record<string, unknown>).providers as Record<string, unknown>[]).find(
      (p) => p.providerId === "custom-mask",
    )!;
    expect(row.hasApiKey).toBe(true);
    expect(row.apiKeyMasked).toBe("****f999");
    expect(row.apiKey).toBeUndefined(); // 明文不再回传渲染进程

    // 编辑保存时 key 留空 = 保持原凭据
    await dispatch("k3", addMsg(""));
    await dispatch("k4", { type: "list_custom_providers" });
    row = ((last() as Record<string, unknown>).providers as Record<string, unknown>[]).find(
      (p) => p.providerId === "custom-mask",
    )!;
    expect(row.apiKeyMasked).toBe("****f999");

    await dispatch("k5", { type: "delete_custom_provider", provider: "custom-mask" });
    expect(last()).toEqual({ id: "k5", type: "custom_provider_deleted", provider: "custom-mask" });
  });

  test("test_provider/fetch_models 空 key + providerId 取已存凭据", async () => {
    await dispatch("k6", addMsg(KEY));
    let authHeader = "";
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        authHeader = req.headers.get("authorization") ?? "";
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [{ id: "m1" }] });
        }
        return Response.json({ choices: [{ message: { role: "assistant", content: "pong" } }] });
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}/v1`;
      await dispatch("k7", {
        type: "test_provider",
        baseUrl: base,
        apiKey: "",
        providerId: "custom-mask",
        api: "openai-chat",
        model: "m1",
      });
      expect(last()).toEqual({ id: "k7", type: "tested", ok: true });
      expect(authHeader).toBe(`Bearer ${KEY}`);

      await dispatch("k8", {
        type: "fetch_models",
        baseUrl: base,
        apiKey: "",
        providerId: "custom-mask",
        api: "openai-chat",
      });
      expect(last()).toEqual({ id: "k8", type: "fetched_models", models: ["m1"] });
      expect(authHeader).toBe(`Bearer ${KEY}`);
    } finally {
      srv.stop(true);
      await dispatch("k9", { type: "delete_custom_provider", provider: "custom-mask" });
    }
  });
});

describe("dispatch: models", () => {
  test("set_model rejects unknown models", async () => {
    await expect(
      dispatch("m1", { type: "set_model", provider: "ghost", modelId: "nope" }),
    ).rejects.toThrow("model not found: ghost/nope");
  });

  test("get/set provider filter roundtrip", async () => {
    await dispatch("m2", {
      type: "set_provider_filter",
      provider: "prov-filter",
      models: ["a", "b", "a"],
    });
    expect(last()).toEqual({ id: "m2", type: "provider_filter", provider: "prov-filter", models: ["a", "b"] });

    await dispatch("m3", { type: "get_provider_filter", provider: "prov-filter" });
    expect(last()).toEqual({ id: "m3", type: "provider_filter", provider: "prov-filter", models: ["a", "b"] });

    // 空数组清除过滤
    await dispatch("m4", { type: "set_provider_filter", provider: "prov-filter", models: [] });
    expect(last()).toEqual({ id: "m4", type: "provider_filter", provider: "prov-filter", models: null });
  });

  test("list_models responds with catalogs and providers", async () => {
    await dispatch("m5", { type: "list_models" });
    const res = last();
    expect(res.type).toBe("models");
    expect(Array.isArray(res.models)).toBe(true);
    expect((res.providers as { id: string }[]).length).toBeGreaterThan(0);
  });
});

describe("dispatch: thinking", () => {
  test("set_thinking echoes the level", async () => {
    await dispatch("t1", { type: "set_thinking", level: "medium" });
    expect(last()).toEqual({ id: "t1", type: "thinking", level: "medium" });
    await dispatch("t2", { type: "set_thinking", level: "off" });
    expect(last()).toEqual({ id: "t2", type: "thinking", level: "off" });
  });

  test("set_thinking rejects unknown levels", async () => {
    await expect(
      dispatch("t3", { type: "set_thinking", level: "ultra" }),
    ).rejects.toThrow("unknown thinking level: ultra");
    await expect(
      dispatch("t4", { type: "set_thinking" }),
    ).rejects.toThrow("unknown thinking level: ");
  });
});

describe("dispatch: thinking maps", () => {
  test("set_thinking_maps counts clean entries and drops garbage", async () => {
    await dispatch("tm1", {
      type: "set_thinking_maps",
      maps: { "p/m": { off: "none", minimal: null } },
    });
    expect(last()).toEqual({ id: "tm1", type: "thinking_maps", applied: 1 });

    // 非字符串非 null 值与未知键被清洗掉 → 整条 map 为空不计入
    await dispatch("tm2", {
      type: "set_thinking_maps",
      maps: { "p/m": { off: 42, bogus: "x" } },
    });
    expect(last()).toEqual({ id: "tm2", type: "thinking_maps", applied: 0 });

    await dispatch("tm3", { type: "set_thinking_maps" });
    expect(last()).toEqual({ id: "tm3", type: "thinking_maps", applied: 0 });
  });
});

describe("dispatch: todo state", () => {
  test("get_todo_state reports an empty list for a fresh session", async () => {
    await dispatch("td1", { type: "new_session", threadId: "th-todo", cwd: tmp });
    const sessionId = last().sessionId as string;
    await dispatch("td2", {
      type: "get_todo_state",
      threadId: "th-todo",
      sessionId,
    });
    expect(last()).toEqual({
      id: "td2",
      type: "todo_state",
      tasks: [],
      nextId: 1,
    });
  });

  test("get_todo_state without thread or sessionId rejects", async () => {
    await expect(
      dispatch("td3", { type: "get_todo_state", threadId: "ghost-thread" }),
    ).rejects.toThrow("session not found: ghost-thread");
  });
});

describe("dispatchPrompt", () => {
  // 测试环境的网络失败会命中自动重试预算（最长 ~80s），关闭重试让
  // 「单次失败即回 error chunk」的旧语义保持可测
  const prevRetryMax = process.env.PI_PROVIDER_RETRY_MAX;
  beforeAll(() => {
    process.env.PI_PROVIDER_RETRY_MAX = "0";
  });
  afterAll(() => {
    if (prevRetryMax === undefined) delete process.env.PI_PROVIDER_RETRY_MAX;
    else process.env.PI_PROVIDER_RETRY_MAX = prevRetryMax;
  });

  // 无凭据时 Agent 可能注入默认模型然后流式失败，也可能命中无模型守卫——
  // 两种路径最终都会给请求回一个 error chunk
  test("emits an error chunk when no usable model is configured", async () => {
    await dispatchPrompt("pp1", { type: "prompt", text: "hi", threadId: "th-prompt" });
    const errorChunk = lines
      .map((l) => JSON.parse(l) as { id: string; chunk: { type: string; error?: { code?: string; source?: string; retryable?: boolean } } })
      .find((l) => l.id === "pp1" && l.chunk?.type === "error");
    expect(errorChunk).toBeDefined();
    // §8 归因随帧：具体 code 取决于本环境走到哪条失败路径（前序测试留下的默认
    // 模型可能让轮次进流式失败而非无模型守卫），只锁归因形状
    const attribution = errorChunk!.chunk.error!;
    expect(typeof attribution.code).toBe("string");
    expect(["provider", "network", "runtime", "tool"].includes(attribution.source ?? "")).toBe(true);
    expect(typeof attribution.retryable).toBe("boolean");
  });

  test("pushes a stamped context_changed row after the turn settles", async () => {
    // pp1 已让 th-prompt 物化会话并跑完（失败）轮；收尾 finally 推 §7 读数帧。
    // 读数取值随本环境模型注入与否变（无模型时阈值 0、cacheHitRatio null），
    // 只锁帧形与非负性
    const frame = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.type === "context_changed");
    expect(frame).toBeDefined();
    expect(typeof frame!.sessionId).toBe("string");
    expect((frame!.sessionId as string).length).toBeGreaterThan(0);
    expect(typeof frame!.eventSeq).toBe("number");
    expect(frame!.usedTokens).toBeGreaterThanOrEqual(0);
    expect(frame!.threshold).toBeGreaterThanOrEqual(0);
    expect(frame!.contextWindow).toBeGreaterThanOrEqual(0);
    expect(frame!.cacheHitRatio === null || typeof frame!.cacheHitRatio === "number").toBe(true);
  });

  test("errors for a missing session id", async () => {
    const ctxBefore = lines.filter((l) => l.includes('"context_changed"')).length;
    await dispatchPrompt("pp2", { type: "prompt", text: "hi", sessionId: "ghost-session" });
    // 不可用 last()：turn 收尾的 turn_changed 行在 error chunk 之后写出
    const res = [...lines]
      .reverse()
      .map((l) => JSON.parse(l) as { id?: string; chunk?: { type: string; errorText?: string } })
      .find((l) => l.id === "pp2" && l.chunk)!.chunk!;
    expect(res.type).toBe("error");
    expect(res.errorText).toContain("session not found");
    // §7：resolveSession 失败的轮没有 run，收尾不推上下文帧
    expect(lines.filter((l) => l.includes('"context_changed"')).length).toBe(ctxBefore);
  });

  // 崩溃隔离：会话准备段（agent 开跑之前）抛错时，turn 的内层 finally 还没接管。
  // 那种情况下若没有隔离层，消息流永远收不到 finish —— AI SDK 的 status 停在
  // streaming、Stop 失灵、线程看着一直忙，automation runner 更是永远等不到
  // onOutcome。这里用「任务工作区目录被一个同名普通文件占住」把 ensureTaskSessionDir
  // 的 mkdir 顶成 ENOTDIR/EEXIST，模拟真实准备段抛错。
  test("pre-agent crash still terminates the stream with an error", async () => {
    const base = path.join(tmp, "task-ws-crash");
    mkdirSync(base, { recursive: true });
    const prevTaskCwd = process.env.PI_TASK_CWD;
    process.env.PI_TASK_CWD = base;
    try {
      await dispatch("cx0", { type: "new_session", threadId: "th-crash" });
      const sessionId = last().sessionId as string;
      // 占位：同名路径是文件不是目录 → mkdirSync(recursive) 必抛
      writeFileSync(path.join(base, sessionId), "not-a-dir");

      const outcomes: { ok: boolean; errorText?: string }[] = [];
      await dispatchPrompt(
        "cx1",
        { type: "prompt", text: "hi", threadId: "th-crash", sessionId },
        (o) => outcomes.push(o),
      );

      const mine = lines
        .map((l) => JSON.parse(l) as { id?: string; chunk?: { type: string; errorText?: string } })
        .filter((l) => l.id === "cx1" && l.chunk)
        .map((l) => l.chunk!);
      expect(mine.some((c) => c.type === "error")).toBe(true);
      // 关键断言：流必须有终止帧，否则 UI 永远转圈
      expect(mine.some((c) => c.type === "finish")).toBe(true);
      // onOutcome 必须回调，否则无人值守 runner 永久挂起
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.ok).toBe(false);
      expect(outcomes[0]!.errorText).toBeTruthy();
    } finally {
      if (prevTaskCwd === undefined) delete process.env.PI_TASK_CWD;
      else process.env.PI_TASK_CWD = prevTaskCwd;
    }
  });
});

describe("dispatch: get_model / init gate", () => {
  test("get_model returns an empty selection before any set_model", async () => {
    await dispatch("gm0", { type: "get_model" });
    expect(last()).toEqual({ id: "gm0", type: "model", provider: "", modelId: "" });
  });

  test("set_model/get_model roundtrip via a custom provider", async () => {
    await modelsReplace("proto-p", [{ modelId: "m1", enabled: true }]);
    await registerCustomProvider({
      id: "proto-p",
      name: "Proto P",
      baseUrl: "https://p.io",
      api: "openai-chat",
    });
    await dispatch("gm1", { type: "set_credential", provider: "proto-p", apiKey: "sk-p" });
    await dispatch("gm2", { type: "set_model", provider: "proto-p", modelId: "m1" });
    expect(last()).toEqual({ id: "gm2", type: "model", provider: "proto-p", modelId: "m1" });
    await dispatch("gm3", { type: "get_model" });
    expect(last()).toEqual({ id: "gm3", type: "model", provider: "proto-p", modelId: "m1" });
    setCurrentModelKey(null); // 清理：不留全局选择
  });

  test("set_model/set_thinking 给驻留会话落设定行（§6 M4 转录=真值）", async () => {
    const sid = "m4-resident";
    await sessionInsert(sid, tmp);
    // 最小驻留 run：handler 只用 sessionId/mode/cwd/agent.state 四个面
    // （0.99：restamp 会改写转录首条 system 消息，fake state 需带 messages）
    const fakeRun = {
      sessionId: sid,
      mode: "agent",
      cwd: tmp,
      agent: { state: { messages: [] } },
    } as unknown as Running;
    running.set(sid, fakeRun);
    trackSessionRun(sid, sid);
    try {
      // 会话定靶（对话页选择器形态）：设定行只落被点名的会话
      await dispatch("m4a", { type: "set_model", provider: "proto-p", modelId: "m1", sessionId: sid });
      expect(last()).toEqual({ id: "m4a", type: "model", provider: "proto-p", modelId: "m1" });
      await dispatch("m4b", { type: "set_thinking", level: "high" });
      const scan = scanTranscript(sid);
      expect(scan.model).toEqual({ provider: "proto-p", modelId: "m1" });
      expect(scan.thinkingLevel).toBe("high");
      // 设定行不占 seq、不带消息
      expect(scan.messages).toEqual([]);
      // 既有语义不变：驻留 Agent 即时改写 + 应答帧照发
      expect(fakeRun.agent.state.model?.provider).toBe("proto-p");
      expect(fakeRun.agent.state.thinkingLevel).toBe("high");
    } finally {
      dropRun(sid);
      setCurrentModelKey(null);
      setCurrentThinkingLevel("off");
    }
  });

  test("set_model 定靶只改被点名会话，其余驻留会话不动（A 切模型 B 不跟着变）", async () => {
    const sidA = "sm-target-a";
    const sidB = "sm-other-b";
    await sessionInsert(sidA, tmp);
    await sessionInsert(sidB, tmp);
    // B 的 run 带自身哨兵模型：定靶 A 时必须原样不动（旧广播实现会盖成 A 的新模型）
    const sentinel = { provider: "sentinel", id: "keep", name: "keep", api: "openai-chat", baseUrl: "", reasoning: false, input: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 };
    const runA = {
      sessionId: sidA,
      mode: "agent",
      cwd: tmp,
      agent: { state: { messages: [] } },
    } as unknown as Running;
    const runB = {
      sessionId: sidB,
      mode: "agent",
      cwd: tmp,
      agent: { state: { model: sentinel, messages: [] } },
    } as unknown as Running;
    running.set(sidA, runA);
    trackSessionRun(sidA, sidA);
    running.set(sidB, runB);
    trackSessionRun(sidB, sidB);
    try {
      await dispatch("sm1", { type: "set_model", provider: "proto-p", modelId: "m1", sessionId: sidA });
      // A：live run 改写 + 转录真值行 + 偏好列落库
      expect(runA.agent.state.model?.provider).toBe("proto-p");
      expect(scanTranscript(sidA).model).toEqual({ provider: "proto-p", modelId: "m1" });
      expect((await sessionGet(sidA))?.modelProvider).toBe("proto-p");
      // B：run 不动、不落行、偏好列仍空
      expect(runB.agent.state.model).toBe(sentinel);
      expect(scanTranscript(sidB).model).toBeNull();
      expect((await sessionGet(sidB))?.modelProvider).toBeNull();

      // 无 sessionId = 全局默认变更：只即时刷从未显式选过模型的驻留 run（B 跟随），
      // 已有自身选择的 A 保持不动；且全局变更不给任何会话落行
      await dispatch("sm2", { type: "set_model", provider: "proto-p", modelId: "m1" });
      expect(runB.agent.state.model?.provider).toBe("proto-p");
      expect(runA.agent.state.model?.provider).toBe("proto-p");
      expect(scanTranscript(sidB).model).toBeNull();
    } finally {
      dropRun(sidA);
      dropRun(sidB);
      setCurrentModelKey(null);
    }
  });

  test("set_model rejects a sessionId that is not a known session", async () => {
    await expect(
      dispatch("smx", { type: "set_model", provider: "proto-p", modelId: "m1", sessionId: "ghost-session" }),
    ).rejects.toThrow(/session not found/);
  });

  test("commands arriving before the init gate are buffered", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setInitGate(gate);
    try {
      handleLine(JSON.stringify({ type: "ping", id: "gate-1" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // 闸门未放行：不应有任何 gate-1 响应
      expect(lines.some((line) => line.includes('"gate-1"'))).toBe(false);
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(last()).toEqual({ id: "gate-1", type: "pong" });
    } finally {
      setInitGate(Promise.resolve()); // 还原闸门，避免影响其他测试
    }
  });
});

describe("dispatch: personalization", () => {
  const DEFAULT_SETTINGS = {
    style: "default",
    styles: [] as { id: string; name: string; prompt: string }[],
    styleOverrides: [] as {
      id: string;
      name: string;
      prompt: string;
      hidden: boolean;
    }[],
    userName: "",
    assistantName: "",
    persona: "",
    customInstructions: "",
  };

  test("get_personalization returns the current settings", async () => {
    await dispatch("pe0", { type: "set_personalization", settings: DEFAULT_SETTINGS });
    await dispatch("pe1", { type: "get_personalization" });
    expect(last()).toEqual({
      id: "pe1",
      type: "personalization",
      settings: DEFAULT_SETTINGS,
      paths: { soul: soulFilePath(), rules: rulesFilePath() },
    });
  });

  test("set_personalization persists to kv and hot-swaps active session prompts", async () => {
    await dispatch("pe2", { type: "new_session", threadId: "th-pers", cwd: tmp });
    const run = running.get("th-pers")!;
    expect(run.agent.state.systemPrompt).not.toContain("Reply style - professional");

    const settings = {
      style: "professional",
      styles: [],
      styleOverrides: [],
      userName: "老王",
      assistantName: "",
      persona: "",
      customInstructions: "先结论后细节",
    };
    await dispatch("pe3", { type: "set_personalization", settings });
    expect(last()).toEqual({
      id: "pe3",
      type: "personalization",
      settings,
      paths: { soul: soulFilePath(), rules: rulesFilePath() },
    });

    // 活动会话热替换：无需重建 Agent，下一轮请求即生效
    expect(run.agent.state.systemPrompt).toContain("Reply style - professional");
    expect(run.agent.state.systemPrompt).toContain('The user goes by "老王".');
    expect(run.agent.state.systemPrompt).toContain("always apply): 先结论后细节");

    // 整包 JSON 落 kv 表（本地模式镜像）
    const row = getLocalDb()!
      .query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'pi.personalization'")
      .get()!;
    expect(JSON.parse(row.value)).toMatchObject({ style: "professional", userName: "老王" });

    // 恢复默认：提示词不再含个性化段
    await dispatch("pe4", { type: "set_personalization", settings: DEFAULT_SETTINGS });
    expect(run.agent.state.systemPrompt).not.toContain("Reply style - professional");
  });

  test("自定义风格：set 携带 styles + style=custom:<id>，get 回读并热注入用户 prompt", async () => {
    await dispatch("pe5", { type: "new_session", threadId: "th-pers2", cwd: tmp });
    const run = running.get("th-pers2")!;
    const custom = [{ id: "s1", name: "文艺", prompt: "文风偏文学，善用比喻" }];
    await dispatch("pe6", {
      type: "set_personalization",
      settings: { ...DEFAULT_SETTINGS, style: "custom:s1", styles: custom },
    });
    expect(last()).toMatchObject({
      type: "personalization",
      settings: { style: "custom:s1", styles: custom },
    });
    // 活动会话提示词热注入自定义风格的原始 prompt 文本
    expect(run.agent.state.systemPrompt).toContain("Reply style - 文艺: 文风偏文学，善用比喻");

    // 删掉被选中的自定义风格后（style 悬空），apply 回落 default、提示词清空该段
    await dispatch("pe7", {
      type: "set_personalization",
      settings: { ...DEFAULT_SETTINGS, style: "custom:s1", styles: [] },
    });
    expect((last() as { settings: { style: string } }).settings.style).toBe("default");
    expect(run.agent.state.systemPrompt).not.toContain("Reply style - 文艺");

    // 复位默认，避免污染后续用例
    await dispatch("pe8", { type: "set_personalization", settings: DEFAULT_SETTINGS });
  });

  test("内置档覆盖：set 写 styleOverrides.prompt 覆盖并热注入，恢复默认后回落内置文案", async () => {
    await dispatch("pe9", { type: "new_session", threadId: "th-pers3", cwd: tmp });
    const run = running.get("th-pers3")!;
    expect(run.agent.state.systemPrompt).not.toContain("Reply style - professional");

    // 覆盖内置 professional 档：注入自定义文案而非内置默认
    const overrides = [
      { id: "professional", name: "", prompt: "只输出结论，禁止解释。", hidden: false },
    ];
    await dispatch("pe10", {
      type: "set_personalization",
      settings: { ...DEFAULT_SETTINGS, style: "professional", styleOverrides: overrides },
    });
    expect((last() as { settings: { styleOverrides: unknown[] } }).settings.styleOverrides).toEqual(
      overrides,
    );
    expect(run.agent.state.systemPrompt).toContain("只输出结论，禁止解释。");
    expect(run.agent.state.systemPrompt).not.toContain("be precise, structured");

    // 恢复默认（清空 styleOverrides）→ 回落内置 professional 文案
    await dispatch("pe11", {
      type: "set_personalization",
      settings: { ...DEFAULT_SETTINGS, style: "professional", styleOverrides: [] },
    });
    expect(run.agent.state.systemPrompt).toContain("be precise, structured");
    expect(run.agent.state.systemPrompt).not.toContain("只输出结论，禁止解释。");

    await dispatch("pe12", { type: "set_personalization", settings: DEFAULT_SETTINGS });
  });
});

describe("dispatch: memory", () => {
  const DEFAULT_MEMORY = {
    enabled: false,
    global: true,
    workspace: true,
    fileSearch: true,
    enabledFiles: { global: null, workspace: null },
  };

  test("get/set_memory 往返，set 落 kv 并热替换活动会话提示词", async () => {
    await dispatch("me0", { type: "get_memory" });
    expect(last()).toEqual({ id: "me0", type: "memory", settings: DEFAULT_MEMORY });

    await dispatch("me1", {
      type: "set_memory",
      settings: { ...DEFAULT_MEMORY, enabled: true },
    });
    expect(last()).toEqual({
      id: "me1",
      type: "memory",
      settings: { ...DEFAULT_MEMORY, enabled: true },
    });
    const row = getLocalDb()!
      .query<{ value: string }, []>("SELECT value FROM kv WHERE key = 'pi.memory'")
      .get()!;
    expect(JSON.parse(row.value)).toMatchObject({ enabled: true });

    // 新会话的系统提示词带上记忆引导段（总开关开启、目录无文件时的最小引导）
    await dispatch("me2", { type: "new_session", threadId: "th-mem", cwd: tmp });
    const run = running.get("th-mem")!;
    expect(run.agent.state.systemPrompt).toContain("## Memory");

    // 恢复关闭：提示词不再含记忆段
    await dispatch("me3", { type: "set_memory", settings: DEFAULT_MEMORY });
    expect(run.agent.state.systemPrompt).not.toContain("## Memory");
  });

  test("list_memory_files 返回两作用域目录；未带 cwd 时 workspace 为 null", async () => {
    type Scopes = {
      global: { dir: string };
      workspace: { dir: string } | null;
    };
    await dispatch("me4", { type: "list_memory_files" });
    const bare = last() as { type: string; scopes: Scopes };
    expect(bare.type).toBe("memory_files");
    expect(bare.scopes.workspace).toBeNull();

    await dispatch("me5", { type: "list_memory_files", cwd: tmp });
    const res = last() as { type: string; scopes: Scopes };
    expect(res.scopes.global.dir).toContain("memory");
    expect(res.scopes.workspace!.dir).toBe(path.join(tmp, ".kova", "memory"));
  });

  test("read/write_memory_file：写后可读、清单带 mtime、写后热替换提示词", async () => {
    await dispatch("me6", {
      type: "write_memory_file",
      scope: "workspace",
      cwd: tmp,
      file: "MEMORY.md",
      content: "#preference [[ui]] Settings page stays file-centric.",
    });
    expect(last()).toMatchObject({
      type: "memory_file_saved",
      scope: "workspace",
      file: "MEMORY.md",
    });

    await dispatch("me7", {
      type: "read_memory_file",
      scope: "workspace",
      cwd: tmp,
      file: "MEMORY.md",
    });
    const read = last() as { type: string; content: string };
    expect(read.type).toBe("memory_file");
    expect(read.content).toContain("file-centric");

    // 清单条目带修改时间
    await dispatch("me8", { type: "list_memory_files", cwd: tmp });
    const files = (last() as { scopes: { workspace: { files: { name: string; mtime: number }[] } } })
      .scopes.workspace.files;
    const entry = files.find((f) => f.name === "MEMORY.md")!;
    expect(entry.mtime).toBeGreaterThan(0);

    // 路径穿越与非法名报错（dispatch 抛错由 handleLine 统一包成 error 响应）
    await expect(
      dispatch("me9", {
        type: "read_memory_file",
        scope: "workspace",
        cwd: tmp,
        file: "../../secrets.md",
      }),
    ).rejects.toThrow("memory file not found");
  });
});

describe("set_session_cwd：对话中途换/清工作目录", () => {
  test("驻留会话换绑→解绑回落任务工作区；索引行与 header 同步", async () => {
    const taskCwd = path.join(tmp, "task-cwd-switch");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("sc1", { type: "new_session", threadId: "th-cwd-1" });
      const sessionId = last().sessionId as string;
      const run = running.get("th-cwd-1")!;

      // 换绑到真实目录：内存 run、DB 索引行、JSONL header 三处一致
      const workspace = path.join(tmp, "workspace-switch");
      await dispatch("sc2", { type: "set_session_cwd", sessionId, cwd: workspace });
      expect(last()).toMatchObject({ id: "sc2", type: "session_cwd_set", sessionId, cwd: workspace });
      expect(run.cwd).toBe(workspace);
      expect(run.persistedCwd).toBe(workspace);
      expect(run.agent.state.systemPrompt).toContain(workspace);
      expect((await sessionGet(sessionId))!.cwd).toBe(workspace);
      expect(JSON.parse(readFileSync(sessionPath(sessionId), "utf8").split("\n")[0])).toMatchObject({
        cwd: workspace,
      });

      // 解绑（cwd=""）：持久化清空、运行目录回落按会话隔离的任务子目录
      await dispatch("sc3", { type: "set_session_cwd", sessionId, cwd: "" });
      expect(run.persistedCwd).toBe("");
      expect(run.cwd).toBe(path.join(taskCwd, sessionId));
      expect(existsSync(run.cwd)).toBe(true);
      expect((await sessionGet(sessionId))!.cwd).toBe("");
      expect(JSON.parse(readFileSync(sessionPath(sessionId), "utf8").split("\n")[0])).toMatchObject({ cwd: "" });
    } finally {
      delete process.env.PI_TASK_CWD;
    }
  });

  test("本轮在跑时拒绝，目录不动", async () => {
    await dispatch("sc4", { type: "new_session", threadId: "th-cwd-2", cwd: tmp });
    const sessionId = last().sessionId as string;
    setActiveReqId("th-cwd-2", "req-cwd-busy");
    try {
      await expect(
        dispatch("sc5", { type: "set_session_cwd", sessionId, cwd: path.join(tmp, "elsewhere") }),
      ).rejects.toThrow("session is busy");
      expect(running.get("th-cwd-2")!.persistedCwd).toBe(tmp);
      expect((await sessionGet(sessionId))!.cwd).toBe(tmp);
    } finally {
      setActiveReqId("th-cwd-2", null);
    }
    dropRun("th-cwd-2");
  });

  test("不驻留会话只写索引行与 header，下次物化自然生效", async () => {
    const taskCwd = path.join(tmp, "task-cwd-evicted");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("sc6", { type: "new_session", threadId: "th-cwd-3" });
      const sessionId = last().sessionId as string;
      dropRun("th-cwd-3");
      const workspace = path.join(tmp, "workspace-late");
      await dispatch("sc7", { type: "set_session_cwd", sessionId, cwd: workspace });
      expect(running.has("th-cwd-3")).toBe(false);
      expect((await sessionGet(sessionId))!.cwd).toBe(workspace);
      // 重新物化：按新索引行装配，运行 cwd 即换绑后的目录
      const revived = await resolveSession("th-cwd-3b", sessionId);
      expect(revived.cwd).toBe(workspace);
      expect(revived.persistedCwd).toBe(workspace);
      dropRun("th-cwd-3b");
    } finally {
      delete process.env.PI_TASK_CWD;
    }
  });

  test("会话不存在报错", async () => {
    await expect(
      dispatch("sc8", { type: "set_session_cwd", sessionId: "cwd-nope", cwd: tmp }),
    ).rejects.toThrow("session not found: cwd-nope");
  });
});
