/**
 * 插件命令：清单/开关/卸载走变更-重载-回清单；市场添加/刷新/安装是耗时操作
 * （git clone / 大目录复制），受理即应答 plugin_op_accepted，后台执行完成后
 * 自发 plugin_op_result 帧（载荷见 payloads.ts，写路径见 plugins/marketplaces.ts）。
 */
import { logErr } from "../../log";
import { send } from "../stream";
import {
  addMarketplace,
  installPlugin,
  refreshMarketplace,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from "../../plugins/plugins";
import { nextFallbackSeq } from "../command";
import { marketplacesPayload, pluginsPayload, reloadAllPluginComponents } from "../payloads";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  list_plugins: async (reqId, msg) => {
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    send({ id: reqId, ...(await pluginsPayload(cwd)) });
  },

  set_plugin_enabled: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    if (!pluginId) throw new Error("set_plugin_enabled: pluginId is required");
    await setPluginEnabled(pluginId, msg.enabled === true);
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    await reloadAllPluginComponents(cwd);
    send({ id: reqId, ...(await pluginsPayload(cwd)) });
  },

  uninstall_plugin: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    if (!pluginId) throw new Error("uninstall_plugin: pluginId is required");
    await uninstallPlugin(pluginId);
    const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
    await reloadAllPluginComponents(cwd);
    send({ id: reqId, ...(await pluginsPayload(cwd)) });
  },

  list_marketplaces: async (reqId) => {
    send({ id: reqId, ...marketplacesPayload() });
  },

  remove_marketplace: async (reqId, msg) => {
    // 注意：不能用 "id" 字段——传输层会注入请求 id 覆盖它（mgr-pi-*），
    // 市场身份用 marketplaceId（与 install_plugin 一致）
    const marketplaceId = String(msg.marketplaceId ?? "");
    if (!marketplaceId) throw new Error("remove_marketplace: marketplaceId is required");
    removeMarketplace(marketplaceId);
    send({ id: reqId, ...marketplacesPayload() });
  },

  add_marketplace: pluginOp,
  refresh_marketplace: pluginOp,
  install_plugin: pluginOp,
};

/** 耗时操作（git clone / 大目录复制）：受理即应答，后台执行，完成自发帧 */
async function pluginOp(reqId: string, msg: Record<string, unknown>): Promise<void> {
  const opId = `plugin-op-${Date.now().toString(36)}-${nextFallbackSeq()}`;
  const op =
    msg.type === "add_marketplace"
      ? "add_marketplace"
      : msg.type === "refresh_marketplace"
        ? "refresh_marketplace"
        : "install_plugin";
  send({ id: reqId, type: "plugin_op_accepted", opId, op });
  const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd : undefined;
  void (async () => {
    try {
      if (op === "add_marketplace") {
        const type = msg.mtype === "git" ? "git" : "directory";
        if (type === "git" && typeof msg.repo !== "string") {
          throw new Error("add_marketplace: repo is required");
        }
        if (type === "directory" && typeof msg.path !== "string") {
          throw new Error("add_marketplace: path is required");
        }
        await addMarketplace({
          type,
          ...(type === "git" ? { repo: String(msg.repo) } : { path: String(msg.path) }),
        });
      } else if (op === "refresh_marketplace") {
        const marketplaceId = String(msg.marketplaceId ?? "");
        if (!marketplaceId) throw new Error("refresh_marketplace: marketplaceId is required");
        await refreshMarketplace(marketplaceId);
      } else {
        const marketplaceId = String(msg.marketplaceId ?? "");
        const name = String(msg.name ?? "");
        if (!marketplaceId || !name) {
          throw new Error("install_plugin: marketplaceId and name are required");
        }
        await installPlugin(marketplaceId, name);
      }
      // 载荷里的 type 字段弃用，结果帧以 plugin_op_result 为准
      const { type: _pType, ...pluginsData } = await pluginsPayload(cwd);
      const { type: _mType, ...marketplacesData } = marketplacesPayload();
      send({
        type: "plugin_op_result",
        opId,
        op,
        ok: true,
        ...pluginsData,
        ...marketplacesData,
      });
    } catch (err) {
      logErr(`plugin op ${op}:`, err);
      send({
        type: "plugin_op_result",
        opId,
        op,
        ok: false,
        errorText: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
