/**
 * 偏好与观测命令：个性化/工作模式/记忆/钩子/浏览器驱动/OTLP 观测/使用统计/轨迹。
 * 变更后的活动会话系统提示词热替换走同一套 composeModeSystemPrompt 整段重排。
 */
import { send } from "../stream";
import { running } from "../../sessions/sessions";
import { composeModeSystemPrompt } from "../../agent/modes";
import {
  applyPersonalization,
  getPersonalization,
  rulesFilePath,
  soulFilePath,
} from "../../agent/personalization";
import { applyAppMode, getAppMode } from "../../agent/app-mode";
import {
  applyMemoryConfig,
  getMemoryConfig,
  memoryScopesPayload,
  readMemoryFile,
  writeMemoryFile,
  type MemoryScope,
} from "../../agent/memory";
import { getHookConfigs, setHookConfigs } from "../../agent/hooks";
import { applyBrowserConfig, getBrowserConfig } from "../../tools/browser-config";
import {
  applyObservabilityConfig,
  getObservabilityConfig,
  normalizeObservabilityConfig,
} from "../../observability/observability";
import { probeOtlpEndpoint } from "../../observability/otlp-exporter";
import { aggregateUsageStats } from "../../model/usage-stats";
import { readTraceRuns } from "../trace";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  get_personalization: async (reqId) => {
    send({
      id: reqId,
      type: "personalization",
      settings: getPersonalization(),
      paths: { soul: soulFilePath(), rules: rulesFilePath() },
    });
  },

  usage_stats: async (reqId) => {
    const stats = await aggregateUsageStats();
    send({ id: reqId, type: "usage_stats", stats });
  },

  trace_query: async (reqId, msg) => {
    const traceSession = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    if (!traceSession) throw new Error("trace_query: sessionId is required");
    const limit =
      typeof msg.limit === "number" && msg.limit > 0 ? Math.min(msg.limit, 200) : 50;
    send({ id: reqId, type: "trace_query", runs: readTraceRuns(traceSession, limit) });
  },

  set_personalization: async (reqId, msg) => {
    const settings = await applyPersonalization(msg.settings);
    // 与 set_thinking 同款广播：个性化段变了就整段重排系统提示词，活动会话
    // 下一轮请求即生效；composeModeSystemPrompt 内部读取当前设置
    for (const run of running.values()) {
      run.agent.state.systemPrompt = composeModeSystemPrompt(
        run.mode,
        run.cwd,
        run.agent.state.model,
      );
    }
    send({
      id: reqId,
      type: "personalization",
      settings,
      paths: { soul: soulFilePath(), rules: rulesFilePath() },
    });
  },

  get_app_mode: async (reqId) => {
    send({ id: reqId, type: "app_mode", mode: getAppMode() });
  },

  set_app_mode: async (reqId, msg) => {
    const mode = await applyAppMode(msg.mode);
    // 与 set_personalization 同款广播：工作模式段变了就整段重排系统提示词，
    // 活动会话下一轮请求即生效
    for (const run of running.values()) {
      run.agent.state.systemPrompt = composeModeSystemPrompt(
        run.mode,
        run.cwd,
        run.agent.state.model,
      );
    }
    send({ id: reqId, type: "app_mode", mode });
  },

  get_memory: async (reqId) => {
    send({ id: reqId, type: "memory", settings: getMemoryConfig() });
  },

  set_hooks: async (reqId, msg) => {
    await setHookConfigs(msg.hooks);
    send({ id: reqId, type: "hooks_saved" });
  },

  get_hooks: async (reqId) => {
    send({ id: reqId, type: "hooks", hooks: getHookConfigs() });
  },

  set_memory: async (reqId, msg) => {
    const settings = await applyMemoryConfig(msg.settings);
    // 与 set_personalization 同款广播：记忆段变了就整段重排系统提示词；
    // 工具表常驻不重建（execute 内实时读配置门控）
    for (const run of running.values()) {
      run.agent.state.systemPrompt = composeModeSystemPrompt(
        run.mode,
        run.cwd,
        run.agent.state.model,
      );
    }
    send({ id: reqId, type: "memory", settings });
  },

  get_browser: async (reqId) => {
    send({ id: reqId, type: "browser", settings: getBrowserConfig() });
  },

  set_browser: async (reqId, msg) => {
    // 只落 kv：browser_* 工具无提示词注入块，execute 内实时门控，写完即生效
    const settings = await applyBrowserConfig(msg.settings);
    send({ id: reqId, type: "browser", settings });
  },

  get_observability: async (reqId) => {
    send({ id: reqId, type: "observability", settings: getObservabilityConfig() });
  },

  set_observability: async (reqId, msg) => {
    // 只落 kv + 内存：otlp-exporter 每次 run 结算实时读配置，写完即生效
    const settings = await applyObservabilityConfig(msg.settings);
    send({ id: reqId, type: "observability", settings });
  },

  test_observability: async (reqId, msg) => {
    // 不落 kv：用消息携带的设置（缺省回落当前配置）从 sidecar 发一条探针 span
    // （渲染进程 fetch 会被 CORS 拦，探针必须走 sidecar 网络通道）
    const probeSettings = normalizeObservabilityConfig(
      msg.settings ?? getObservabilityConfig(),
    );
    const result = await probeOtlpEndpoint(probeSettings.endpoint, probeSettings.headers);
    send({ id: reqId, type: "observability_tested", result });
  },

  list_memory_files: async (reqId, msg) => {
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    send({ id: reqId, type: "memory_files", scopes: memoryScopesPayload(cwd) });
  },

  read_memory_file: async (reqId, msg) => {
    // 预览/编辑入口：不设总开关门控——关闭记忆也应能查看已有内容再决定
    const scope: MemoryScope = msg.scope === "workspace" ? "workspace" : "global";
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (scope === "workspace" && !cwd) throw new Error("read_memory_file: workspace scope requires cwd");
    const file = String(msg.file ?? "");
    if (!file.trim()) throw new Error("read_memory_file: file is required");
    const res = await readMemoryFile(getMemoryConfig(), scope, cwd ?? "", file);
    if (res.kind !== "text") throw new Error(`memory file not found: ${file}`);
    send({ id: reqId, type: "memory_file", file, content: res.content });
  },

  write_memory_file: async (reqId, msg) => {
    const scope: MemoryScope = msg.scope === "workspace" ? "workspace" : "global";
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (scope === "workspace" && !cwd) throw new Error("write_memory_file: workspace scope requires cwd");
    const file = String(msg.file ?? "");
    const content = String(msg.content ?? "");
    // 整体覆盖保存（设置页编辑语义）；文件名/路径校验在 writeMemoryFile 内
    const saved = await writeMemoryFile(scope, cwd ?? "", file, content, "overwrite");
    // 内容可能正被注入：与 set_memory 同款热替换活动会话提示词
    for (const run of running.values()) {
      run.agent.state.systemPrompt = composeModeSystemPrompt(
        run.mode,
        run.cwd,
        run.agent.state.model,
      );
    }
    send({ id: reqId, type: "memory_file_saved", scope, file: saved.rel, bytes: saved.bytes });
  },
};
