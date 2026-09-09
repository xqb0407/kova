/**
 * pi-agent sidecar：由 Tauri(Rust) 以子进程方式拉起。
 * 基于 @earendil-works/pi-agent-core(Agent) + @earendil-works/pi-ai(模型/凭据) 自建，
 * 不依赖 pi-coding-agent，与 pi CLI 完全解耦。
 * 协议：stdin/stdout 上的 NDJSON。
 *
 * 输入（stdin，每行一个 JSON）：
 *   { "type": "prompt", "id": "<reqId>", "text": "...", "threadId": "...", "sessionId": "...", "cwd": "..." }
 *       sessionId = 会话 id（索引表/JSONL 文件名）；提供则恢复该会话（跨重启），缺省则按 threadId 懒建新会话
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *   { "type": "abort" }
 *   { "type": "ping", "id" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                         → { id, type: "sessions", sessions: [...] }
 *   { "type": "new_session", "id", "threadId", "cwd" }        → { id, type: "session", sessionId, threadId }
 *   { "type": "get_history", "id", "sessionId" }              → { id, type: "history", messages: UIMessage[] }
 *   { "type": "delete_session", "id", "sessionId" }           → { id, type: "deleted" }
 *   { "type": "rename_session", "id", "sessionId", "name" }   → { id, type: "renamed" }
 *   { "type": "list_models", "id" }                           → { id, type: "models", models: [...], providers: [...] }
 *   { "type": "set_model", "id", "provider", "modelId" }      → { id, type: "model", provider, modelId }
 *   { "type": "set_credential", "id", "provider", "apiKey" }  → { id, type: "credential", provider }
 *   { "type": "list_credentials", "id" }                      → { id, type: "credentials", credentials: [...] }
 *   { "type": "delete_credential", "id", "provider" }         → { id, type: "credential_deleted", provider }
 *   { "type": "add_custom_provider", "id", "name", "baseUrl", "apiKey", "models": [{ "id", ... }] }
 *                                                             → { id, type: "custom_provider", provider }
 *   { "type": "list_custom_providers", "id" }                 → { id, type: "custom_providers", providers: [...] }
 *   { "type": "delete_custom_provider", "id", "provider" }    → { id, type: "custom_provider_deleted", provider }
 *
 * 输出（stdout，每行一个 JSON）：
 *   prompt 流：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 *   其余为上述各自的响应行。
 *
 * 存储：
 *   SQLite（env PI_DB_PATH）：pi_sessions 索引表 + credentials 表（kv 表归 Rust 管，这里不碰）
 *   JSONL（env PI_SESSIONS_DIR/<sessionId>.jsonl）：消息正文
 *     首行 {"type":"header","schema":1,"id","cwd","created_at"}
 *     消息行 {"type":"message","seq":n,"ui":UIMessage,"agent":AgentMessage} —— 每轮结束增量 append
 *     读端跳过撕裂尾行，append 中途崩溃不影响已有内容
 * 错误与日志一律走 stderr，避免污染协议流。
 */
import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  createProvider,
  envApiKeyAuth,
  Type,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Message,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import path from "node:path";
import type * as ai from "ai";

type UIMessage = ai.UIMessage;
type UIMessageChunk = ai.UIMessageChunk;

/** 会话列表项（给前端渲染列表用） */
type SessionSummary = {
  sessionId: string; // 会话 id（索引表主键 / JSONL 文件名）
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string; // ISO
  cwd: string;
};

// ---------------------------------------------------------------------------
// 存储：SQLite（索引 + 凭据）
// ---------------------------------------------------------------------------

const DB_PATH = process.env.PI_DB_PATH || "pi-agent.db";
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || "./sessions";

mkdirSync(SESSIONS_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS pi_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    first_message TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    provider TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custom_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    models TEXT NOT NULL DEFAULT '[]',
    api TEXT NOT NULL DEFAULT 'openai-chat'
  );
`);
// 旧库迁移：补 api 列（接口格式）
try {
  db.exec("ALTER TABLE custom_providers ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-chat'");
} catch {
  // 列已存在
}
// 内置厂商的模型过滤（勾选哪些模型可被前端看到；空/缺省 = 全部）
db.exec(`
  CREATE TABLE IF NOT EXISTS provider_models (
    provider TEXT PRIMARY KEY,
    models TEXT NOT NULL DEFAULT '[]'
  );
`);

const sessionPath = (id: string) => path.join(SESSIONS_DIR, `${id}.jsonl`);

// ---------------------------------------------------------------------------
// 凭据：CredentialStore 接口的 SQLite 实现，直接喂给 pi-ai
// ---------------------------------------------------------------------------

const credentialStore: CredentialStore = {
  async read(providerId: string): Promise<Credential | undefined> {
    const row = db
      .query<{ api_key: string }, [string]>(
        "SELECT api_key FROM credentials WHERE provider = ?",
      )
      .get(providerId);
    return row ? { type: "api_key", key: row.api_key } : undefined;
  },
  async list(): Promise<readonly CredentialInfo[]> {
    const rows = db
      .query<{ provider: string }, []>("SELECT provider FROM credentials")
      .all();
    return rows.map((r) => ({ providerId: r.provider, type: "api_key" as const }));
  },
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next?.type === "api_key" && next.key) {
      db.query(
        "INSERT INTO credentials (provider, api_key, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
      ).run(providerId, next.key, new Date().toISOString());
    }
    return next;
  },
  async delete(providerId: string): Promise<void> {
    db.query("DELETE FROM credentials WHERE provider = ?").run(providerId);
  },
};

// ---------------------------------------------------------------------------
// 模型：pi-ai 内置 catalog（39 个 provider）+ 我们的凭据
// ---------------------------------------------------------------------------

const models = builtinModels({ credentials: credentialStore });

/** 当前选中的模型（重启后由前端通过 set_model 恢复） */
let currentModelKey: { provider: string; modelId: string } | null = null;

/** 未选模型时的默认策略：catalog 里第一个有凭据的模型 */
async function defaultModel(): Promise<Model<Api> | undefined> {
  try {
    const available = await models.getAvailable();
    logErr("defaultModel: available =", available.length, available[0]?.provider, available[0]?.id);
    return available[0];
  } catch (err) {
    logErr("defaultModel: getAvailable failed:", err);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 自定义 OpenAI 兼容提供商：用户配置 baseUrl + apiKey + 模型 id，动态注册进 models 目录
// ---------------------------------------------------------------------------

type CustomModelSpec = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

/** 自定义提供商支持的接口格式 */
type CustomApiKind = "openai-chat" | "openai-responses" | "anthropic-messages";

const API_FACTORIES: Record<CustomApiKind, typeof openAICompletionsApi> = {
  "openai-chat": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

/** UI 值 → pi-ai Api 标识 */
const API_ID: Record<CustomApiKind, Api> = {
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
};

const normalizeApi = (v: unknown): CustomApiKind =>
  v === "openai-responses" || v === "anthropic-messages" ? v : "openai-chat";

/** 把一行 custom_providers 记录构造成 provider 并注册进 models 目录 */
function registerCustomProvider(row: {
  id: string;
  name: string;
  base_url: string;
  models: string;
  api?: string;
}) {
  let specs: CustomModelSpec[] = [];
  try {
    specs = JSON.parse(row.models) as CustomModelSpec[];
  } catch {
    specs = [];
  }
  // baseUrl 语义与 OpenAI SDK 一致：完整前缀，API 实现在其后拼各自端点
  // （openai-chat → /chat/completions，openai-responses → /responses，anthropic-messages → /v1/messages）
  const baseUrl = row.base_url.trim().replace(/\/+$/, "");
  const apiKind = normalizeApi(row.api);
  const modelList: Model<Api>[] = specs
    .filter((m) => m && typeof m.id === "string" && m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      name: m.name?.trim() || m.id.trim(),
      api: API_ID[apiKind],
      provider: row.id,
      baseUrl,
      reasoning: m.reasoning ?? false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 8_192,
    }));
  const provider = createProvider({
    id: row.id,
    name: row.name,
    baseUrl,
    auth: { apiKey: envApiKeyAuth(`${row.name} API key`, []) },
    models: modelList,
    api: API_FACTORIES[apiKind](),
  });
  models.setProvider(provider);
}

/** 启动时把已保存的自定义提供商全部注册 */
function loadCustomProviders() {
  const rows = db
    .query<{ id: string; name: string; base_url: string; models: string }, []>(
      "SELECT id, name, base_url, models FROM custom_providers",
    )
    .all();
  for (const row of rows) {
    try {
      registerCustomProvider(row);
    } catch (err) {
      logErr("registerCustomProvider failed for", row.id, err);
    }
  }
}
loadCustomProviders();

// ---------------------------------------------------------------------------
// 内置编码工具（bash / read / write / edit）
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT = 16 * 1024;
const MAX_READ_BYTES = 64 * 1024;

function resolveInWorkspace(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function buildTools(cwd: string): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "bash",
      label: "Bash",
      description:
        "Run a shell command in the workspace and return combined stdout/stderr. " +
        "Output is capped; use narrower commands (grep/tail/head) instead of dumping large files.",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to run" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in milliseconds (default 120000)" }),
        ),
      }),
      execute: async (_id, params) => {
        const { command, timeout } = params as {
          command: string;
          timeout?: number;
        };
        const child = spawn("/bin/bash", ["-c", command], {
          cwd,
          env: process.env,
        });
        let out = "";
        let truncated = false;
        const collect = (chunk: Buffer) => {
          if (out.length >= MAX_TOOL_OUTPUT) {
            truncated = true;
            child.kill();
            return;
          }
          out += chunk.toString("utf8");
          if (out.length > MAX_TOOL_OUTPUT) {
            out = out.slice(0, MAX_TOOL_OUTPUT);
            truncated = true;
            child.kill();
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        const code = await new Promise<number | null>((resolve) => {
          const timer = setTimeout(() => {
            truncated = true;
            child.kill();
            resolve(null);
          }, timeout ?? 120_000);
          child.on("close", (c) => {
            clearTimeout(timer);
            resolve(c);
          });
          child.on("error", () => {
            clearTimeout(timer);
            resolve(-1);
          });
        });
        const suffix = truncated ? "\n…[output truncated]" : "";
        const status =
          code === 0 ? "" : code === null ? "\n[timeout]" : `\n[exit code: ${code}]`;
        return textResult(out + status + suffix, { truncated, exitCode: code });
      },
    },
    {
      name: "read",
      label: "Read",
      description:
        "Read a text file. Returns up to 64KB with line numbers. " +
        "Use offset/limit to paginate large files.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        offset: Type.Optional(Type.Number({ description: "1-based start line" })),
        limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
      }),
      execute: async (_id, params) => {
        const { file_path, offset, limit } = params as {
          file_path: string;
          offset?: number;
          limit?: number;
        };
        const full = resolveInWorkspace(cwd, file_path);
        const raw = readFileSync(full, "utf8");
        if (raw.includes("\0")) {
          throw new Error(`${file_path} is a binary file and cannot be read as text`);
        }
        const allLines = raw.split("\n");
        const start = Math.max((offset ?? 1) - 1, 0);
        const end = Math.min(start + (limit ?? allLines.length), allLines.length);
        let slice = allLines
          .slice(start, end)
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n");
        if (slice.length > MAX_READ_BYTES) {
          slice = slice.slice(0, MAX_READ_BYTES) + "\n…[truncated]";
        }
        const more =
          end < allLines.length
            ? `\n…[${allLines.length - end} more lines, total ${allLines.length}]`
            : "";
        return textResult(slice + more, { totalLines: allLines.length });
      },
    },
    {
      name: "write",
      label: "Write",
      description: "Write (or create) a file with the given content. Parent directories are created automatically.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        content: Type.String({ description: "Full file content" }),
      }),
      execute: async (_id, params) => {
        const { file_path, content } = params as {
          file_path: string;
          content: string;
        };
        const full = resolveInWorkspace(cwd, file_path);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
        return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${file_path}`);
      },
    },
    {
      name: "edit",
      label: "Edit",
      description:
        "Replace an exact string in a file. old_string must match exactly and appear exactly once, " +
        "unless replace_all is true.",
      parameters: Type.Object({
        file_path: Type.String({ description: "Path (relative to workspace or absolute)" }),
        old_string: Type.String({ description: "Exact text to replace" }),
        new_string: Type.String({ description: "Replacement text" }),
        replace_all: Type.Optional(
          Type.Boolean({ description: "Replace every occurrence (default false)" }),
        ),
      }),
      execute: async (_id, params) => {
        const { file_path, old_string, new_string, replace_all } = params as {
          file_path: string;
          old_string: string;
          new_string: string;
          replace_all?: boolean;
        };
        const full = resolveInWorkspace(cwd, file_path);
        const raw = readFileSync(full, "utf8");
        const occurrences = raw.split(old_string).length - 1;
        if (occurrences === 0) {
          throw new Error(`old_string not found in ${file_path}`);
        }
        if (occurrences > 1 && !replace_all) {
          throw new Error(
            `old_string appears ${occurrences} times in ${file_path}; provide more context or set replace_all=true`,
          );
        }
        const updated =
          occurrences > 1 ? raw.replaceAll(old_string, new_string) : raw.replace(old_string, new_string);
        writeFileSync(full, updated, "utf8");
        return textResult(`Replaced ${replace_all && occurrences > 1 ? occurrences : 1} occurrence(s) in ${file_path}`);
      },
    },
  ];
  return tools;
}

const systemPrompt = (cwd: string) =>
  [
    "You are a capable coding agent running inside the Xulux desktop app.",
    `The workspace directory is \`${cwd}\`. Relative paths resolve there.`,
    "Reply in the same language the user writes in.",
    "Prefer the read tool over shell commands for inspecting files; use bash for anything dynamic.",
    "Before a batch of tool calls, write one short sentence saying what you are about to do.",
    "Make the final message self-contained: the outcome, what changed, and anything still open.",
  ].join("\n");

// ---------------------------------------------------------------------------
// 会话：内存态 + 持久化
// ---------------------------------------------------------------------------

type Running = {
  agent: Agent;
  sessionId: string;
  cwd: string;
  persistedSeq: number; // 已写入 JSONL 的消息数
};
/** threadId -> 活动会话（每个前端线程一个 Agent 实例） */
const running = new Map<string, Running>();

let currentReqId: string | null = null;
let runSeq = 0;
/** 当前运行中 contentIndex -> 流式内容 id */
let contentIds = new Map<number, { text: string; reasoning: string }>();

const send = (line: unknown) => process.stdout.write(JSON.stringify(line) + "\n");
const sendChunk = (id: string, chunk: UIMessageChunk) => send({ id, chunk });
const logErr = (...args: unknown[]) => console.error("[pi-agent]", ...args);

/** 从 JSONL 读全部消息行（跳过撕裂尾行） */
function readTranscript(
  sessionId: string,
): { ui: UIMessage; agent: Message }[] {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return [];
  const out: { ui: UIMessage; agent: Message }[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === "message" && row.ui && row.agent) {
        out.push({ ui: row.ui, agent: row.agent });
      }
      // 未知行类型直接跳过，向前兼容
    } catch {
      // 撕裂尾行：忽略
    }
  }
  return out;
}

function contentIdFor(index: number) {
  let ids = contentIds.get(index);
  if (!ids) {
    ids = { text: `text-${runSeq}-${index}`, reasoning: `reasoning-${runSeq}-${index}` };
    contentIds.set(index, ids);
  }
  return ids;
}

/** pi-ai Message -> UIMessage（给前端历史渲染；与旧实现的转换范围一致：text/reasoning） */
function toUiMessage(msg: Message, seq: number): UIMessage | null {
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    if (!text.trim()) return null;
    return { id: `msg-${seq}`, role: "user", parts: [{ type: "text", text }] };
  }
  if (msg.role === "assistant") {
    const parts: UIMessage["parts"] = [];
    for (const c of msg.content) {
      if (c.type === "text" && c.text.trim()) {
        parts.push({ type: "text", text: c.text });
      } else if (c.type === "thinking" && c.thinking.trim()) {
        parts.push({ type: "reasoning", text: c.thinking, state: "done" });
      }
    }
    if (!parts.length) return null;
    return { id: `msg-${seq}`, role: "assistant", parts };
  }
  return null; // toolResult 等不进前端历史
}

/** agent_end 后把新增消息增量 append 到 JSONL，并维护索引表 */
function persist(run: Running) {
  const messages = run.agent.state.messages;
  if (messages.length <= run.persistedSeq) return;
  const file = sessionPath(run.sessionId);
  const lines: string[] = [];
  for (let i = run.persistedSeq; i < messages.length; i++) {
    const agent = messages[i] as Message;
    const ui = toUiMessage(agent, i);
    if (!ui) continue;
    lines.push(JSON.stringify({ type: "message", seq: i, ui, agent }));
  }
  if (lines.length) appendFileSync(file, lines.join("\n") + "\n");
  run.persistedSeq = messages.length;

  const now = new Date().toISOString();
  const first = messages[0] as Message | undefined;
  const firstText =
    first && first.role === "user"
      ? typeof first.content === "string"
        ? first.content
        : (first.content.find((c) => c.type === "text")?.text ?? "")
      : "";
  db.query(
    "UPDATE pi_sessions SET updated_at = ?, " +
      "title = CASE WHEN title = '' THEN ? ELSE title END, " +
      "first_message = CASE WHEN first_message = '' THEN ? ELSE first_message END " +
      "WHERE id = ?",
  ).run(now, firstText.slice(0, 60), firstText, run.sessionId);
}

/** Agent 事件 -> UIMessageChunk 流（reqId 取当前活跃请求） */
function onAgentEvent(event: AgentEvent, run: Running) {
  const reqId = currentReqId;
  if (event.type !== "message_update") logErr("event:", event.type);
  else logErr("event: message_update/", (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type);
  switch (event.type) {
    case "message_end": {
      // 裸 Agent 的 stream 异常（网络/401 等）会合成 stopReason:"error" 的失败消息
      if (!reqId) break;
      const m = event.message as { stopReason?: string; errorMessage?: string };
      if (m?.stopReason === "error") {
        sendChunk(reqId, {
          type: "error",
          errorText: m.errorMessage || "pi agent error",
        });
      }
      break;
    }
    case "message_update": {
      if (!reqId) break;
      const e = event.assistantMessageEvent;
      switch (e.type) {
        case "text_start": {
          const { text } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "text-start", id: text });
          break;
        }
        case "text_delta": {
          const { text } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "text-delta", id: text, delta: e.delta });
          break;
        }
        case "text_end": {
          const { text } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "text-end", id: text });
          break;
        }
        case "thinking_start": {
          const { reasoning } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "reasoning-start", id: reasoning });
          break;
        }
        case "thinking_delta": {
          const { reasoning } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "reasoning-delta", id: reasoning, delta: e.delta });
          break;
        }
        case "thinking_end": {
          const { reasoning } = contentIdFor(e.contentIndex);
          sendChunk(reqId, { type: "reasoning-end", id: reasoning });
          break;
        }
        case "error": {
          const detail = (e as { error?: { errorMessage?: string } }).error?.errorMessage ?? "pi agent error";
          sendChunk(reqId, { type: "error", errorText: String(detail) });
          break;
        }
      }
      break;
    }
    case "tool_execution_start": {
      if (!reqId) break;
      sendChunk(reqId, {
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args ?? null,
      });
      break;
    }
    case "tool_execution_end": {
      if (!reqId) break;
      const result = event.result as { content?: { type: string; text?: string }[] };
      const output =
        result?.content
          ?.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("\n") ?? "";
      sendChunk(reqId, {
        type: "tool-output-available",
        toolCallId: event.toolCallId,
        output,
      });
      break;
    }
    case "agent_end": {
      persist(run);
      break;
    }
  }
}

/** 拿到 threadId 对应的 Agent；sessionId 提供时优先恢复该会话（重启续聊） */
async function resolveSession(
  threadId: string,
  sessionId?: string,
  cwd?: string,
): Promise<Running> {
  const existing = running.get(threadId);
  if (existing) return existing;

  let resolvedCwd = cwd || homedir();
  let restoredMessages: Message[] = [];
  let persistedSeq = 0;

  if (sessionId) {
    const row = db
      .query<{ cwd: string }, [string]>("SELECT cwd FROM pi_sessions WHERE id = ?")
      .get(sessionId);
    if (!row) throw new Error(`session not found: ${sessionId}`);
    resolvedCwd = row.cwd || resolvedCwd;
    const transcript = readTranscript(sessionId);
    restoredMessages = transcript.map((t) => t.agent);
    persistedSeq = transcript.length;
  } else {
    // 新会话：建索引行 + JSONL header
    sessionId = randomUUID();
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO pi_sessions (id, title, first_message, cwd, created_at, updated_at) VALUES (?, '', '', ?, ?, ?)",
    ).run(sessionId, resolvedCwd, now, now);
    writeFileSync(
      sessionPath(sessionId),
      JSON.stringify({ type: "header", schema: 1, id: sessionId, cwd: resolvedCwd, created_at: now }) + "\n",
    );
  }

  const model =
    currentModelKey
      ? models.getModel(currentModelKey.provider, currentModelKey.modelId)
      : await defaultModel();

  const agent = new Agent({
    streamFn: (m, context, options) =>
      models.streamSimple(m, context, options),
    initialState: {
      systemPrompt: systemPrompt(resolvedCwd),
      model,
      tools: buildTools(resolvedCwd),
      messages: restoredMessages,
    },
  });

  const run: Running = { agent, sessionId, cwd: resolvedCwd, persistedSeq };
  agent.subscribe((event) => onAgentEvent(event, run));
  running.set(threadId, run);
  return run;
}

// ---------------------------------------------------------------------------
// 命令处理
// ---------------------------------------------------------------------------

/** stdin 关闭（父进程写完）不等于任务处理完毕，等挂起请求清零再退出 */
let stdinClosed = false;
let pendingOps = 0;
let exiting = false;
function maybeExit() {
  if (exiting || !stdinClosed || pendingOps > 0) return;
  exiting = true;
  // end() 会先冲刷 stdout 队列再退出，避免超长响应行被截断
  process.stdout.end(() => process.exit(0));
}

/** 管理命令串行队列：避免凭据写入与列表查询等异步命令交叠产生竞态 */
let mgmtQueue: Promise<void> = Promise.resolve();

function handleLine(raw: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    logErr("unparseable line:", String(raw).slice(0, 200));
    return;
  }

  const reqId = typeof msg.id === "string" ? msg.id : `req-${runSeq}`;
  const run = async () => {
    try {
      await dispatch(reqId, msg);
    } catch (err) {
      logErr("handleLine failed:", err);
      send({ id: reqId, type: "error", errorText: err instanceof Error ? err.message : String(err) });
    } finally {
      pendingOps -= 1;
      maybeExit();
    }
  };
  pendingOps += 1;
  if (msg.type === "prompt") {
    // prompt 主体是长任务，不占队列；但会话准备（建会话/读凭据）作为队列任务执行，
    // 与 set_credential / new_session 等保持严格先后
    void (async () => {
      try {
        await dispatchPrompt(reqId, msg);
      } catch (err) {
        sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
      } finally {
        pendingOps -= 1;
        maybeExit();
      }
    })();
  } else {
    mgmtQueue = mgmtQueue.then(run, run);
  }
}

/** prompt：会话准备段入管理队列串行执行，agent.prompt 长任务在队列外运行 */
async function dispatchPrompt(reqId: string, msg: Record<string, unknown>) {
  const task = mgmtQueue.then(() =>
    resolveSession(
      String(msg.threadId ?? "default"),
      typeof msg.sessionId === "string" ? msg.sessionId : undefined,
      typeof msg.cwd === "string" ? msg.cwd : undefined,
    ),
  );
  mgmtQueue = task.then(
    () => {},
    () => {},
  );

  let run: Running;
  try {
    run = await task;
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!run.agent.state.model) {
    sendChunk(reqId, {
      type: "error",
      errorText:
        "No model with credentials available. Open Settings → Model and add an API key.",
    });
    return;
  }
  currentReqId = reqId;
  runSeq += 1;
  contentIds = new Map();

  sendChunk(reqId, { type: "start" });
  sendChunk(reqId, { type: "start-step" });

  try {
    await run.agent.prompt(String(msg.text ?? ""));
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
  } finally {
    sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "finish" });
    currentReqId = null;
    persist(run);
  }
}

async function dispatch(reqId: string, msg: Record<string, unknown>) {
    switch (msg.type) {
      case "ping": {
        send({ id: reqId, type: "pong" });
        break;
      }
      case "abort": {
        for (const run of running.values()) run.agent.abort();
        break;
      }
      case "list_sessions": {
        // 索引在 SQLite，消息计数扫 JSONL 行数（个人桌面应用量级可接受）
        const sessions: SessionSummary[] = db
          .query<
            { id: string; title: string; first_message: string; cwd: string; updated_at: string },
            []
          >("SELECT id, title, first_message, cwd, updated_at FROM pi_sessions ORDER BY updated_at DESC")
          .all()
          .map((r) => {
            const file = sessionPath(r.id);
            let messageCount = 0;
            if (existsSync(file)) {
              const content = readFileSync(file, "utf8");
              for (const line of content.split("\n")) {
                if (line.includes('"type":"message"')) messageCount++;
              }
            }
            return {
              sessionId: r.id,
              name: r.title || undefined,
              firstMessage: r.first_message,
              messageCount,
              modified: r.updated_at,
              cwd: r.cwd,
            };
          })
          .filter((s) => s.messageCount > 0);
        send({ id: reqId, type: "sessions", sessions });
        break;
      }
      case "new_session": {
        const threadId = String(msg.threadId ?? `thread-${Date.now()}`);
        const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
        const run = await resolveSession(threadId, undefined, cwd);
        send({ id: reqId, type: "session", sessionId: run.sessionId, threadId });
        break;
      }
      case "get_history": {
        const sessionId = String(msg.sessionId ?? "");
        const messages = readTranscript(sessionId)
          .map((t) => t.ui)
          .filter((m): m is UIMessage => m !== null);
        send({ id: reqId, type: "history", messages });
        break;
      }
      case "delete_session": {
        const sessionId = String(msg.sessionId ?? "");
        for (const [tid, run] of running) {
          if (run.sessionId === sessionId) running.delete(tid);
        }
        db.query("DELETE FROM pi_sessions WHERE id = ?").run(sessionId);
        const file = sessionPath(sessionId);
        if (existsSync(file)) unlinkSync(file);
        send({ id: reqId, type: "deleted" });
        break;
      }
      case "rename_session": {
        const sessionId = String(msg.sessionId ?? "");
        const name = String(msg.name ?? "");
        db.query("UPDATE pi_sessions SET title = ? WHERE id = ?").run(name, sessionId);
        send({ id: reqId, type: "renamed" });
        break;
      }
      case "list_models": {
        const out: {
          provider: string;
          providerName: string;
          id: string;
          name: string;
          reasoning: boolean;
          contextWindow: number;
          authed: boolean;
        }[] = [];
        const providerMap = new Map<string, { id: string; name: string; authed: boolean }>();
        for (const p of models.getProviders()) {
          let authed = false;
          try {
            authed = (await models.getAuth(p.id)) !== undefined;
          } catch {
            authed = false;
          }
          providerMap.set(p.id, { id: p.id, name: p.name, authed });
          for (const m of p.getModels()) {
            out.push({
              provider: p.id,
              providerName: p.name,
              id: m.id,
              name: m.name,
              reasoning: m.reasoning,
              contextWindow: m.contextWindow,
              authed,
            });
          }
        }
        // 应用内置厂商的模型过滤（勾选集之外的模型不出现在前端目录里）
        const filterRows = db
          .query<{ provider: string; models: string }, []>(
            "SELECT provider, models FROM provider_models",
          )
          .all()
          .map((r) => {
            let ids: string[] = [];
            try {
              ids = JSON.parse(r.models) as string[];
            } catch {
              ids = [];
            }
            return [r.provider, new Set(ids)] as const;
          });
        const filters = new Map(filterRows);
        const filtered = out.filter(
          (m) => !filters.has(m.provider) || filters.get(m.provider)!.has(m.id),
        );
        send({
          id: reqId,
          type: "models",
          models: filtered,
          providers: [...providerMap.values()],
        });
        break;
      }
      case "get_provider_filter": {
        const provider = String(msg.provider ?? "");
        const row = db
          .query<{ models: string }, [string]>(
            "SELECT models FROM provider_models WHERE provider = ?",
          )
          .get(provider);
        let modelIds: string[] | null = null;
        if (row) {
          try {
            modelIds = JSON.parse(row.models) as string[];
          } catch {
            modelIds = null;
          }
        }
        send({ id: reqId, type: "provider_filter", provider, models: modelIds });
        break;
      }
      case "set_provider_filter": {
        const provider = String(msg.provider ?? "");
        const ids = Array.isArray(msg.models)
          ? [...new Set((msg.models as unknown[]).filter((s): s is string => typeof s === "string" && !!s.trim()))]
          : [];
        if (ids.length) {
          db.query(
            "INSERT INTO provider_models (provider, models) VALUES (?, ?) " +
              "ON CONFLICT(provider) DO UPDATE SET models = excluded.models",
          ).run(provider, JSON.stringify(ids));
        } else {
          // 空数组 = 清除过滤，恢复全部
          db.query("DELETE FROM provider_models WHERE provider = ?").run(provider);
        }
        send({ id: reqId, type: "provider_filter", provider, models: ids.length ? ids : null });
        break;
      }
      case "set_model": {
        const provider = String(msg.provider ?? "");
        const modelId = String(msg.modelId ?? "");
        const model = models.getModel(provider, modelId);
        if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
        const auth = await models.getAuth(provider).catch(() => undefined);
        if (!auth) throw new Error(`no credentials configured for ${provider}/${modelId}`);
        currentModelKey = { provider, modelId };
        for (const run of running.values()) run.agent.state.model = model;
        send({ id: reqId, type: "model", provider, modelId });
        break;
      }
      case "set_credential": {
        const provider = String(msg.provider ?? "");
        const apiKey = String(msg.apiKey ?? "");
        if (!provider || !apiKey) throw new Error("provider and apiKey are required");
        await credentialStore.modify(provider, async () => ({ type: "api_key", key: apiKey }));
        send({ id: reqId, type: "credential", provider });
        break;
      }
      case "list_credentials": {
        const credentials = await credentialStore.list();
        send({ id: reqId, type: "credentials", credentials });
        break;
      }
      case "delete_credential": {
        const provider = String(msg.provider ?? "");
        await credentialStore.delete(provider);
        send({ id: reqId, type: "credential_deleted", provider });
        break;
      }
      case "fetch_models": {
        // 拉取 OpenAI 兼容端点的 /models 列表（添加 AI 服务弹窗"获取列表"用）
        const baseUrl = String(msg.baseUrl ?? "").trim().replace(/\/+$/, "");
        const apiKey = String(msg.apiKey ?? "").trim();
        if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
        const res = await fetch(`${baseUrl}/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`获取模型列表失败: HTTP ${res.status}`);
        const json = (await res.json()) as { data?: unknown };
        const raw = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        const ids = raw
          .map((m) => (typeof m === "string" ? m : (m as { id?: unknown })?.id))
          .filter((s): s is string => typeof s === "string" && !!s.trim());
        send({ id: reqId, type: "fetched_models", models: [...new Set(ids)] });
        break;
      }
      case "add_custom_provider": {
        const name = String(msg.name ?? "").trim();
        const baseUrl = String(msg.baseUrl ?? "").trim();
        const apiKey = String(msg.apiKey ?? "").trim();
        const modelSpecs = Array.isArray(msg.models)
          ? (msg.models as CustomModelSpec[]).filter(
              (m) => m && typeof m.id === "string" && m.id.trim(),
            )
          : [];
        if (!name) throw new Error("name is required");
        if (!/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
        if (!modelSpecs.length) throw new Error("at least one model id is required");
        const api = normalizeApi(msg.api);
        const id =
          typeof msg.id === "string" && msg.id.trim()
            ? msg.id.trim()
            : `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID().slice(0, 8)}`;
        db.query(
          "INSERT INTO custom_providers (id, name, base_url, models, api) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, models = excluded.models, api = excluded.api",
        ).run(id, name, baseUrl, JSON.stringify(modelSpecs), api);
        // apiKey 留空表示保留原有凭据
        if (apiKey) {
          await credentialStore.modify(id, async () => ({ type: "api_key", key: apiKey }));
        }
        registerCustomProvider({ id, name, base_url: baseUrl, models: JSON.stringify(modelSpecs), api });
        // 已恢复会话若用旧的同名模型定义，同步刷新其 baseUrl 等字段
        if (currentModelKey?.provider === id) {
          const model = models.getModel(id, currentModelKey.modelId);
          if (model) for (const run of running.values()) run.agent.state.model = model;
        }
        send({ id: reqId, type: "custom_provider", provider: id });
        break;
      }
      case "list_custom_providers": {
        const providers = db
          .query<{ id: string; name: string; base_url: string; models: string; api: string }, []>(
            "SELECT id, name, base_url, models, api FROM custom_providers",
          )
          .all()
          .map((r) => {
            let specs: CustomModelSpec[] = [];
            try {
              specs = JSON.parse(r.models) as CustomModelSpec[];
            } catch {
              specs = [];
            }
            const hasKey =
              db
                .query<{ api_key: string }, [string]>(
                  "SELECT api_key FROM credentials WHERE provider = ?",
                )
                .get(r.id) !== undefined;
            return {
              providerId: r.id,
              name: r.name,
              baseUrl: r.base_url,
              models: specs,
              api: normalizeApi(r.api),
              hasApiKey: hasKey,
            };
          });
        send({ id: reqId, type: "custom_providers", providers });
        break;
      }
      case "delete_custom_provider": {
        const provider = String(msg.provider ?? "");
        db.query("DELETE FROM custom_providers WHERE id = ?").run(provider);
        await credentialStore.delete(provider);
        models.deleteProvider(provider);
        if (currentModelKey?.provider === provider) currentModelKey = null;
        send({ id: reqId, type: "custom_provider_deleted", provider });
        break;
      }
      default:
        logErr("unknown message type:", String(msg.type));
        send({ id: reqId, type: "error", errorText: `unknown message type: ${String(msg.type)}` });
    }
}

async function main() {
  logErr("starting (pid", process.pid, "cwd", process.cwd() + ")");
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    handleLine(trimmed);
  });
  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });
}

void main();
