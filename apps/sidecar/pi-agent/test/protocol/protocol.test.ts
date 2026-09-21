import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
import { noteActiveTurn, running } from "../../src/sessions/sessions";
import { registerCustomProvider, setCurrentModelKey } from "../../src/model/model-catalog";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-protocol-"));
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  // set_personalization 会写身份文件：钉到临时目录，避免触碰开发者真实 ~/.xulux/
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
    });
  });

  test("abort without id is accepted", async () => {
    await dispatch("p3", { type: "abort" }); // 无活动会话，不应抛错
  });

  test("turn 起止广播 turn_changed；list_running 反映在跑会话与请求 id", async () => {
    await dispatch("lr0", { type: "list_running" });
    expect(last()).toEqual({ id: "lr0", type: "running", sessionIds: [], turns: [] });

    noteActiveTurn("th-turn", true, "sess-A", "run-1");
    expect(last()).toEqual({ type: "turn_changed", sessionId: "sess-A", active: true });
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
    expect(last()).toEqual({ type: "turn_changed", sessionId: "sess-A", active: false });
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
    expect(last()).toEqual({ id: "s2", type: "history", messages: [] });
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
    // 撕裂尾行不进分支
    const forkLines = readFileSync(sessionPath(newId), "utf8").trim().split("\n");
    expect(forkLines).toHaveLength(4);
    expect(JSON.parse(forkLines[0])).toMatchObject({ type: "header", id: newId, cwd: tmp });
    expect(JSON.parse(forkLines[1])).toMatchObject({ type: "message", seq: 0 });
    expect(JSON.parse(forkLines[2])).toMatchObject({ type: "compaction", seq: 1 });
    expect(JSON.parse(forkLines[3])).toMatchObject({ type: "message", seq: 2 });

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
    // 建会话时不带 cwd：运行 cwd 兜底任务工作目录（PI_TASK_CWD），持久化 cwd 为空
    const taskCwd = path.join(tmp, "task-cwd");
    process.env.PI_TASK_CWD = taskCwd;
    try {
      await dispatch("rb1", { type: "new_session", threadId });
      const sessionId = last().sessionId as string;
      const run = running.get(threadId)!;
      expect(run.cwd).toBe(taskCwd);
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
      .map((l) => JSON.parse(l) as { id: string; chunk: { type: string } })
      .find((l) => l.id === "pp1" && l.chunk?.type === "error");
    expect(errorChunk).toBeDefined();
  });

  test("errors for a missing session id", async () => {
    await dispatchPrompt("pp2", { type: "prompt", text: "hi", sessionId: "ghost-session" });
    // 不可用 last()：turn 收尾的 turn_changed 行在 error chunk 之后写出
    const res = [...lines]
      .reverse()
      .map((l) => JSON.parse(l) as { id?: string; chunk?: { type: string; errorText?: string } })
      .find((l) => l.id === "pp2" && l.chunk)!.chunk!;
    expect(res.type).toBe("error");
    expect(res.errorText).toContain("session not found");
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
    expect(res.scopes.workspace!.dir).toBe(path.join(tmp, ".xulux", "memory"));
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
