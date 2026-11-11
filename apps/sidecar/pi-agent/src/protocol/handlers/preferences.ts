/**
 * 偏好与观测命令：个性化/工作模式/记忆/钩子/浏览器驱动/密钥库/OTLP 观测/使用统计/轨迹。
 * 变更后的活动会话系统提示词热替换走 modes.rewriteRunPrompt 整段重排。
 */
import { send, sendSessionsChanged } from "../stream";
import { scopedCwd } from "./workspace-cwd";
import { logErr } from "../../log";
import { findRunBySession, reloadMemoryTools, reloadVisionTools, running } from "../../sessions/sessions";
import { isTurnBusy } from "../../sessions/prompt-queue";
import { rewriteRunPrompt } from "../../agent/modes";
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
import {
  getAutoReviewConfig,
  setAutoReviewConfig,
} from "../../permissions/auto-review";
import {
  getSandboxConfig,
  setSandboxConfig,
} from "../../permissions/sandbox-config";
import { invalidateSandboxPlans } from "../../permissions/sandbox-plan";
import {
  getSubagentMaxConcurrency,
  setSubagentMaxConcurrency,
} from "../../subagent/settings";
import { applyBrowserConfig, getBrowserConfig } from "../../tools/browser-config";
import { applyMirrorConfig, getMirrorConfig } from "../../tools/mirror-config";
import { applyImageGenConfig, getImageGenConfig } from "../../tools/imagegen-config";
import {
  applyVisionToolConfig,
  getVisionToolConfig,
} from "../../tools/vision-tool-config";
import {
  applyAutoVerifyConfig,
  getAutoVerifyConfig,
} from "../../agent/verify-run";
import {
  applySecretsConfig,
  getSecretsConfig,
  isValidSecretName,
  workspaceScope,
} from "../../secrets/secrets";
import { mcpManager } from "../../mcp/mcp-manager";
import {
  secretCipherStatus,
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
import { readLiveRun, readTraceRuns } from "../trace";
import type { CommandHandler } from "../command";

/** 密钥作用域展开：协议层收"层级"（global|workspace），落库用展开串（workspace:<cwd>） */
function expandSecretScope(scope: unknown, cwd: unknown): string | null {
  if (scope !== "workspace") return "global";
  const dir = scopedCwd(cwd);
  return dir ? workspaceScope(dir) : null;
}

/** 整段重排单会话系统提示词（工作模式/个性化等段变更后）。
 *  除 agent.state 外必须同改 loopContext 转录首条：活循环每轮请求读的是后者，
 *  只改前者等于没改——轮中切档本轮后续请求仍带旧模式段（0.99 迁移补漏点）。 */
function recomposeRunPrompt(run: Running): void {
  rewriteRunPrompt(run, run.agent.state.model);
}

/** 密钥页整包应答：清单（无明文）+ 绑定策略，改完即回以刷新 UI */
async function secretsPayload() {
  const config = getSecretsConfig();
  return {
    entries: await secretList(),
    enabled: config.enabled,
    bindings: config.bindings,
    // 主密钥保护方式：Electron 主进程决定（系统钥匙串 / 0600 文件 / 不可用）
    cipher: await secretCipherStatus(),
  };
}

/** 记忆命令的作用域/目录解析（工作区作用域必须带 cwd；错误信息带命令名便于排查） */
function memoryTarget(
  command: string,
  msg: Record<string, unknown>,
): { scope: MemoryScope; cwd: string } {
  const scope: MemoryScope = msg.scope === "workspace" ? "workspace" : "global";
  const cwd = scopedCwd(msg.cwd) ?? "";
  if (scope === "workspace" && !cwd) {
    throw new Error(`${command}: workspace scope requires cwd`);
  }
  return { scope, cwd };
}

/** 记忆内容可能正被注入系统提示词：写入/删除/恢复后让**正在跑的**会话立即生效。
 *
 *  空闲会话不在这里重排：memory 是易变段（VOLATILE_PROMPT_BLOCK_KEYS），下一轮
 *  runTurnBody 的 syncRunPrompt 会检测到差异并作为尾部隐藏提醒投递——首条 system
 *  保持旧字节，整段前缀缓存保住。整段重写一次可能让十万级 prompt 全价重建。
 *  忙轮必须立即重写：尾部更新要等下一条用户消息才 drain，本轮后续请求仍会带着
 *  旧记忆段。除 agent.state 外 rewriteRunPrompt 同改 loopContext 转录首条——活循环
 *  每轮请求读的是后者，只改前者等于没改。 */
function restampMemoryPrompt(): void {
  for (const run of running.values()) {
    if (!isTurnBusy(run.threadId)) continue;
    rewriteRunPrompt(run, run.agent.state.model);
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

  /**
   * 在飞 run 的增量视图（trace.ts 的 live 文件）。与 trace_query 分开是省 IO：
   * trace_query 要读整个主文件（可达 5MB）并逐行 parse，面板按秒轮询太浪费。
   */
  trace_live_query: async (reqId, msg) => {
    const traceSession = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    if (!traceSession) throw new Error("trace_live_query: sessionId is required");
    send({ id: reqId, type: "trace_live_query", runs: readLiveRun(traceSession) });
  },

  set_personalization: async (reqId, msg) => {
    const settings = await applyPersonalization(msg.settings);
    // 与 set_thinking 同款广播：个性化段变了就整段重排系统提示词，活动会话
    // 下一轮请求即生效；rewriteRunPrompt 内部读取当前设置并同步 state/loopContext。
    for (const run of running.values()) {
      rewriteRunPrompt(run, run.agent.state.model);
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

  set_auto_review: async (reqId, msg) => {
    await setAutoReviewConfig(msg.settings);
    send({ id: reqId, type: "auto_review", settings: getAutoReviewConfig() });
  },

  get_auto_review: async (reqId) => {
    send({ id: reqId, type: "auto_review", settings: getAutoReviewConfig() });
  },

  set_subagent_settings: async (reqId, msg) => {
    const settings = (msg.settings ?? {}) as { maxConcurrency?: unknown };
    const maxConcurrency = await setSubagentMaxConcurrency(settings.maxConcurrency);
    send({ id: reqId, type: "subagent_settings", settings: { maxConcurrency } });
  },

  get_subagent_settings: async (reqId) => {
    send({
      id: reqId,
      type: "subagent_settings",
      settings: { maxConcurrency: getSubagentMaxConcurrency() },
    });
  },

  set_sandbox: async (reqId, msg) => {
    await setSandboxConfig(msg.settings);
    invalidateSandboxPlans();
    send({ id: reqId, type: "sandbox", settings: getSandboxConfig() });
  },

  get_sandbox: async (reqId) => {
    send({ id: reqId, type: "sandbox", settings: getSandboxConfig() });
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

  get_vision_tool: async (reqId) => {
    send({ id: reqId, type: "vision_tool", settings: getVisionToolConfig() });
  },

  get_auto_verify: async (reqId) => {
    send({ id: reqId, type: "auto_verify", settings: getAutoVerifyConfig() });
  },

  set_auto_verify: async (reqId, msg) => {
    // 落 kv 即生效：下一次 agent_end 结算点按新值判定（无需重建工具表）
    const settings = await applyAutoVerifyConfig({
      enabled: (msg.settings as { enabled?: unknown } | undefined)?.enabled === true,
    });
    send({ id: reqId, type: "auto_verify", settings });
  },

  set_vision_tool: async (reqId, msg) => {
    // 开关翻转 = 工具表增删 see_image：先落 kv（内存即时生效），再整组重建
    // 活动会话工具表（与记忆开关同机制，见 resolve.reloadVisionTools）——
    // 关闭后工具立即从工具表消失，提示词回到未引入该能力的状态
    const before = getVisionToolConfig().enabled;
    const settings = await applyVisionToolConfig(msg.settings);
    if (settings.enabled !== before) await reloadVisionTools();
    send({ id: reqId, type: "vision_tool", settings });
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
      // MCP stdio 子进程的环境变量是 spawn 时快照：密钥值变了就踢掉旧连接，
      // 下次调用按当前绑定重新解析（工作区密钥不会进全局 MCP 连接池）。
      if (scope === "global") mcpManager.invalidateSecretValues([name]);
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
    if (scope === "global") mcpManager.invalidateSecretValues([name]);
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
    const cwd = scopedCwd(msg.cwd);
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
