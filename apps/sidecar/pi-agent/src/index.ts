/**
 * pi-agent sidecar 入口：由 Tauri(Rust) 以子进程方式拉起。
 * 职责只有装配：初始化存储 → 加载自定义提供商 → 启动 stdin NDJSON 读取循环。
 *
 * 存储双模式：
 *   - 有 PI_SESSIONS_DIR（生产，Rust 拉起）：业务表由 Rust 宿主持有（data.rs），
 *     本进程经 stdout host_query RPC 读写（storage/hostdb.ts）
 *   - 无（冒烟/本地直跑）：回退本地 SQLite（hostdb local 模式）
 *
 * 模块划分（src/ 按域分目录，index.ts / types.ts / log.ts 留在根部）：
 *   protocol/     协议命令分发（protocol: handleLine / dispatch / dispatchPrompt）、
 *                 stream: Agent 事件 -> UIMessageChunk 流（stdout）、trace、prompt-attachments
 *   sessions/     sessions: threadId -> Agent 会话映射与会话解析、transcript: JSONL 转录与
 *                 索引表持久化、prompt-queue、session-title-summarize
 *   mcp/          MCP 接入（config 配置双层合并 / manager 连接池 / cache 元数据缓存 /
 *                 output-guard 输出防护 / tools 网关工具与审批挂起 / oauth / audit）
 *   tools/        内置编码工具与系统提示词（tools）+ 浏览器/截图/打开文件/HTTP 等工具
 *   skills/       skills 技能装载、skill-mgmt-tools 管理、skill-use-tool 使用
 *   subagent/     Task/TaskWait/TaskList/TaskStop 工具组与 SubagentRun、子代理定义三层发现
 *                 （内置常量 + 系统 <app_data>/subagents/*.yml + 工作区 <cwd>/.kova/subagents/*.yml）
 *   todo/         待办（todo / todo-state）
 *   model/        model-catalog 模型目录 + 自定义提供商注册、provider-retry、usage-stats
 *   storage/      hostdb 数据访问层（host RPC / 本地 SQLite 双模式）、storage 存储装配
 *                 （JSONL 目录 + CredentialStore）
 *   agent/        运行时横切：context、modes、memory、instructions、personalization、
 *                 hooks、app-mode、agent-errors
 *   plugins/      插件（plugins / plugin-mgmt-tools）
 *   observability/ observability、otlp-exporter
 *   automation/   定时任务（vendored pi-task-scheduler + runtime/runner 装配，见目录内溯源头）
 *   types.ts      共享类型
 */
import { createInterface } from "node:readline";
import { logErr } from "./log";
import { initHostMode, initStorage } from "./storage/storage";
import { loadCustomProviders, applyModelOverrides, initCurrentModelKey } from "./model/model-catalog";
import { initPersonalization } from "./agent/personalization";
import { initAppMode } from "./agent/app-mode";
import { initMemory } from "./agent/memory";
import { initBrowserConfig } from "./tools/browser-config";
import { initImageGenConfig } from "./tools/imagegen-config";
import { initObservability } from "./observability/observability";
import { initHooks } from "./agent/hooks";
import { initSubagentState } from "./subagent/subagent-definitions";
import { initSkillsState } from "./skills/skills";
import { initMcpEnabledState } from "./mcp/mcp-config";
import { initPluginsState } from "./plugins/plugins";
import { initSecretsConfig } from "./secrets/secrets";
import { mcpManager } from "./mcp/mcp-manager";
import { handleLine, markStdinClosed, setInitGate } from "./protocol/protocol";
import { initAutomation, stopAutomation } from "./automation/runtime";
import { automationRunner } from "./automation/runner";

const DB_PATH = process.env.PI_DB_PATH || "pi-agent.db";
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR;

async function main() {
  const sessionsDir = SESSIONS_DIR ?? "./sessions";
  if (SESSIONS_DIR) {
    // 生产：数据层在 Rust 宿主（src-tauri/src/data.rs）
    initHostMode(SESSIONS_DIR);
  } else {
    // 冒烟/直跑：无宿主接 host_result，退回本地 SQLite
    initStorage(DB_PATH, sessionsDir);
  }
  // 自动化调度器：store/锁放 <sessionsDir>/automation/，随进程存亡。
  // 失败不阻断主流程（任务系统坏掉不该拖垮聊天），错误进 stderr 日志。
  const automationReady = initAutomation(sessionsDir, automationRunner).catch((err) => {
    logErr("automation init failed:", err);
  });

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
    void automationReady.then(() => stopAutomation());
  });

  // 模型目录初始化作为命令分发闸门：目录就绪前到达的命令（含启动恢复的 set_model）
  // 在 handleLine 里缓冲，避免自定义提供商模型被 "model not found" 拒绝后回落默认模型。
  // 闸门 promise 内部 catch，保证不会卡死命令分发。
  const catalogReady = (async () => {
    await loadCustomProviders();
    await applyModelOverrides();
    // 模型键 kv 恢复（sidecar 侧）：只写内存键，放闸门前完成，保证首批会话
    // resolve 时取到的就是上次使用的模型（前端不再承担启动恢复职责）
    await initCurrentModelKey();
    // 个性化设置在闸门内恢复：闸门放行前到达的命令都会缓冲，
    // 保证首批会话组装系统提示词时读到的已是 kv 里恢复的设置
    await initPersonalization();
    // 全局工作模式（work/code）同走 kv，提示词注入块读这份内存状态
    await initAppMode();
    // 记忆设置同理（提示词注入块 + 工具门控都读这份内存配置）
    await initMemory();
    // 浏览器驱动开关同走 kv（browser_* 工具 execute 门控读这份内存配置）
    await initBrowserConfig();
    // 文生图配置同走 kv（generate_image 工具 execute 门控读这份内存配置）
    await initImageGenConfig();
    // 可观测性导出配置同走 kv（otlp-exporter 每次 run 结算实时读这份内存配置）
    await initObservability();
    // 子智能体开关/工作区信任同走 kv，理由同上（定义文件本身按需带签名加载）
    await initSubagentState();
    // 技能启用开关同走 kv（技能目录本身按需带签名加载，resolveSession 预热）
    await initSkillsState();
    // MCP 启用开关同走 kv（服务器定义文件按需带签名加载）；就绪后启动空闲连接回收
    await initMcpEnabledState();
    mcpManager.startReaper();
    // 生命周期钩子配置同走 kv（PreToolUse/PermissionRequest 在工具路径同步读取，
    // 必须在闸门放行前就位，保证首批会话即生效）
    await initHooks();
    // 插件启用开关同走 kv（插件清单本身带签名扫描；四条合并链的插件层读取它）
    await initPluginsState();
    // 密钥绑定策略同走 kv（值本身是 Rust 侧的密文；bash 注入时实时读这份内存配置）
    await initSecretsConfig();
  })().catch((err) => {
    logErr("model catalog init failed:", err);
  });
  setInitGate(catalogReady);
  await catalogReady;
}

void main();
