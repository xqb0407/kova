/**
 * 偏好与观测命令：个性化/工作模式/记忆/钩子/浏览器驱动/密钥库/OTLP 观测/使用统计/轨迹。
 * 变更后的活动会话系统提示词热替换走同一套 composeModeSystemPrompt 整段重排。
 */
import { send } from "../stream";
import { running } from "../../sessions/sessions";
import { composeModeSystemPrompt } from "../../agent/modes";
import { setLeadingSystemMessage } from "../../agent/context";
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
import { applyImageGenConfig, getImageGenConfig } from "../../tools/imagegen-config";
import {
  applySecretsConfig,
  getSecretsConfig,
  isValidSecretName,
  workspaceScope,
} from "../../secrets/secrets";
import { secretDelete, secretList, secretSet } from "../../storage/hostdb";
import {
  applyObservabilityConfig,
  getObservabilityConfig,
  normalizeObservabilityConfig,
} from "../../observability/observability";
import { probeOtlpEndpoint } from "../../observability/otlp-exporter";
import { aggregateUsageStats } from "../../model/usage-stats";
import { readTraceRuns } from "../trace";
import type { CommandHandler } from "../command";

/** 密钥作用域展开：协议层收"层级"（global|workspace），落库用展开串（workspace:<cwd>） */
function expandSecretScope(scope: unknown, cwd: unknown): string | null {
  if (scope !== "workspace") return "global";
  const dir = typeof cwd === "string" ? cwd.trim() : "";
  return dir ? workspaceScope(dir) : null;
}

/** 密钥页整包应答：清单（无明文）+ 绑定策略，改完即回以刷新 UI */
async function secretsPayload() {
  const config = getSecretsConfig();
  return {
    entries: await secretList(),
    enabled: config.enabled,
    bindings: config.bindings,
  };
}

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
    // （0.99 迁移：提示词由转录首条 system 消息承载，热换走 setLeadingSystemMessage）
    for (const run of running.values()) {
      setLeadingSystemMessage(
        run.agent.state.messages,
        composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model, run.designTheme),
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
      const prompt = composeModeSystemPrompt(
        run.mode,
        run.cwd,
        run.agent.state.model,
        run.designTheme,
      );
      setLeadingSystemMessage(run.agent.state.messages, prompt);
      // 轮中切换：活循环读的是 loopContext 转录首条的提示词，只改 agent.state 等于
      // 没改——本轮后续请求仍带旧模式段（design 段里含设计主题句，切到
      // code/work 后模型仍在按旧模式行事）。其余重排点（applySessionTheme /
      // recomposeAllRuns / applyMode）都写了这一行，此处原先漏了。
      if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
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
      setLeadingSystemMessage(
        run.agent.state.messages,
        composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model, run.designTheme),
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

  get_imagegen: async (reqId) => {
    send({ id: reqId, type: "imagegen", settings: getImageGenConfig() });
  },

  set_imagegen: async (reqId, msg) => {
    // 同款机制（imagegen-config.ts）：generate_image 无提示词注入块，写完即生效
    const settings = await applyImageGenConfig(msg.settings);
    send({ id: reqId, type: "imagegen", settings });
  },

  get_observability: async (reqId) => {
    send({ id: reqId, type: "observability", settings: getObservabilityConfig() });
  },

  /* -------------------------------- 密钥库 --------------------------------
   * 清单只回名字与掩码（明文无 RPC 出口，见 docs/secrets-env-design.md §1.1）；
   * 值写入直接转 Rust secret_set 加密落盘，sidecar 不持有明文。 */
  list_secrets: async (reqId) => {
    send({ id: reqId, type: "secrets", ...(await secretsPayload()) });
  },

  save_secret: async (reqId, msg) => {
    const name = String(msg.name ?? "").trim();
    if (!isValidSecretName(name)) {
      throw new Error(
        "save_secret: name must match [A-Za-z_][A-Za-z0-9_]* (it becomes an env var name)",
      );
    }
    const scope = expandSecretScope(msg.scope, msg.cwd);
    if (!scope) throw new Error("save_secret: workspace scope requires cwd");
    const value = typeof msg.value === "string" ? msg.value : "";
    if (value) {
      await secretSet(name, scope, value);
    } else {
      // 值留空 = 不改值（编辑弹窗不回填明文，同 provider key 的处理）。
      // 但新建时必须给值，否则会出现一条指向空密钥的绑定。
      const entries = await secretList();
      if (!entries.some((e) => e.name === name && e.scope === scope)) {
        throw new Error("save_secret: value is required for a new secret");
      }
    }
    // 技能白名单随同一次保存下发（表单一个弹窗搞定）：给了就整条替换该名字的绑定
    if (Array.isArray(msg.skills)) {
      const skills = (msg.skills as unknown[])
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim());
      const config = getSecretsConfig();
      await applySecretsConfig({
        enabled: config.enabled,
        bindings: [
          ...config.bindings.filter((b) => b.name !== name),
          ...(skills.length ? [{ name, scope: msg.scope === "workspace" ? "workspace" : "global", skills }] : []),
        ],
      });
    }
    send({ id: reqId, type: "secrets", ...(await secretsPayload()) });
  },

  delete_secret: async (reqId, msg) => {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error("delete_secret: name is required");
    const scope = expandSecretScope(msg.scope, msg.cwd);
    if (!scope) throw new Error("delete_secret: workspace scope requires cwd");
    await secretDelete(name, scope);
    // 值没了就把绑定一并摘掉，避免留下指向空密钥的授权
    const config = getSecretsConfig();
    if (config.bindings.some((b) => b.name === name)) {
      await applySecretsConfig({
        enabled: config.enabled,
        bindings: config.bindings.filter((b) => b.name !== name),
      });
    }
    send({ id: reqId, type: "secrets", ...(await secretsPayload()) });
  },

  save_secret_bindings: async (reqId, msg) => {
    const config = getSecretsConfig();
    await applySecretsConfig({
      enabled: typeof msg.enabled === "boolean" ? msg.enabled : config.enabled,
      bindings: Array.isArray(msg.bindings) ? msg.bindings : config.bindings,
    });
    send({ id: reqId, type: "secrets", ...(await secretsPayload()) });
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
      setLeadingSystemMessage(
        run.agent.state.messages,
        composeModeSystemPrompt(run.mode, run.cwd, run.agent.state.model, run.designTheme),
      );
    }
    send({ id: reqId, type: "memory_file_saved", scope, file: saved.rel, bytes: saved.bytes });
  },
};
