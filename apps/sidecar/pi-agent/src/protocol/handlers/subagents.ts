/**
 * 子智能体定义命令：清单/保存/删除/开关/设模型（保存类命令改完热重载再回清单）。
 * 定义三层发现与落盘在 subagent/subagent-definitions.ts，重载在 sessions。
 */
import { send } from "../stream";
import { reloadSubagents } from "../../sessions/sessions";
import {
  deleteSubagentDefinition,
  loadSubagentDefinitions,
  parseSubagentDraftYaml,
  saveSubagentDefinition,
  setSubagentEnabled,
  setSubagentModelOverride,
  type SubagentDraft,
  type SubagentScope,
} from "../../subagent/subagent-definitions";
import { subagentsPayload } from "../payloads";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  list_subagents: async (reqId, msg) => {
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
  },

  save_subagent: async (reqId, msg) => {
    const scope: SubagentScope | null =
      msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
    if (!scope) throw new Error('save_subagent: scope must be "system" or "workspace"');
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (scope === "workspace" && !cwd) {
      throw new Error("save_subagent: workspace scope requires cwd");
    }
    // 两种载荷：表单结构体（definition）或 YAML 原文（raw，走同一解析校验）
    let draft: SubagentDraft;
    if (typeof msg.raw === "string") {
      const parsed = parseSubagentDraftYaml(msg.raw, scope);
      if (!parsed.ok) throw new Error(parsed.errors.join("; "));
      draft = parsed.draft;
    } else {
      const d = (msg.definition ?? {}) as Record<string, unknown>;
      draft = {
        name: String(d.name ?? ""),
        description: String(d.description ?? ""),
        tools: Array.isArray(d.tools) ? d.tools.map((t) => String(t).toLowerCase()) : [],
        prompt: String(d.prompt ?? ""),
        ...(typeof d.maxTurns === "number" ? { maxTurns: d.maxTurns } : {}),
        ...(typeof d.model === "string" && d.model.trim() ? { model: d.model.trim() } : {}),
      };
    }
    // name = 编辑前的原名（改名时据此清掉旧文件；新建省略）
    const replaceName =
      typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : undefined;
    await saveSubagentDefinition(scope, draft, { cwd, replaceName });
    await reloadSubagents();
    send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
  },

  delete_subagent: async (reqId, msg) => {
    const scope: SubagentScope | null =
      msg.scope === "workspace" ? "workspace" : msg.scope === "system" ? "system" : null;
    if (!scope) throw new Error('delete_subagent: scope must be "system" or "workspace"');
    const name = String(msg.name ?? "");
    if (!name) throw new Error("delete_subagent: name is required");
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    if (scope === "workspace" && !cwd) {
      throw new Error("delete_subagent: workspace scope requires cwd");
    }
    await deleteSubagentDefinition(scope, name, { cwd });
    await reloadSubagents();
    send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
  },

  set_subagent_enabled: async (reqId, msg) => {
    const scope: SubagentScope | null =
      msg.scope === "builtin" ||
      msg.scope === "system" ||
      msg.scope === "workspace" ||
      msg.scope === "plugin"
        ? msg.scope
        : null;
    if (!scope) throw new Error("set_subagent_enabled: invalid scope");
    const name = String(msg.name ?? "");
    if (!name) throw new Error("set_subagent_enabled: name is required");
    const pluginId =
      scope === "plugin" && typeof msg.pluginId === "string" ? msg.pluginId : undefined;
    if (scope === "plugin" && !pluginId) {
      throw new Error("set_subagent_enabled: plugin scope requires pluginId");
    }
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    const enabled = msg.enabled === true;
    await setSubagentEnabled(scope, name, enabled, cwd, pluginId);
    await reloadSubagents();
    send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
  },

  // 模型覆盖走 kv 而不是定义文件：内置/插件两层永不落盘，只能这样选模型。
  // 重载是必需的——工具闭包捕获的是 definitions 数组，不重载当次会话仍拿着旧的 model。
  set_subagent_model: async (reqId, msg) => {
    const scope: SubagentScope | null =
      msg.scope === "builtin" ||
      msg.scope === "system" ||
      msg.scope === "workspace" ||
      msg.scope === "plugin"
        ? msg.scope
        : null;
    if (!scope) throw new Error("set_subagent_model: invalid scope");
    const name = String(msg.name ?? "");
    if (!name) throw new Error("set_subagent_model: name is required");
    const pluginId =
      scope === "plugin" && typeof msg.pluginId === "string" ? msg.pluginId : undefined;
    if (scope === "plugin" && !pluginId) {
      throw new Error("set_subagent_model: plugin scope requires pluginId");
    }
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    // 空串 = 清除覆盖，回落定义自带 model，再回落会话模型
    const model = typeof msg.model === "string" ? msg.model : "";
    await setSubagentModelOverride(scope, name, model, cwd, pluginId);
    await reloadSubagents();
    send({ id: reqId, type: "subagents", ...(await subagentsPayload(cwd)) });
  },
};
