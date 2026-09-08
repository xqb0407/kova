/**
 * pi-agent sidecar：由 Tauri(Rust) 以子进程方式拉起。
 * 协议：stdin/stdout 上的 NDJSON。
 *
 * 输入（stdin，每行一个 JSON）：
 *   { "type": "prompt", "id": "<reqId>", "text": "...", "threadId": "...", "sessionId": "...", "cwd": "..." }
 *       sessionId = pi session 文件路径；提供则恢复该会话（跨重启），缺省则按 threadId 懒建新会话
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *   { "type": "abort" }
 *   { "type": "ping", "id": "<reqId>" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                                    → { id, type: "sessions", sessions: [...] }
 *   { "type": "new_session", "id", "threadId", "cwd" }                   → { id, type: "session", sessionId }
 *   { "type": "get_history", "id", "sessionId" }                         → { id, type: "history", messages: UIMessage[] }
 *   { "type": "delete_session", "id", "sessionId" }                      → { id, type: "deleted" }
 *   { "type": "rename_session", "id", "sessionId", "name" }              → { id, type: "renamed" }
 *   { "type": "list_models", "id" }                                      → { id, type: "models", models: [...], providers: [...] }
 *   { "type": "set_model", "id", "provider", "modelId" }                 → { id, type: "model", provider, modelId }
 *   { "type": "list_skills", "id", "cwd" }                               → { id, type: "skills", skills: [...] }
 *
 * 输出（stdout，每行一个 JSON）：
 *   prompt 流：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 *   其余为上述各自的响应行。
 *
 * 错误与日志一律走 stderr，避免污染协议流。
 */
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  getAgentDir,
  loadSkills,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type * as ai from "ai";

type UIMessageChunk = ai.UIMessageChunk;
type UIMessage = ai.UIMessage;

/** 会话列表项（给前端渲染列表用） */
type SessionSummary = {
  sessionId: string; // pi session 文件路径，作为稳定 remoteId
  name?: string;
  firstMessage: string;
  messageCount: number;
  modified: string; // ISO
  cwd: string;
};

/** threadId -> 活动 session（每个前端线程一个独立 pi session） */
const sessions = new Map<string, AgentSession>();

/** 模型注册表（懒创建，含内置 + 用户 models.json 自定义模型） */
let modelRegistry: ModelRegistry | null = null;
/** 当前选中的模型（前端 SQLite 为持久层，这里只是运行态） */
let currentModelKey: { provider: string; modelId: string } | null = null;

function getModelRegistry(): ModelRegistry {
  if (!modelRegistry) {
    modelRegistry = ModelRegistry.create(AuthStorage.create());
  }
  return modelRegistry;
}

let currentReqId: string | null = null;
let runSeq = 0;
/** 当前运行中 contentIndex -> 流式内容 id */
let contentIds = new Map<number, { text: string; reasoning: string }>();

const send = (line: unknown) => process.stdout.write(JSON.stringify(line) + "\n");
const sendChunk = (id: string, chunk: UIMessageChunk) => send({ id, chunk });
const logErr = (...args: unknown[]) => console.error("[pi-agent]", ...args);

/** 拿到 threadId 对应的 session；sessionId 提供时优先恢复该文件（重启续聊） */
async function resolveSession(
  threadId: string,
  sessionId?: string,
  cwd?: string,
): Promise<AgentSession> {
  const existing = sessions.get(threadId);
  if (existing) return existing;

  const manager = sessionId
    ? SessionManager.open(sessionId)
    : SessionManager.create(cwd || homedir());

  // 选中模型仅对新建会话生效；恢复的会话沿用其保存的模型
  const model = currentModelKey
    ? getModelRegistry().find(currentModelKey.provider, currentModelKey.modelId)
    : undefined;

  const session = (
    await createAgentSession({ sessionManager: manager, model })
  ).session;
  session.subscribe(onSessionEvent);
  sessions.set(threadId, session);
  return session;
}

function contentIdFor(index: number) {
  let ids = contentIds.get(index);
  if (!ids) {
    ids = { text: `text-${runSeq}-${index}`, reasoning: `reasoning-${runSeq}-${index}` };
    contentIds.set(index, ids);
  }
  return ids;
}

function onSessionEvent(event: import("@mariozechner/pi-coding-agent").AgentSessionEvent) {
  const reqId = currentReqId;
  if (!reqId) return;

  switch (event.type) {
    case "message_update": {
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
          const detail = e.error?.errorMessage ?? "pi agent error";
          sendChunk(reqId, { type: "error", errorText: String(detail) });
          break;
        }
      }
      break;
    }
    case "tool_execution_start": {
      sendChunk(reqId, {
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args ?? null,
      });
      break;
    }
    case "tool_execution_end": {
      sendChunk(reqId, {
        type: "tool-output-available",
        toolCallId: event.toolCallId,
        output: event.result ?? null,
      });
      break;
    }
  }
}

/** pi session entries -> 前端 UIMessage[]（文本 + 思考；工具调用暂不回放） */
function historyToUIMessages(path: string): UIMessage[] {
  const manager = SessionManager.open(path);
  const out: UIMessage[] = [];
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      if (!text.trim()) continue;
      out.push({ id: entry.id, role: "user", parts: [{ type: "text", text }] });
    } else if (msg.role === "assistant") {
      const parts: UIMessage["parts"] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text.trim()) {
          parts.push({ type: "text", text: c.text });
        } else if (c.type === "thinking" && c.thinking.trim()) {
          parts.push({ type: "reasoning", text: c.thinking, state: "done" });
        }
      }
      if (!parts.length) continue;
      out.push({ id: entry.id, role: "assistant", parts });
    }
  }
  return out;
}

async function handlePrompt(
  reqId: string,
  text: string,
  threadId: string,
  sessionId?: string,
  cwd?: string,
) {
  const session = await resolveSession(threadId, sessionId, cwd);
  currentReqId = reqId;
  runSeq += 1;
  contentIds = new Map();

  sendChunk(reqId, { type: "start" });
  sendChunk(reqId, { type: "start-step" });

  try {
    await session.prompt(text);
  } catch (err) {
    sendChunk(reqId, { type: "error", errorText: err instanceof Error ? err.message : String(err) });
  } finally {
    sendChunk(reqId, { type: "finish-step" });
    sendChunk(reqId, { type: "finish" });
    currentReqId = null;
  }
}

async function handleLine(raw: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    logErr("unparseable line:", String(raw).slice(0, 200));
    return;
  }

  const reqId = typeof msg.id === "string" ? msg.id : `req-${runSeq}`;
  try {
    switch (msg.type) {
      case "ping": {
        send({ id: reqId, type: "pong" });
        break;
      }
      case "prompt": {
        await handlePrompt(
          reqId,
          String(msg.text ?? ""),
          String(msg.threadId ?? "default"),
          typeof msg.sessionId === "string" ? msg.sessionId : undefined,
          typeof msg.cwd === "string" ? msg.cwd : undefined,
        );
        break;
      }
      case "abort": {
        const current = [...sessions.values()];
        await Promise.all(current.map((s) => s.abort()));
        break;
      }
      case "list_sessions": {
        const infos = await SessionManager.listAll();
        const sessions: SessionSummary[] = infos
          .map((s) => ({
            sessionId: s.path,
            name: s.name,
            firstMessage: s.firstMessage,
            messageCount: s.messageCount,
            modified: s.modified.toISOString(),
            cwd: s.cwd,
          }))
          // 空会话没有渲染价值
          .filter((s) => s.messageCount > 0)
          .sort((a, b) => b.modified.localeCompare(a.modified));
        send({ id: reqId, type: "sessions", sessions });
        break;
      }
      case "new_session": {
        const threadId = String(msg.threadId ?? `thread-${Date.now()}`);
        const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
        const session = await resolveSession(threadId, undefined, cwd);
        const sessionId = session.sessionManager.getSessionFile() ?? "";
        send({ id: reqId, type: "session", sessionId, threadId });
        break;
      }
      case "get_history": {
        const sessionId = String(msg.sessionId ?? "");
        const messages = historyToUIMessages(sessionId);
        send({ id: reqId, type: "history", messages });
        break;
      }
      case "delete_session": {
        const sessionId = String(msg.sessionId ?? "");
        // 从活动 map 中移除并删除文件
        for (const [tid, sess] of sessions) {
          if (sess.sessionManager.getSessionFile() === sessionId) sessions.delete(tid);
        }
        rmSync(sessionId, { force: true });
        send({ id: reqId, type: "deleted" });
        break;
      }
      case "rename_session": {
        const sessionId = String(msg.sessionId ?? "");
        const name = String(msg.name ?? "");
        const manager = SessionManager.open(sessionId);
        manager.appendSessionInfo(name);
        send({ id: reqId, type: "renamed" });
        break;
      }
      case "list_models": {
        const registry = getModelRegistry();
        const models = registry.getAll().map((m) => ({
          provider: m.provider as string,
          providerName: registry.getProviderDisplayName(m.provider as string),
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          authed: registry.hasConfiguredAuth(m),
        }));
        // provider 由模型聚合，authed = 任一模型已配置凭据
        const providerMap = new Map<string, { id: string; name: string; authed: boolean }>();
        for (const m of models) {
          const p = providerMap.get(m.provider);
          if (p) {
            p.authed = p.authed || m.authed;
          } else {
            providerMap.set(m.provider, { id: m.provider, name: m.providerName, authed: m.authed });
          }
        }
        send({
          id: reqId,
          type: "models",
          models,
          providers: [...providerMap.values()],
        });
        break;
      }
      case "set_model": {
        const provider = String(msg.provider ?? "");
        const modelId = String(msg.modelId ?? "");
        const registry = getModelRegistry();
        const model = registry.find(provider, modelId);
        if (!model) {
          throw new Error(`model not found: ${provider}/${modelId}`);
        }
        if (!registry.hasConfiguredAuth(model)) {
          throw new Error(`no credentials configured for ${provider}/${modelId}`);
        }
        currentModelKey = { provider, modelId };
        // 已活动的会话立即切换；新建会话在 resolveSession 时应用
        await Promise.all([...sessions.values()].map((s) => s.setModel(model)));
        send({ id: reqId, type: "model", provider, modelId });
        break;
      }
      case "list_skills": {
        const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : homedir();
        // pi 默认发现规则：全局 ~/.pi/agent/skills + 项目 <cwd>/.pi/skills
        const result = loadSkills({
          cwd,
          agentDir: getAgentDir(),
          skillPaths: [],
          includeDefaults: true,
        });
        send({
          id: reqId,
          type: "skills",
          skills: result.skills.map((s) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
            scope: s.sourceInfo.scope,
          })),
        });
        break;
      }
      default: {
        logErr("unknown message type:", msg.type);
        send({ id: reqId, type: "error", errorText: `unknown message type: ${String(msg.type)}` });
      }
    }
  } catch (err) {
    logErr("handleLine failed:", err);
    send({ id: reqId, type: "error", errorText: err instanceof Error ? err.message : String(err) });
  }
}

async function main() {
  logErr("starting (pid", process.pid, "cwd", process.cwd() + ")");
  const rl = createInterface({ input: process.stdin, terminal: false });

  // stdin 关闭（父进程写完）不等于任务处理完毕，等挂起请求清零再退出
  let stdinClosed = false;
  let pendingOps = 0;
  const maybeExit = () => {
    if (stdinClosed && pendingOps === 0) process.exit(0);
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    pendingOps += 1;
    void handleLine(trimmed)
      .catch((err) => logErr("handleLine failed:", err))
      .finally(() => {
        pendingOps -= 1;
        maybeExit();
      });
  });
  rl.on("close", () => {
    stdinClosed = true;
    maybeExit();
  });
}

void main();
