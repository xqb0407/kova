/**
 * 偏好与观测命令：个性化/工作模式/记忆/钩子/浏览器驱动/密钥库/OTLP 观测/使用统计/轨迹。
 * 变更后的活动会话系统提示词热替换走同一套 composeModeSystemPrompt 整段重排。
 */
import { send, sendSessionsChanged } from "../stream";
import { logErr } from "../../log";
import { findRunBySession, reloadMemoryTools, running } from "../../sessions/sessions";
import { composeRunPrompt } from "../../agent/modes";
import { setLeadingSystemMessage } from "../../agent/context";
import {
  applyPersonalization,
  getPersonalization,
  rulesFilePath,
  soulFilePath,
} from "../../agent/personalization";
import {
  applyAppMode,
  effectiveAppMode,
  getAppMode,
  normalizeAppMode,
  type AppMode,
} from "../../agent/app-mode";
import {
  applyMemoryConfig,
  deleteMemoryTrash,
  deleteMemoryVersion,
  emptyMemoryTrash,
  getMemoryConfig,
  listMemoryTrash,
  listMemoryVersions,
  memoryScopesPayload,
  readMemoryFile,
  readMemoryVersion,
  restoreMemoryTrash,
  restoreMemoryVersion,
  snapshotMemoryVersion,
  trashMemoryFile,
  writeMemoryFile,
  type MemoryScope,
} from "../../agent/memory";
import { getHookConfigs, setHookConfigs } from "../../agent/hooks";
import { applyBrowserConfig, getBrowserConfig } from "../../tools/browser-config";
import { applyMirrorConfig, getMirrorConfig } from "../../tools/mirror-config";
import { applyImageGenConfig, getImageGenConfig } from "../../tools/imagegen-config";
import {
  applySecretsConfig,
  getSecretsConfig,
  isValidSecretName,
  workspaceScope,
} from "../../secrets/secrets";
import {
  secretDelete,
  secretList,
  secretSet,
  sessionGet,
  sessionPrefsSet,
} from "../../storage/hostdb";
import type { Running } from "../../types";
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

/** 整段重排单会话系统提示词（工作模式/个性化等段变更后）。
 *  除 agent.state 外必须同改 loopContext 转录首条：活循环每轮请求读的是后者，
 *  只改前者等于没改——轮中切档本轮后续请求仍带旧模式段（0.99 迁移补漏点）。 */
function recomposeRunPrompt(run: Running): void {
  const prompt = composeRunPrompt(run, run.agent.state.model);
  setLeadingSystemMessage(run.agent.state.messages, prompt);
  if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
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

/** 记忆命令的作用域/目录解析（工作区作用域必须带 cwd；错误信息带命令名便于排查） */
function memoryTarget(
  command: string,
  msg: Record<string, unknown>,
): { scope: MemoryScope; cwd: string } {
  const scope: MemoryScope = msg.scope === "workspace" ? "workspace" : "global";
  const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : "";
  if (scope === "workspace" && !cwd) {
    throw new Error(`${command}: workspace scope requires cwd`);
  }
  return { scope, cwd };
}

/** 记忆内容可能正被注入系统提示词：写入/删除/恢复后整段重排活动会话（与 set_memory 同款）。
 *  除 agent.state 外必须同改 loopContext 转录首条：活循环每轮请求读的是后者，
 *  只改前者等于没改——轮中关掉记忆后本轮后续请求仍带着记忆段（与 recomposeRunPrompt 同一漏点） */
function restampMemoryPrompt(): void {
  for (const run of running.values()) {
    const prompt = composeRunPrompt(run, run.agent.state.model);
    setLeadingSystemMessage(run.agent.state.messages, prompt);
    if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
  }
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
        composeRunPrompt(run, run.agent.state.model),
      );
    }
    send({
      id: reqId,
      type: "personalization",
      settings,
      paths: { soul: soulFilePath(), rules: rulesFilePath() },
    });
  },

  get_app_mode: async (reqId, msg) => {
    // 带 sessionId：该会话的生效档（偏好列合法值 ?? 全局默认）；不带：全局默认。
    // 前端正常路径从会话列表偏好水合，这里只作兜底/诊断直查
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    if (sessionId) {
      const row = await sessionGet(sessionId);
      send({ id: reqId, type: "app_mode", mode: effectiveAppMode(row?.appMode) });
      return;
    }
    send({ id: reqId, type: "app_mode", mode: getAppMode() });
  },

  set_app_mode: async (reqId, msg) => {
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    // 定靶形态先校验会话存在（与 set_model / set_thinking 同规：被拒命令不得留状态变更）
    if (sessionId && !(await sessionGet(sessionId))) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (sessionId) {
      // 会话定靶（顶栏模式切换器）：只落被点名会话的偏好列 + 只重排该会话提示词。
      // 全局默认（kv pi.app_mode）不漂移——A 会话切档不得牵连 B 会话
      const mode = normalizeAppMode(msg.mode);
      const owner = findRunBySession(sessionId);
      if (owner) {
        owner.run.appMode = mode;
        recomposeRunPrompt(owner.run);
      }
      await sessionPrefsSet(sessionId, { appMode: mode }).catch(() => {});
      sendSessionsChanged("updated", sessionId);
      send({ id: reqId, type: "app_mode", mode });
      return;
    }
    // 全局默认变更（设置 → 通用 / onboarding）：落 kv 供新会话与从未定靶的会话跟随；
    // 驻留 run 只重排「偏好列为空」的那些（NULL = 真值跟随全局默认），
    // 已在本会话切过档的保持自己的选择（与 set_thinking 的默认档分支同型）
    const mode = await applyAppMode(msg.mode);
    for (const run of running.values()) {
      const row = await sessionGet(run.sessionId);
      if (row?.appMode) continue;
      run.appMode = mode;
      recomposeRunPrompt(run);
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
    const prevEnabled = getMemoryConfig().enabled;
    const settings = await applyMemoryConfig(msg.settings);
    // 总开关翻转：记忆三件套按开关条件注册，整表重建活动会话——关 = 工具收回，
    // 开 = 重新下发（细项改动不重建，execute 内实时读配置门控）
    if (settings.enabled !== prevEnabled) await reloadMemoryTools();
    // 与 set_personalization 同款广播：记忆段变了就整段重排系统提示词（含活循环上下文）
    restampMemoryPrompt();
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

  get_mirror: async (reqId) => {
    send({ id: reqId, type: "mirror", settings: getMirrorConfig() });
  },

  set_mirror: async (reqId, msg) => {
    // 只落 kv：WebFetch 与 bash 的 git 注入每次调用实时读，写完即生效
    const settings = await applyMirrorConfig(msg.settings);
    send({ id: reqId, type: "mirror", settings });
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
    const { scope, cwd } = memoryTarget("read_memory_file", msg);
    const file = String(msg.file ?? "");
    if (!file.trim()) throw new Error("read_memory_file: file is required");
    const res = await readMemoryFile(getMemoryConfig(), scope, cwd, file);
    if (res.kind !== "text") throw new Error(`memory file not found: ${file}`);
    // 外部编辑器改过的内容在这里补一版历史（与最新一版相同则跳过，反复打开无副作用）。
    // 总开关关闭时不补：关 = 不写入，看一眼文件不该留下任何落盘（重开记忆后首次查看再补）
    if (getMemoryConfig().enabled) {
      await snapshotMemoryVersion(scope, cwd, file, "external").catch((err) =>
        logErr("memory: external snapshot failed:", err),
      );
    }
    send({ id: reqId, type: "memory_file", file, content: res.content });
  },

  write_memory_file: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("write_memory_file", msg);
    const file = String(msg.file ?? "");
    const content = String(msg.content ?? "");
    // 整体覆盖保存（设置页编辑语义）；文件名/路径校验在 writeMemoryFile 内
    const saved = await writeMemoryFile(scope, cwd, file, content, "overwrite", "page");
    restampMemoryPrompt();
    send({ id: reqId, type: "memory_file_saved", scope, file: saved.rel, bytes: saved.bytes });
  },

  list_memory_versions: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("list_memory_versions", msg);
    const file = String(msg.file ?? "");
    if (!file.trim()) throw new Error("list_memory_versions: file is required");
    send({ id: reqId, type: "memory_versions", file, versions: listMemoryVersions(scope, cwd, file) });
  },

  read_memory_version: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("read_memory_version", msg);
    const file = String(msg.file ?? "");
    const versionId = String(msg.versionId ?? "");
    const content = await readMemoryVersion(scope, cwd, file, versionId);
    send({ id: reqId, type: "memory_version", file, versionId, content });
  },

  restore_memory_version: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("restore_memory_version", msg);
    const file = String(msg.file ?? "");
    const versionId = String(msg.versionId ?? "");
    // 恢复 = 把该版内容写回（来源 restore，写回本身也进历史）；内容在注入里，需热替换
    const saved = await restoreMemoryVersion(scope, cwd, file, versionId);
    restampMemoryPrompt();
    send({ id: reqId, type: "memory_version_restored", scope, file: saved.rel, bytes: saved.bytes, versionId });
  },

  delete_memory_version: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("delete_memory_version", msg);
    const file = String(msg.file ?? "");
    const versionId = String(msg.versionId ?? "");
    await deleteMemoryVersion(scope, cwd, file, versionId);
    send({ id: reqId, type: "memory_version_deleted", file, versionId });
  },

  trash_memory_file: async (reqId, msg) => {
    // 删除 = 移入回收站（可恢复）；内容可能正被注入，删后同样热替换
    const { scope, cwd } = memoryTarget("trash_memory_file", msg);
    const file = String(msg.file ?? "");
    const res = await trashMemoryFile(scope, cwd, file);
    restampMemoryPrompt();
    send({ id: reqId, type: "memory_file_trashed", scope, file: res.name, trashId: res.id });
  },

  list_memory_trash: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("list_memory_trash", msg);
    send({ id: reqId, type: "memory_trash", scope, entries: listMemoryTrash(scope, cwd) });
  },

  restore_memory_trash: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("restore_memory_trash", msg);
    const trashId = String(msg.trashId ?? "");
    const res = await restoreMemoryTrash(scope, cwd, trashId);
    restampMemoryPrompt();
    send({ id: reqId, type: "memory_trash_restored", scope, file: res.name, trashId });
  },

  delete_memory_trash: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("delete_memory_trash", msg);
    const trashId = String(msg.trashId ?? "");
    await deleteMemoryTrash(scope, cwd, trashId);
    send({ id: reqId, type: "memory_trash_deleted", scope, trashId });
  },

  empty_memory_trash: async (reqId, msg) => {
    const { scope, cwd } = memoryTarget("empty_memory_trash", msg);
    const removed = await emptyMemoryTrash(scope, cwd);
    send({ id: reqId, type: "memory_trash_emptied", scope, removed });
  },
};
