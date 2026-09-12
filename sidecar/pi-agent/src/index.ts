/**
 * pi-agent sidecar 入口：由 Tauri(Rust) 以子进程方式拉起。
 * 职责只有装配：初始化存储 → 加载自定义提供商 → 启动 stdin NDJSON 读取循环。
 *
 * 存储双模式：
 *   - 有 PI_SESSIONS_DIR（生产，Rust 拉起）：业务表由 Rust 宿主持有（data.rs），
 *     本进程经 stdout host_query RPC 读写（hostdb.ts）
 *   - 无（冒烟/本地直跑）：回退本地 SQLite（hostdb local 模式）
 *
 * 模块划分：
 *   protocol.ts   协议命令分发（handleLine / dispatch / dispatchPrompt）
 *   sessions.ts   threadId -> Agent 会话映射与会话解析
 *   stream.ts     Agent 事件 -> UIMessageChunk 流（stdout）
 *   transcript.ts JSONL 转录与索引表持久化
 *   model-catalog.ts  模型目录 + 自定义提供商注册
 *   tools.ts      内置编码工具与系统提示词
 *   subagent.ts           Task/TaskWait/TaskList/TaskStop 工具组与 SubagentRun
 *   subagent-definitions.ts 子代理定义三层发现（内置常量 + 系统 <app_data>/subagents/*.yml + 工作区 <cwd>/.xulux/subagents/*.yml）
 *   hostdb.ts     数据访问层（host RPC / 本地 SQLite 双模式）
 *   storage.ts    存储装配（JSONL 目录 + CredentialStore）
 *   types.ts      共享类型
 */
import { createInterface } from "node:readline";
import { logErr } from "./log";
import { initHostMode, initStorage } from "./storage";
import { loadCustomProviders, applyModelOverrides } from "./model-catalog";
import { initPersonalization } from "./personalization";
import { initSubagentState } from "./subagent-definitions";
import { handleLine, markStdinClosed, setInitGate } from "./protocol";

const DB_PATH = process.env.PI_DB_PATH || "pi-agent.db";
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR;

async function main() {
  if (SESSIONS_DIR) {
    // 生产：数据层在 Rust 宿主（src-tauri/src/data.rs）
    initHostMode(SESSIONS_DIR);
  } else {
    // 冒烟/直跑：无宿主接 host_result，退回本地 SQLite
    initStorage(DB_PATH, SESSIONS_DIR ?? "./sessions");
  }

  // 先挂 stdin 循环再 await 异步初始化：宿主可能在启动早期就写命令，
  // 且 host_result 响应需要 handleLine 结算（readline 不能晚于第一个 stdin 行）
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

  // 模型目录初始化作为命令分发闸门：目录就绪前到达的命令（含启动恢复的 set_model）
  // 在 handleLine 里缓冲，避免自定义提供商模型被 "model not found" 拒绝后回落默认模型。
  // 闸门 promise 内部 catch，保证不会卡死命令分发。
  const catalogReady = (async () => {
    await loadCustomProviders();
    await applyModelOverrides();
    // 个性化设置在闸门内恢复：闸门放行前到达的命令都会缓冲，
    // 保证首批会话组装系统提示词时读到的已是 kv 里恢复的设置
    await initPersonalization();
    // 子智能体开关/工作区信任同走 kv，理由同上（定义文件本身按需带签名加载）
    await initSubagentState();
  })().catch((err) => {
    logErr("model catalog init failed:", err);
  });
  setInitGate(catalogReady);
  await catalogReady;
}

void main();
