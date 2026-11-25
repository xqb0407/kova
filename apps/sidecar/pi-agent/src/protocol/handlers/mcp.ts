/**
 * MCP 服务器命令：清单/保存/删除/开关/测试/授权/撤销/工具清单/日志/审计。
 * 配置双层合并在 mcp/mcp-config.ts，连接池在 mcp/mcp-manager.ts，
 * 变更后的热重载（连接池 diff）经 payloads.reloadMcpConnections。
 */
import { send } from "../stream";
import { scopedCwd } from "./workspace-cwd";
import { logErr } from "../../log";
import { beginOp, endOp } from "../exit";
import { classifyAgentError, toWireError } from "../../agent/agent-errors";
import { mcpManager } from "../../mcp/mcp-manager";
import {
  getValidServerMeta,
  getValidTools,
  isToolVisibleToApp,
} from "../../mcp/mcp-cache";
import {
  formatResourceContents,
  guardMcpText,
  splitMcpContent,
} from "../../mcp/mcp-output-guard";
import { clearOAuthForServer } from "../../mcp/mcp-oauth";
import { readMcpAudit } from "../../mcp/mcp-audit";
import { deleteMcpServer, loadMcpServers, saveMcpServer, setMcpServerEnabled } from "../../mcp/mcp-config";
import { computeConfigHash, dropServer } from "../../mcp/mcp-cache";
import { deleteMcpSecretBinding, saveMcpSecretBindings } from "../../mcp/mcp-secrets";
import { mcpDraftFromMessage, mcpServersPayload, reloadMcpConnections } from "../payloads";
import type { CommandHandler } from "../command";

/** UI 侧资源/Prompt 读取的硬上限：握手另算，这里只约束实际读取阶段。 */
const MCP_UI_READ_TIMEOUT_MS = 30_000;
/** MCP App 的 HTML 文档/工具结果上限：防止 iframe 内存与转录负载失控 */
const MCP_APP_RESOURCE_MAX_BYTES = 4 * 1024 * 1024;
const MCP_APP_TOOL_RESULT_MAX_BYTES = 2 * 1024 * 1024;
const MCP_APP_CALL_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 资源 URI 可能带签名 query/token：管理协议只回去掉参数的展示串 */
function displayUri(uri: string): string {
  return (uri.split(/[?#]/, 1)[0] ?? uri).slice(0, 500);
}

/** 派活式命令的失败回帧（同 optimize_prompt 的出口）：含糊串按运行时归因 */
function sendFailure(reqId: string, errorText: string): void {  send({
    id: reqId,
    type: "error",
    errorText,
    error: toWireError(classifyAgentError(errorText, { opaqueFallback: "runtime" })),
  });
}

/**
 * MCP 服务器增删/启停后重建活动会话工具表：mcp 网关按「是否存在已启用服务器」
 * 条件注册——不重建会停在旧表（一台都没启用时白调一次才被告知，或者加完
 * 服务器仍调不到）。只重建「有没有网关」真的翻转的 run，避免无关会话因一次
 * 设置保存而重写提示词、破坏前缀缓存。动态 import 打断 handler ↔ resolve 的
 * 模块环；重建失败只记日志，不回滚已经落盘的配置。
 */
async function reloadMcpToolTable(): Promise<void> {
  const { reloadMcpToolsIfPresenceChanged } = await import("../../sessions/resolve");
  const failures = await reloadMcpToolsIfPresenceChanged();
  for (const failure of failures) {
    logErr(
      `mcp: tool table rebuild failed for ${failure.threadId} (${failure.sessionId}):`,
      failure.message,
    );
  }
}

export const handlers: Record<string, CommandHandler> = {
  list_mcp_servers: async (reqId, msg) => {
    const cwd = scopedCwd(msg.cwd);
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  /**
   * workspace 切换/配置文件外部变更后的连接池重调：按新 cwd 的启用集合 diff，
   * 断开不再属于当前工作区的服务器（list 本身只读，不会做这件事）。前端切
   * workspace 时调用；响应附带新清单，调用方可直接并入镜像。
   */
  reload_mcp_connections: async (reqId, msg) => {
    const cwd = scopedCwd(msg.cwd);
    await reloadMcpConnections(cwd);
    await reloadMcpToolTable();
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  save_mcp_server: async (reqId, msg) => {
    const layer: "system" | "workspace" | null =
      msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
    if (!layer) throw new Error('save_mcp_server: layer must be "system" or "workspace"');
    const cwd = scopedCwd(msg.cwd);
    if (layer === "workspace" && !cwd) {
      throw new Error("save_mcp_server: workspace layer requires cwd");
    }
    const draft = mcpDraftFromMessage(msg.definition);
    // name = 编辑前的原名（改名时据此清掉旧条目；新建省略）
    const replaceName =
      typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
    await saveMcpServer(layer, draft, { cwd, replaceName });
    const { defs } = await loadMcpServers(cwd);
    const saved = defs.find((d) => d.name === draft.name);
    if (replaceName && replaceName !== draft.name) {
      await deleteMcpSecretBinding(replaceName);
      // 改名后旧名字若已无任何层定义，工具缓存也一并清掉；否则重新添加
      // 同名服务器会先读到旧工具面（search 不握手也能看见）
      if (!defs.some((d) => d.name === replaceName)) dropServer(replaceName);
    }
    if (saved) {
      if (saved.transport !== "stdio") {
        // HTTP：env 绑定没有意义（显式带来则拒绝，避免 UI 以为存上了）；
        // secretHeaders 是 M2.2 的合法绑定通道，走与 env 相同的“配置变更需
        // 显式重新提交”纪律。
        if (Array.isArray(msg.secretEnv) && msg.secretEnv.length > 0) {
          throw new Error("HTTP 传输不支持环境变量密钥注入");
        }
        const editedHash =
          typeof msg.secretBindingHash === "string" ? msg.secretBindingHash : "";
        const hashChanged = editedHash.length > 0 && editedHash !== computeConfigHash(saved);
        const submittedHeaders = Array.isArray(msg.secretHeaders) ? msg.secretHeaders : [];
        if (hashChanged && submittedHeaders.length > 0) {
          await saveMcpSecretBindings(saved, []);
          logErr(
            `mcp: dropped stale secret header binding for "${saved.name}" (config changed)`,
          );
        } else {
          await saveMcpSecretBindings(saved, submittedHeaders);
        }
        // 绑定变了但配置没变时 reloadMcpConnections 不会断连：显式踢掉旧连接，
        // 下次调用/预连用新的 header 重新握手。
        mcpManager.disconnect(saved.name, "secret_binding");
      } else if (Array.isArray(msg.secretEnv)) {
        const submitted = msg.secretEnv;
        const editedHash =
          typeof msg.secretBindingHash === "string" ? msg.secretBindingHash : "";
        const hashChanged = editedHash.length > 0 && editedHash !== computeConfigHash(saved);
        // 配置（命令/参数/env/url/headers）变了而用户只改了服务器字段：
        // 不把旧绑定自动续到新配置上，先解除；要保留必须由 UI 显式重新提交。
        if (hashChanged && submitted.length > 0) {
          await saveMcpSecretBindings(saved, []);
          logErr(
            `mcp: dropped stale secret binding for "${saved.name}" (config changed)`,
          );
        } else {
          await saveMcpSecretBindings(saved, submitted);
        }
        // 绑定变了但配置没变时 reloadMcpConnections 不会断连：显式踢掉旧子进程，
        // 下次调用/预连用新的 env 重新 spawn。
        mcpManager.disconnect(saved.name, "secret_binding");
      }
    }
    await reloadMcpConnections(cwd);
    await reloadMcpToolTable();
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  delete_mcp_server: async (reqId, msg) => {
    const layer: "system" | "workspace" | null =
      msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
    if (!layer) throw new Error('delete_mcp_server: layer must be "system" or "workspace"');
    const name = String(msg.name ?? "");
    if (!name) throw new Error("delete_mcp_server: name is required");
    const cwd = scopedCwd(msg.cwd);
    if (layer === "workspace" && !cwd) {
      throw new Error("delete_mcp_server: workspace layer requires cwd");
    }
    // 先记下待删条目：清凭据要用它的 URL
    const { defs: beforeDefs } = await loadMcpServers(cwd);
    const gone = beforeDefs.find((d) => d.name === name && d.layer === layer);
    await deleteMcpServer(layer, name, { cwd });
    const { defs: afterDefs } = await loadMcpServers(cwd);
    // 只在同名服务器彻底不存在时清绑定；下层还有同名定义就保留，让哈希决定
    // 它是继续生效还是变成 stale（用户仍可在设置页看到并重新确认）。
    if (!afterDefs.some((d) => d.name === name)) {
      await deleteMcpSecretBinding(name);
      // 工具元数据缓存也按名字键控：删干净后不清，重新添加同名同配置的服务器
      // 会先读到上一份工具面（search 不握手也能看见已删服务器的工具）。
      dropServer(name);
    }
    await reloadMcpConnections(cwd);
    // 删掉最后一台共用该 URL 的 http 服务器时顺带清 OAuth 凭据：
    // 凭据按 URL 键控，不清的话删除重加仍拿存量 token 静默连，用户无从重置授权
    if (gone?.transport === "http" && gone.url) {
      const url = String(gone.url);
      const stillUsed = afterDefs.some(
        (d) => d.transport === "http" && String(d.url ?? "") === url,
      );
      if (!stillUsed) clearOAuthForServer(url);
    }
    await reloadMcpToolTable();
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  set_mcp_server_enabled: async (reqId, msg) => {
    const layer: "system" | "workspace" | "plugin" | null =
      msg.layer === "workspace"
        ? "workspace"
        : msg.layer === "system"
          ? "system"
          : msg.layer === "plugin"
            ? "plugin"
            : null;
    if (!layer) throw new Error("set_mcp_server_enabled: invalid layer");
    const name = String(msg.name ?? "");
    if (!name) throw new Error("set_mcp_server_enabled: name is required");
    const pluginId =
      layer === "plugin" && typeof msg.pluginId === "string" ? msg.pluginId : undefined;
    if (layer === "plugin" && !pluginId) {
      throw new Error("set_mcp_server_enabled: plugin layer requires pluginId");
    }
    const cwd = scopedCwd(msg.cwd);
    const enabled = msg.enabled === true;
    await setMcpServerEnabled(layer, name, enabled, cwd, pluginId);
    await reloadMcpConnections(cwd);
    await reloadMcpToolTable();
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  test_mcp_server: async (reqId, msg) => {
    // plugin 层也允许：MCP 设置页的「插件 MCP」分组与连接器面板的未连接行都靠
    // 这条命令做首次握手。插件 server 名在合并链里已全局去重，按 name+layer
    // 即可定位，不需要 pluginId。
    const layer: "system" | "workspace" | "plugin" | null =
      msg.layer === "workspace"
        ? "workspace"
        : msg.layer === "system"
          ? "system"
          : msg.layer === "plugin"
            ? "plugin"
            : null;
    if (!layer) throw new Error("test_mcp_server: invalid layer");
    const name = String(msg.name ?? "");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name && d.layer === layer);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 强制重新握手：先断开（清掉退避期与失败状态），再按当前定义连接。
    // 应答直接取 statusFor 的完整状态，不要手拼字段——前端测试后把该行状态
    // 整段覆盖写回快照，手拼漏掉的字段（如 oauthAuthorized：「取消授权」按钮
    // 判据，凭据按 URL 键控与刚是否握手无关）会凭空消失。
    //
    // **派活不占 mgmt 串行队列**：握手最长 ~20s（连接 10s + 列工具 10s），排在
    // 队列里会把这段时间内所有会话/清单/设置请求一起卡到超时（"哪里都点不了"的
    // 成因之一）。范式同 optimize_prompt：handler 只校验与派活就返回，结果晚点用
    // **同一个 reqId** 发回，前端按长超时等。在飞计数另开一对 beginOp/endOp：
    // handleLine 的 finally 会在 handler 返回时就 endOp，此刻若进程收到 shutdown
    // 会直接退出、把结果丢掉。
    beginOp();
    void (async () => {
      try {
        mcpManager.disconnect(name);
        try {
          await mcpManager.ensureConnected(def);
          send({ id: reqId, type: "mcp_server_test", status: mcpManager.statusFor(def) });
        } catch (err) {
          // 握手失败的 needsAuth（401 需 OAuth）与协议图标一并透出，前端据 needsAuth 显示「授权」
          const s = mcpManager.statusFor(def);
          send({
            id: reqId,
            type: "mcp_server_test",
            status: {
              ...s,
              state: "backoff",
              toolCount: 0,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      } catch (err) {
        // 派活段自身的意外错误：必须回一帧，否则前端干等长超时才收场
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  authorize_mcp_server: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("authorize_mcp_server: name is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 两段式授权（浏览器流程可能长达几分钟，绝不能占着请求配对与 mgmt 串行队列）：
    // 第一阶段只等「授权链接生成」，立刻应答把链接交给前端（前端据此呈现可复制的
    // 链接 + 拉起失败提示）；等用户批准的第二阶段走自发帧，命令当场返回。
    const started = await mcpManager.beginAuthorize(def);
    send({
      id: reqId,
      type: "mcp_auth_started",
      name,
      ...(started.authUrl ? { authUrl: started.authUrl } : {}),
      ...(started.browserOpened !== undefined ? { browserOpened: started.browserOpened } : {}),
      status: started.status,
    });
    void started.completed.then(async (result) => {
      try {
        send({
          type: "mcp_auth_result",
          name,
          ok: result.ok,
          ...(result.ok ? {} : { errorText: result.message }),
          ...(await mcpServersPayload(cwd)),
        });
      } catch (err) {
        logErr("mcp_auth_result 推送失败:", err);
      }
    });
  },

  revoke_mcp_server_auth: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("revoke_mcp_server_auth: name is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    mcpManager.revokeAuth(def);
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  get_mcp_server_tools: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("get_mcp_server_tools: name is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 元数据缓存优先（断开态也可读，同步返回）；缺失才握手——懒服务器首次展开会
    // 真连一次（最长 ~20s），同样派活不占 mgmt 串行队列（见 test_mcp_server 注释）
    const toWire = (tools: ReadonlyArray<{ name: string; description?: string }>) =>
      tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      }));
    const cached = getValidTools(def);
    if (cached) {
      send({ id: reqId, type: "mcp_server_tools", name, tools: toWire(cached) });
      return;
    }
    beginOp();
    void (async () => {
      try {
        const tools = await mcpManager.ensureConnected(def);
        send({ id: reqId, type: "mcp_server_tools", name, tools: toWire(tools) });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  list_mcp_resources: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("list_mcp_resources: name is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 缓存优先：断开态也能浏览上次握手拿到的资源面；缺失才懒连接（派活）。
    const cached = getValidServerMeta(def);
    if (cached) {
      send({
        id: reqId,
        type: "mcp_resources",
        name,
        resources: cached.resources,
        resourceTemplates: cached.resourceTemplates,
        capabilities: cached.capabilities,
      });
      return;
    }
    beginOp();
    void (async () => {
      try {
        await mcpManager.ensureConnected(def);
        const live = mcpManager.getLiveServerMeta(def);
        send({
          id: reqId,
          type: "mcp_resources",
          name,
          resources: live?.resources ?? [],
          resourceTemplates: live?.resourceTemplates ?? [],
          capabilities: live?.capabilities ?? { resources: false, prompts: false, tasks: false },
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  read_mcp_resource: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    const uri = String(msg.uri ?? "").trim();
    if (!name) throw new Error("read_mcp_resource: name is required");
    if (!uri) throw new Error("read_mcp_resource: uri is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    beginOp();
    void (async () => {
      try {
        const raw = await mcpManager.readResource(
          def,
          uri,
          AbortSignal.timeout(MCP_UI_READ_TIMEOUT_MS),
        );
        const out = formatResourceContents(raw);
        send({
          id: reqId,
          type: "mcp_resource_content",
          name,
          uri: displayUri(uri),
          text: out.text,
          ...(out.truncated ? { truncated: true } : {}),
          originalBytes: out.originalBytes,
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  /**
   * MCP App 渲染资源：返回原始 HTML 与 `_meta.ui`（csp/permissions），不做
   * 文本截断/格式化（App 必须拿到完整文档）。仅接受 text/html。
   */
  read_mcp_app_resource: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    const uri = String(msg.uri ?? "").trim();
    if (!name) throw new Error("read_mcp_app_resource: name is required");
    if (!uri) throw new Error("read_mcp_app_resource: uri is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    beginOp();
    void (async () => {
      try {
        const raw = (await mcpManager.readResource(
          def,
          uri,
          AbortSignal.timeout(MCP_UI_READ_TIMEOUT_MS),
        )) as {
          contents?: Array<{
            uri?: string;
            mimeType?: string;
            text?: string;
            blob?: string;
            _meta?: { ui?: unknown };
          }>;
        };
        const first = raw?.contents?.[0];
        const mimeType = String(first?.mimeType ?? "");
        const text = typeof first?.text === "string" ? first.text : undefined;
        const blob = typeof first?.blob === "string" ? first.blob : undefined;
        if (text === undefined && blob === undefined) {
          throw new Error("MCP resource is empty");
        }
        const bytes =
          text !== undefined
            ? Buffer.byteLength(text, "utf8")
            : Math.floor((blob!.length * 3) / 4);
        if (bytes > MCP_APP_RESOURCE_MAX_BYTES) {
          throw new Error("MCP App resource is too large (limit 4MB)");
        }
        const ui = isRecord(first?._meta?.ui) ? first._meta.ui : undefined;
        send({
          id: reqId,
          type: "mcp_app_resource",
          name,
          uri: displayUri(uri),
          mimeType,
          ...(text !== undefined ? { content: text } : {}),
          ...(blob !== undefined ? { blob } : {}),
          ...(ui ? { meta: ui } : {}),
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  /**
   * MCP App → 工具的调用通道：只允许 visibility 含 "app" 的本服务器工具。
   * 审批语义与模型调用不同（App 是用户正在看的可信界面），但仍走连接池的
   * 工具名白名单、超时、审计与密钥脱敏。
   */
  call_mcp_app_tool: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    const tool = String(msg.tool ?? "").trim();
    if (!name) throw new Error("call_mcp_app_tool: name is required");
    if (!tool) throw new Error("call_mcp_app_tool: tool is required");
    const args = isRecord(msg.arguments) ? msg.arguments : {};
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    beginOp();
    void (async () => {
      try {
        await mcpManager.ensureConnected(def);
        const advertised = (mcpManager.getLiveTools(def) ?? []).find((t) => t.name === tool);
        if (!advertised) {
          throw new Error(`MCP server "${name}" does not expose tool "${tool}"`);
        }
        if (!isToolVisibleToApp(advertised)) {
          throw new Error(`MCP tool "${tool}" is not callable from an app (visibility excludes "app")`);
        }
        const raw = await mcpManager.callTool(
          def,
          tool,
          args,
          AbortSignal.timeout(MCP_APP_CALL_TIMEOUT_MS),
        );
        const size = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
        if (size > MCP_APP_TOOL_RESULT_MAX_BYTES) {
          throw new Error("MCP App tool result is too large (limit 2MB)");
        }
        send({
          id: reqId,
          type: "mcp_app_tool_result",
          name,
          tool,
          result: raw ?? null,
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  list_mcp_prompts: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("list_mcp_prompts: name is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    const cached = getValidServerMeta(def);
    if (cached) {
      send({
        id: reqId,
        type: "mcp_prompts",
        name,
        prompts: cached.prompts,
        capabilities: cached.capabilities,
      });
      return;
    }
    beginOp();
    void (async () => {
      try {
        await mcpManager.ensureConnected(def);
        const live = mcpManager.getLiveServerMeta(def);
        send({
          id: reqId,
          type: "mcp_prompts",
          name,
          prompts: live?.prompts ?? [],
          capabilities: live?.capabilities ?? { resources: false, prompts: false, tasks: false },
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  get_mcp_prompt: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    const prompt = String(msg.prompt ?? "").trim();
    if (!name) throw new Error("get_mcp_prompt: name is required");
    if (!prompt) throw new Error("get_mcp_prompt: prompt is required");
    const cwd = scopedCwd(msg.cwd);
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    const rawArgs =
      msg.args && typeof msg.args === "object" && !Array.isArray(msg.args)
        ? (msg.args as Record<string, unknown>)
        : {};
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawArgs)) {
      if (typeof value === "string") args[key] = value;
    }
    beginOp();
    void (async () => {
      try {
        const raw = await mcpManager.getPrompt(
          def,
          prompt,
          args,
          AbortSignal.timeout(MCP_UI_READ_TIMEOUT_MS),
        );
        const result = raw as {
          description?: string;
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        const messages: Array<{ role: string; text: string }> = [];
        const parts: string[] = [];
        if (result.description) parts.push(result.description);
        for (const message of result.messages ?? []) {
          const content =
            message.content == null
              ? []
              : Array.isArray(message.content)
                ? message.content
                : [message.content];
          const split = splitMcpContent(content);
          const role = message.role === "assistant" ? "assistant" : "user";
          const text =
            split.text.trim() ||
            (split.images.length > 0 ? `[${split.images.length} image(s)]` : "");
          messages.push({ role, text });
          if (text) parts.push(text);
        }
        const out = guardMcpText(parts.join("\n\n"));
        send({
          id: reqId,
          type: "mcp_prompt",
          name,
          prompt,
          ...(result.description ? { description: result.description } : {}),
          messages,
          text: out.text,
          ...(out.truncated ? { truncated: true } : {}),
        });
      } catch (err) {
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        endOp();
      }
    })();
  },

  get_mcp_server_log: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("get_mcp_server_log: name is required");
    send({ id: reqId, type: "mcp_server_log", name, lines: mcpManager.logFor(name) });
  },

  get_mcp_audit_log: async (reqId, msg) => {
    const name = typeof msg.name === "string" && msg.name.trim() ? msg.name : undefined;
    const limit =
      typeof msg.limit === "number" && msg.limit > 0 ? Math.min(msg.limit, 1000) : 200;
    send({ id: reqId, type: "mcp_audit_log", events: readMcpAudit({ server: name, limit }) });
  },
};
