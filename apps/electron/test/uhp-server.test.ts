import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  UhpDiscovery,
  UhpFile,
  UhpHarness,
  UhpResponse,
  UhpStreamEvent,
} from "uhp-protocol";
import type { UhpBridge } from "../main/uhp/types";

/**
 * Integration test for the UHP HTTP surface. Uses an in-memory store + fake
 * pi-agent bridge so it runs without Electron/SQLite/model credentials.
 */

type ResponseRecord = UhpResponse & {
  sessionId: string;
  cwd: string;
  threadId: string;
  harnessId: string;
  requestId: string;
  inputItems: unknown;
  persisted: boolean;
  createdAtMs: number;
  updatedAtMs: number;
};

type SessionRecord = {
  id: string;
  harnessId: string;
  kovaSessionId: string;
  threadId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

type HarnessRecord = {
  id: string;
  name: string;
  base: string;
  baseLabel?: string;
  defaultModel?: string | null;
  systemPrompt?: string | null;
  approvalLevel?: string;
  workspace?: string | null;
  maxStep?: number | null;
  timeoutSeconds?: number | null;
  createdAt: number;
  enabled?: boolean;
};

const responses = new Map<string, ResponseRecord>();
const sessions = new Map<string, SessionRecord>();
const harnesses = new Map<string, HarnessRecord>();
type FileRecord = {
  id: string;
  filename: string;
  bytes: number;
  createdAt: number;
  path: string;
  sessionId?: string;
  containerId?: string;
  source: "upload" | "artifact";
};
const files = new Map<string, FileRecord>();

mock.module("../main/uhp/store", () => ({
  loadResponse: (id: string) => responses.get(id) ?? null,
  saveResponse: (record: ResponseRecord) => responses.set(record.id, record),
  deleteResponse: (id: string) => responses.delete(id),
  listResponses: () => [...responses.values()],
  listResponsesForSession: (sessionId: string) =>
    [...responses.values()].filter((row) => row.sessionId === sessionId),
  loadSession: (id: string) => sessions.get(id) ?? null,
  saveSession: (record: SessionRecord) => sessions.set(record.id, record),
  deleteSession: (id: string) => sessions.delete(id),
  listSessions: () => [...sessions.values()],
  loadHarness: (id: string) => harnesses.get(id) ?? null,
  saveHarness: (record: HarnessRecord) => harnesses.set(record.id, record),
  deleteHarness: (id: string) => harnesses.delete(id),
  listHarnesses: () => [...harnesses.values()],
  loadFile: (id: string) => files.get(id) ?? null,
  saveFile: (record: FileRecord) => files.set(record.id, record),
  deleteFile: (id: string) => files.delete(id),
  listFiles: () => [...files.values()],
  listFilesForSession: (sessionId: string) =>
    [...files.values()].filter((row) => row.sessionId === sessionId),
  markInterruptedResponses: () => 0,
  pruneOldResponses: () => 0,
}));

const settings = {
  enabled: true,
  port: 0,
  bind: "loopback" as const,
  workspaceRoot: process.env.KOVA_DATA_DIR ?? "/tmp/uhp-test-workspace",
  defaultHarnessId: null as string | null,
  approvalLevel: "workspace-write" as const,
  maxConcurrentTasks: 2,
  responseRetentionDays: 30,
  apiKeyCipher: null as string | null,
};

mock.module("../main/uhp/settings", () => ({
  loadUhpConfig: () => settings,
  saveUhpConfig: (patch: Partial<typeof settings>) => {
    Object.assign(settings, patch);
    return settings;
  },
  defaultUhpConfig: () => settings,
}));

let server: import("../main/uhp/server").UhpServer;
let baseUrl = "";
let token = "test-token";
let tap: ((frame: Record<string, unknown>) => void) | null = null;
let longNext = false;
let writeNext = false;
let unicodeWriteNext = false;
let envWriteNext = false;
let manyToolsNext = false;
let scanWriteNext = false;
let usageNext = false;
let currentRequestId = "";
let lastAttachments: unknown[] | null = null;

const bridge: UhpBridge = {
  async newSession(args) {
    return { sessionId: "kova-session-1", threadId: args.threadId };
  },
  async setMode() {},
  async setModel() {},
  async prompt(args) {
    currentRequestId = args.requestId;
    lastAttachments = args.attachments ?? null;
    // Emit a tiny turn on the next tick so the HTTP handler can attach.
    setTimeout(() => {
      tap?.({ id: args.requestId, chunk: { type: "text-start", id: "t0" } });
      if (longNext) {
        tap?.({ id: args.requestId, chunk: { type: "text-delta", id: "t0", delta: "waiting" } });
        return;
      }
      if (writeNext) {
        tap?.({
          id: args.requestId,
          chunk: {
            type: "tool-input-available",
            toolCallId: "call-write",
            toolName: "write",
            input: { path: "note.txt", content: "artifact" },
          },
        });
        tap?.({
          id: args.requestId,
          chunk: {
            type: "tool-output-available",
            toolCallId: "call-write",
            output: "ok",
          },
        });
      }
      if (unicodeWriteNext) {
        tap?.({
          id: args.requestId,
          chunk: {
            type: "tool-input-available",
            toolCallId: "call-unicode",
            toolName: "write",
            input: { path: "中文.txt", content: "你好" },
          },
        });
        tap?.({
          id: args.requestId,
          chunk: {
            type: "tool-output-available",
            toolCallId: "call-unicode",
            output: "ok",
          },
        });
      }
      if (envWriteNext) {
        tap?.({
          id: args.requestId,
          chunk: {
            type: "tool-input-available",
            toolCallId: "call-env",
            toolName: "write",
            input: { path: ".env", content: "SECRET=1" },
          },
        });
        tap?.({
          id: args.requestId,
          chunk: {
            type: "tool-output-available",
            toolCallId: "call-env",
            output: "ok",
          },
        });
      }
      if (manyToolsNext) {
        for (const index of [1, 2, 3]) {
          tap?.({
            id: args.requestId,
            chunk: {
              type: "tool-input-available",
              toolCallId: `call-${index}`,
              toolName: "read",
              input: { path: `f${index}.txt` },
            },
          });
        }
      }
      if (scanWriteNext && typeof args.cwd === "string") {
        try {
          writeFileSync(join(args.cwd, "scan-note.txt"), "scan artifact");
        } catch {
          /* test workspace may not exist */
        }
      }
      if (usageNext) {
        try {
          const sessions = join(process.env.KOVA_DATA_DIR ?? "", "sessions");
          mkdirSync(sessions, { recursive: true });
          writeFileSync(
            join(sessions, "kova-session-1.jsonl"),
            `${JSON.stringify({
              type: "message",
              seq: 1,
              agent: {
                role: "assistant",
                timestamp: Date.now(),
                content: "hello",
                usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
              },
            })}\n`,
          );
        } catch {
          /* usage stays null */
        }
      }
      tap?.({ id: args.requestId, chunk: { type: "text-delta", id: "t0", delta: "hello" } });
      tap?.({ id: args.requestId, chunk: { type: "text-end", id: "t0" } });
      tap?.({ id: args.requestId, chunk: { type: "finish" } });
    }, 0);
  },
  async abort() {
    if (currentRequestId && tap) {
      tap({ id: currentRequestId, chunk: { type: "text-end", id: "t0" } });
      tap({ id: currentRequestId, chunk: { type: "finish" } });
    }
  },
  async listModels() {
    return [
      {
        provider: "test",
        providerName: "Test",
        id: "model",
        name: "Test model",
        enabled: true,
        authed: true,
      },
    ];
  },
  async listSessions() {
    return [];
  },
  async getHistory() {
    return { messages: [], lastSeq: 0 };
  },
  async deleteSession() {},
  addFrameTap(cb) {
    tap = cb;
    return () => {
      tap = null;
    };
  },
};

beforeAll(async () => {
  process.env.KOVA_DATA_DIR = mkdtempSync(join(tmpdir(), "kova-uhp-test-"));
  const { initPaths } = await import("../main/paths");
  initPaths();
  mkdirSync("/tmp/uhp-test-workspace", { recursive: true });
  writeFileSync("/tmp/uhp-test-workspace/note.txt", "artifact");
  writeFileSync("/tmp/uhp-test-workspace/中文.txt", "你好");
  writeFileSync("/tmp/uhp-test-workspace/.env", "SECRET=1");
  const { UhpServer } = await import("../main/uhp/server");
  server = new UhpServer({
    bridge,
    getToken: () => token,
    getConfig: () => settings,
  });
  const status = await server.start(0);
  baseUrl = status.url ?? "";
});

afterAll(async () => {
  await server?.stop();
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "UHP-Version": "2026-10-19", ...extra };
}

describe("UHP server", () => {
  test("discovery is public and advertises extended", async () => {
    const response = await fetch(`${baseUrl}/v1/uhp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as UhpDiscovery;
    expect(body.object).toBe("uhp.discovery");
    expect(body.default_version).toBe("2026-10-19");
    expect(body.conformance_class).toBe("extended");
    expect(body.capabilities.files_input).toBe(true);
    expect(body.capabilities.harness_management).toBe(false);
  });

  test("auth is required outside discovery", async () => {
    const response = await fetch(`${baseUrl}/v1/harnesses`);
    expect(response.status).toBe(401);
  });

  test("lists an auto-created harness", async () => {
    const response = await fetch(`${baseUrl}/v1/harnesses`, { headers: auth() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: UhpHarness[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id.startsWith("chrn_")).toBe(true);
    expect(body.data[0].defaultModel).toBe("test/model");
  });

  test("runs a non-streaming task", async () => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "hi" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as UhpResponse;
    expect(body.status).toBe("completed");
    expect(body.metadata.session_id.startsWith("hsess_")).toBe(true);
    expect(body.metadata.ignored_fields).toEqual([]);
    const message = body.output.find((item) => item.type === "message") as
      | { content: { type: string; text: string }[] }
      | undefined;
    expect(message?.content[0].text).toBe("hello");
  });

  test("streams gapless events and a terminal response", async () => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify({ input: "hi", stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as UhpStreamEvent);
    expect(events[0].type).toBe("response.created");
    expect(events.at(-1)?.type).toBe("response.completed");
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_, index) => index),
    );
  });

  test("uploads a file and resolves file_id into prompt attachments", async () => {
    const form = new FormData();
    form.append("file", new Blob(["hello file"], { type: "text/plain" }), "hello.txt");
    const uploaded = await fetch(`${baseUrl}/v1/files`, {
      method: "POST",
      headers: auth(),
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const file = (await uploaded.json()) as UhpFile;
    expect(file.object).toBe("file");
    expect(file.filename).toBe("hello.txt");
    expect(file.bytes).toBe(10);

    lastAttachments = null;
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "read this" },
              // A client-supplied path must never win over the server's file_id
              // resolution (nor be echoed by input_items).
              { type: "input_file", file_id: file.id, path: "/etc/passwd" },
            ],
          },
        ],
      }),
    });
    expect(task.status).toBe(200);
    const taskBody = (await task.json()) as UhpResponse;
    const attachments = lastAttachments as unknown as {
      name: string;
      mimeType: string;
      data?: string;
      path?: string;
    }[];
    expect(attachments.length).toBe(1);
    const attachment = attachments[0];
    expect(attachment.name).toBe("hello.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.data).toBeUndefined();
    expect(attachment.path).toContain("hello.txt");
    const inputItems = await fetch(
      `${baseUrl}/v1/responses/${taskBody.id}/input_items`,
      { headers: auth() },
    );
    expect(inputItems.status).toBe(200);
    const inputItemsBody = (await inputItems.json()) as {
      data: { type?: string }[];
    };
    expect(inputItemsBody.data[0]?.type).toBe("message");
    expect(JSON.stringify(inputItemsBody)).not.toContain('"path"');
    expect(JSON.stringify(inputItemsBody)).not.toContain("/etc/passwd");
  });

  test("rejects non-positive budget values", async () => {
    for (const key of ["max_output_tokens", "max_step", "timeout_seconds"]) {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ input: "hi", [key]: 0 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; param: string } };
      expect(body.error.code).toBe("invalid_input");
      expect(body.error.param).toBe(key);
    }
  });

  test("enforces max_output_tokens approximately", async () => {
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "hi", max_output_tokens: 1 }),
    });
    expect(task.status).toBe(200);
    const response = (await task.json()) as UhpResponse;
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details?.reason).toBe("max_output_tokens");
  });

  test("enforces max_step by tool-call rounds", async () => {
    manyToolsNext = true;
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "hi", max_step: 1 }),
    });
    manyToolsNext = false;
    expect(task.status).toBe(200);
    const response = (await task.json()) as UhpResponse;
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details?.reason).toBe("max_steps");
  });

  test("falls back to workspace scanning for bash-created artifacts", async () => {
    scanWriteNext = true;
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "create a file" }),
    });
    scanWriteNext = false;
    const response = (await task.json()) as UhpResponse;
    const listed = await fetch(
      `${baseUrl}/v1/sessions/${response.metadata.session_id}/files`,
      { headers: auth() },
    );
    const body = (await listed.json()) as { files: { filename: string }[] };
    expect(body.files.some((file) => file.filename === "scan-note.txt")).toBe(true);
  });

  test("reports usage from transcript timestamps", async () => {
    usageNext = true;
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "hi" }),
    });
    usageNext = false;
    const response = (await task.json()) as UhpResponse;
    expect(response.usage).not.toBeNull();
    expect(response.usage?.input_tokens).toBe(13);
    expect(response.usage?.output_tokens).toBe(5);
    expect(response.usage?.total_tokens).toBe(18);
  });

  test("records write artifacts and serves them", async () => {
    writeNext = true;
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "write a note" }),
    });
    expect(task.status).toBe(200);
    const response = (await task.json()) as UhpResponse;
    const sessionId = response.metadata.session_id;
    const listed = await fetch(`${baseUrl}/v1/sessions/${sessionId}/files`, {
      headers: auth(),
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      files: { id: string; container_id: string; filename: string }[];
    };
    expect(body.files.some((file) => file.filename === "note.txt")).toBe(true);
    const file = body.files.find((entry) => entry.filename === "note.txt")!;
    const download = await fetch(
      `${baseUrl}/v1/containers/${file.container_id}/files/${file.id}/content`,
      { headers: auth() },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await download.text()).toBe("artifact");
    writeNext = false;
  });

  test("serves Unicode artifact filenames with a safe Content-Disposition", async () => {
    unicodeWriteNext = true;
    const task = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "write chinese filename" }),
    });
    unicodeWriteNext = false;
    const response = (await task.json()) as UhpResponse;
    const listed = await fetch(
      `${baseUrl}/v1/sessions/${response.metadata.session_id}/files`,
      { headers: auth() },
    );
    const body = (await listed.json()) as {
      files: { id: string; container_id: string; filename: string }[];
    };
    const file = body.files.find((entry) => entry.filename === "中文.txt");
    expect(file).toBeTruthy();
    const download = await fetch(
      `${baseUrl}/v1/containers/${file!.container_id}/files/${file!.id}/content`,
      { headers: auth() },
    );
    expect(download.status).toBe(200);
    const disposition = download.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("filename*=UTF-8''");
    expect(await download.text()).toBe("你好");
  });

  test("serves the browser demo and redirects root", async () => {
    const demo = await fetch(`${baseUrl}/demo`);
    expect(demo.status).toBe(200);
    expect(demo.headers.get("content-type")).toContain("text/html");
    expect(demo.headers.get("x-frame-options")).toBe("DENY");
    expect(demo.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await demo.text()).toContain("UHP Demo");
    const root = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/demo");
  });

  test("rejects unsupported UHP versions with the supported list", async () => {
    const response = await fetch(`${baseUrl}/v1/uhp`, {
      headers: { "UHP-Version": "1999-01-01" },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("uhp-version")).toBe("2026-10-19");
    const body = (await response.json()) as {
      error: { code: string; detail: { supported_versions: string[] } };
    };
    expect(body.error.code).toBe("unsupported_protocol_version");
    expect(body.error.detail.supported_versions).toEqual(["2026-10-19"]);
  });

  test("lists reserved fields as ignored", async () => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "hi", tools: [], include: [] }),
    });
    const body = (await response.json()) as UhpResponse;
    expect(body.metadata.ignored_fields).toContain("tools");
    expect(body.metadata.ignored_fields).toContain("include");
  });

  test("continues a session with previous_response_id", async () => {
    const first = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "first" }),
    });
    const firstBody = (await first.json()) as UhpResponse;
    const second = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        input: "second",
        previous_response_id: firstBody.id,
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as UhpResponse;
    expect(secondBody.metadata.session_id).toBe(firstBody.metadata.session_id);
    expect(secondBody.previous_response_id).toBe(firstBody.id);

    const sessions = await fetch(`${baseUrl}/v1/sessions`, { headers: auth() });
    const list = (await sessions.json()) as { data: { id: string }[] };
    expect(list.data.some((session) => session.id === firstBody.metadata.session_id)).toBe(true);
    const turns = await fetch(
      `${baseUrl}/v1/sessions/${firstBody.metadata.session_id}/turns`,
      { headers: auth() },
    );
    const turnBody = (await turns.json()) as { data: { id: string }[] };
    expect(turnBody.data.some((turn) => turn.id === firstBody.id)).toBe(true);
    expect(turnBody.data.some((turn) => turn.id === secondBody.id)).toBe(true);

    const detail = await fetch(
      `${baseUrl}/v1/sessions/${firstBody.metadata.session_id}`,
      { headers: auth() },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { turns?: { id: string }[] };
    const detailIds = detailBody.turns?.map((turn) => turn.id) ?? [];
    expect(detailIds.includes(firstBody.id)).toBe(true);
    expect(detailIds.includes(secondBody.id)).toBe(true);
  });

  test("reports response_not_found for unknown ids", async () => {
    const response = await fetch(`${baseUrl}/v1/responses/resp_missing`, { headers: auth() });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("response_not_found");
  });

  test("background tasks return in_progress and stay pollable", async () => {
    longNext = true;
    const created = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "wait", background: true }),
    });
    expect(created.status).toBe(200);
    const response = (await created.json()) as UhpResponse;
    expect(response.status).toBe("in_progress");
    const polled = await fetch(`${baseUrl}/v1/responses/${response.id}`, { headers: auth() });
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as UhpResponse).status).toBe("in_progress");
    const cancelled = await fetch(`${baseUrl}/v1/responses/${response.id}/cancel`, {
      method: "POST",
      headers: auth(),
    });
    expect(((await cancelled.json()) as UhpResponse).status).toBe("cancelled");
    longNext = false;
    currentRequestId = "";
  });

  test("cancels a running task to a cancelled terminal state", async () => {
    longNext = true;
    const create = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify({ input: "wait", stream: true }),
    });
    expect(create.status).toBe(200);
    const reader = create.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let responseId: string | undefined;
    while (!responseId) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as UhpStreamEvent;
        if (event.type === "response.created") {
          responseId = event.response.id;
          break;
        }
      }
    }
    expect(responseId).toBeTruthy();
    const cancelled = await fetch(`${baseUrl}/v1/responses/${responseId}/cancel`, {
      method: "POST",
      headers: auth(),
    });
    expect(cancelled.status).toBe(200);
    const body = (await cancelled.json()) as UhpResponse;
    expect(body.status).toBe("cancelled");
    await reader.cancel().catch(() => undefined);
    longNext = false;
    currentRequestId = "";
  });

  test("rejects an unknown file_id instead of trusting a client path", async () => {
    lastAttachments = null;
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "read" },
              { type: "input_file", file_id: "file_missing", path: "/etc/passwd" },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("file_not_found");
    expect(lastAttachments).toBeNull();
  });

  test("does not copy sensitive files as artifacts", async () => {
    envWriteNext = true;
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "write env" }),
    });
    envWriteNext = false;
    const body = (await response.json()) as UhpResponse;
    const listed = await fetch(
      `${baseUrl}/v1/sessions/${body.metadata.session_id}/files`,
      { headers: auth() },
    );
    const files = (await listed.json()) as { files: { filename: string }[] };
    expect(files.files.some((file) => file.filename === ".env")).toBe(false);
  });

  test("does not create cwd paths outside the harness workspace", async () => {
    const outside = join(tmpdir(), `uhp-cwd-outside-${Date.now()}`);
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        input: "hi",
        metadata: { cwd: outside },
      }),
    });
    expect(response.status).toBe(400);
    expect(existsSync(outside)).toBe(false);

    const symlinkTarget = mkdtempSync(join(tmpdir(), "uhp-cwd-symlink-"));
    const link = join("/tmp/uhp-test-workspace", `escape-${Date.now()}`);
    symlinkSync(symlinkTarget, link);
    try {
      const viaSymlink = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          input: "hi",
          metadata: { cwd: `${link}/child` },
        }),
      });
      expect(viaSymlink.status).toBe(400);
      expect(existsSync(join(symlinkTarget, "child"))).toBe(false);
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("a continuation inherits the previous harness when omitted", async () => {
    const harnessesResponse = await fetch(`${baseUrl}/v1/harnesses`, { headers: auth() });
    const firstHarness = (await harnessesResponse.json()) as { data: { id: string }[] };
    const defaultHarnessId = firstHarness.data[0]!.id;
    settings.defaultHarnessId = defaultHarnessId;
    harnesses.set("chrn_second", {
      id: "chrn_second",
      name: "Second harness",
      base: "test",
      defaultModel: "test/model",
      createdAt: Date.now(),
      enabled: true,
    });
    try {
      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          input: "first",
          metadata: { harness_id: "chrn_second" },
        }),
      });
      const firstBody = (await first.json()) as UhpResponse;
      expect(firstBody.metadata.harness_id).toBe("chrn_second");

      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          input: "second",
          previous_response_id: firstBody.id,
        }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as UhpResponse;
      expect(secondBody.metadata.harness_id).toBe("chrn_second");

      const mismatch = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          input: "third",
          previous_response_id: firstBody.id,
          metadata: { harness_id: defaultHarnessId },
        }),
      });
      expect(mismatch.status).toBe(409);
      const mismatchBody = (await mismatch.json()) as { error: { code: string } };
      expect(mismatchBody.error.code).toBe("harness_mismatch");
    } finally {
      harnesses.delete("chrn_second");
    }
  });

  test("enforces maxConcurrentTasks", async () => {
    settings.maxConcurrentTasks = 1;
    longNext = true;
    try {
      const first = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ input: "first long task", background: true }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as UhpResponse;

      const second = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ input: "second task" }),
      });
      expect(second.status).toBe(429);
      const error = (await second.json()) as { error: { code: string } };
      expect(error.error.code).toBe("rate_limit_error");

      await fetch(`${baseUrl}/v1/responses/${firstBody.id}/cancel`, {
        method: "POST",
        headers: auth(),
      });
    } finally {
      settings.maxConcurrentTasks = 2;
      longNext = false;
      currentRequestId = "";
    }
  });

  test("stop() cancels in-flight tasks", async () => {
    longNext = true;
    const created = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ input: "wait", background: true }),
    });
    const response = (await created.json()) as UhpResponse;
    await server.stop();
    const stored = server.taskService().getResponse(response.id);
    expect(stored?.status).toBe("cancelled");
    longNext = false;
    currentRequestId = "";
  });
});
