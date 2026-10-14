/**
 * MCP 服务器命令：清单/保存/删除/开关/测试/授权/撤销/工具清单/日志/审计。
 * 配置双层合并在 mcp/mcp-config.ts，连接池在 mcp/mcp-manager.ts，
 * 变更后的热重载（连接池 diff）经 payloads.reloadMcpConnections。
 */
import { send } from "../stream";
import { mcpManager } from "../../mcp/mcp-manager";
import { getValidTools } from "../../mcp/mcp-cache";
import { clearOAuthForServer } from "../../mcp/mcp-oauth";
import { readMcpAudit } from "../../mcp/mcp-audit";
import { deleteMcpServer, loadMcpServers, saveMcpServer, setMcpServerEnabled } from "../../mcp/mcp-config";
import { mcpDraftFromMessage, mcpServersPayload, reloadMcpConnections } from "../payloads";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  list_mcp_servers: async (reqId, msg) => {
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  save_mcp_server: async (reqId, msg) => {
    const layer: "system" | "workspace" | null =
      msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
    if (!layer) throw new Error('save_mcp_server: layer must be "system" or "workspace"');
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (layer === "workspace" && !cwd) {
      throw new Error("save_mcp_server: workspace layer requires cwd");
    }
    const draft = mcpDraftFromMessage(msg.definition);
    // name = 编辑前的原名（改名时据此清掉旧条目；新建省略）
    const replaceName =
      typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
    await saveMcpServer(layer, draft, { cwd, replaceName });
    await reloadMcpConnections(cwd);
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  delete_mcp_server: async (reqId, msg) => {
    const layer: "system" | "workspace" | null =
      msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
    if (!layer) throw new Error('delete_mcp_server: layer must be "system" or "workspace"');
    const name = String(msg.name ?? "");
    if (!name) throw new Error("delete_mcp_server: name is required");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (layer === "workspace" && !cwd) {
      throw new Error("delete_mcp_server: workspace layer requires cwd");
    }
    // 先记下待删条目：清凭据要用它的 URL
    const { defs: beforeDefs } = await loadMcpServers(cwd);
    const gone = beforeDefs.find((d) => d.name === name && d.layer === layer);
    await deleteMcpServer(layer, name, { cwd });
    await reloadMcpConnections(cwd);
    // 删掉最后一台共用该 URL 的 http 服务器时顺带清 OAuth 凭据：
    // 凭据按 URL 键控，不清的话删除重加仍拿存量 token 静默连，用户无从重置授权
    if (gone?.transport === "http" && gone.url) {
      const url = String(gone.url);
      const { defs: afterDefs } = await loadMcpServers(cwd);
      const stillUsed = afterDefs.some(
        (d) => d.transport === "http" && String(d.url ?? "") === url,
      );
      if (!stillUsed) clearOAuthForServer(url);
    }
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
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const enabled = msg.enabled === true;
    await setMcpServerEnabled(layer, name, enabled, cwd, pluginId);
    await reloadMcpConnections(cwd);
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  test_mcp_server: async (reqId, msg) => {
    const layer: "system" | "workspace" | null =
      msg.layer === "workspace" ? "workspace" : msg.layer === "system" ? "system" : null;
    if (!layer) throw new Error("test_mcp_server: invalid layer");
    const name = String(msg.name ?? "");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name && d.layer === layer);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 强制重新握手：先断开（清掉退避期与失败状态），再按当前定义连接。
    // 应答直接取 statusFor 的完整状态，不要手拼字段——前端测试后把该行状态
    // 整段覆盖写回快照，手拼漏掉的字段（如 oauthAuthorized：「取消授权」按钮
    // 判据，凭据按 URL 键控与刚是否握手无关）会凭空消失。
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
  },

  authorize_mcp_server: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("authorize_mcp_server: name is required");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 交互式 OAuth：sidecar 开浏览器 + 本地回调等用户批准，可能长达几分钟
    await mcpManager.authorize(def);
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  revoke_mcp_server_auth: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("revoke_mcp_server_auth: name is required");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    mcpManager.revokeAuth(def);
    send({ id: reqId, type: "mcp_servers", ...(await mcpServersPayload(cwd)) });
  },

  get_mcp_server_tools: async (reqId, msg) => {
    const name = String(msg.name ?? "");
    if (!name) throw new Error("get_mcp_server_tools: name is required");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const { defs } = await loadMcpServers(cwd);
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`mcp server not found: ${name}`);
    // 元数据缓存优先（断开态也可读），缺失才握手——懒服务器首次展开会真连一次
    const tools = getValidTools(def) ?? (await mcpManager.ensureConnected(def));
    send({
      id: reqId,
      type: "mcp_server_tools",
      name,
      tools: tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      })),
    });
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
