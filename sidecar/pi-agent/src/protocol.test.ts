import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage, db, sessionPath } from "./storage";
import { dispatch, dispatchPrompt } from "./protocol";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-protocol-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
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
    const row = db
      .query<{ title: string }, [string]>(
        "SELECT title FROM pi_sessions WHERE id = ?",
      )
      .get(sessionId)!;
    expect(row.title).toBe("My Chat");
  });

  test("list_sessions only includes sessions with messages", async () => {
    const withMsgs = "seeded-session";
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO pi_sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
    ).run(withMsgs, tmp, now, now);
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

    await dispatch("s4", { type: "list_sessions" });
    const res = last();
    expect(res.type).toBe("sessions");
    const sessions = res.sessions as { sessionId: string; messageCount: number }[];
    const seeded = sessions.find((s) => s.sessionId === withMsgs)!;
    expect(seeded.messageCount).toBe(2);
    // "My Chat" 会话还没有消息，不出现
    expect(sessions.find((s) => s.sessionId !== withMsgs)).toBeUndefined();
  });

  test("delete_session removes row and file", async () => {
    await dispatch("s5", { type: "delete_session", sessionId: "seeded-session" });
    expect(last()).toEqual({ id: "s5", type: "deleted" });
    expect(existsSync(sessionPath("seeded-session"))).toBe(false);
    expect(
      db.query("SELECT id FROM pi_sessions WHERE id = ?").get("seeded-session"),
    ).toBeNull();
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

describe("dispatchPrompt", () => {
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
    const res = last();
    expect((res.chunk as { type: string }).type).toBe("error");
    expect((res.chunk as { errorText: string }).errorText).toContain("session not found");
  });
});
