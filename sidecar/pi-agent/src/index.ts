/**
 * pi-agent sidecar 入口：由 Tauri(Rust) 以子进程方式拉起。
 * 职责只有装配：初始化存储 → 加载自定义提供商 → 启动 stdin NDJSON 读取循环。
 *
 * 模块划分：
 *   protocol.ts   协议命令分发（handleLine / dispatch / dispatchPrompt）
 *   sessions.ts   threadId -> Agent 会话映射与会话解析
 *   stream.ts     Agent 事件 -> UIMessageChunk 流（stdout）
 *   transcript.ts JSONL 转录与索引表持久化
 *   model-catalog.ts  模型目录 + 自定义提供商注册
 *   tools.ts      内置编码工具与系统提示词
 *   storage.ts    SQLite / JSONL 存储
 *   types.ts      共享类型
 */
import { createInterface } from "node:readline";
import { logErr } from "./log";
import { initStorage } from "./storage";
import { loadCustomProviders } from "./model-catalog";
import { handleLine, markStdinClosed } from "./protocol";

const DB_PATH = process.env.PI_DB_PATH || "pi-agent.db";
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || "./sessions";

async function main() {
  initStorage(DB_PATH, SESSIONS_DIR);
  loadCustomProviders();

  logErr("starting (pid", process.pid, "cwd", process.cwd() + ")");
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    handleLine(trimmed);
  });
  rl.on("close", () => {
    markStdinClosed();
  });
}

void main();
