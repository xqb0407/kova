/**
 * 插件命令：清单/开关/卸载走变更-重载-回清单；市场添加/刷新/安装是耗时操作
 * （git clone / 大目录复制），受理即应答 plugin_op_accepted，后台执行完成后
 * 自发 plugin_op_result 帧（载荷见 payloads.ts，写路径见 plugins/marketplaces.ts）。
 */
import { basename } from "node:path";
import { logErr } from "../../log";
import { send } from "../stream";
import { readPluginPanelAsset, readPluginPanelRev } from "../../plugins/store";
import {
  addMarketplace,
  installLocalPlugin,
  installPlugin,
  refreshMarketplace,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from "../../plugins/plugins";
import { nextFallbackSeq } from "../command";
import { readPluginComponentDoc } from "../plugin-component-docs";
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
  // 直接安装任意本地插件目录（不经市场）：path 指向含三态清单的插件根
  install_plugin_local: pluginOp,

  /**
   * UI 插件面板入口 HTML（blob 挂载进 sandboxed iframe 的数据源）：
   * 未装/禁用/面板不存在回 error；rev = mtime+size 供前端 rev 协商与重载判据。
   */
  get_plugin_panel_asset: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    const panelId = String(msg.panelId ?? "");
    if (!pluginId || !panelId) {
      throw new Error("get_plugin_panel_asset: pluginId and panelId are required");
    }
    const asset = readPluginPanelAsset(pluginId, panelId);
    if (!asset) {
      send({
        id: reqId,
        type: "error",
        errorText: `get_plugin_panel_asset: 面板不可用（未安装/未启用/不存在）：${panelId}@${pluginId}`,
      });
      return;
    }
    send({
      id: reqId,
      type: "plugin_panel_asset",
      pluginId,
      panelId,
      contentType: "text/html",
      base64: asset.base64,
      rev: asset.rev,
    });
  },

  /**
   * 单个插件组件的正文（插件详情页"查看内容"）：技能 SKILL.md / 子智能体 YAML /
   * MCP 条目 JSON，按需现取。插件未安装或该组件不存在回 error。
   */
  get_plugin_component_doc: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    const kind = String(msg.kind ?? "");
    const name = String(msg.name ?? "");
    if (!pluginId || !name || (kind !== "skill" && kind !== "mcp" && kind !== "subagent")) {
      throw new Error("get_plugin_component_doc: pluginId, kind and name are required");
    }
    const doc = await readPluginComponentDoc(pluginId, kind, name);
    if (!doc) {
      send({
        id: reqId,
        type: "error",
        errorText: `get_plugin_component_doc: 组件不可用（未安装/不存在/读失败）：${name}@${pluginId}`,
      });
      return;
    }
    send({ id: reqId, type: "plugin_component_doc", ...doc });
  },

  /**
   * 面板入口指纹的轻量查询（宿主 dev 自动重载轮询专用）：只 stat 不读文件；
   * 面板不可用回 rev:null（宿主静默停轮，下次挂载再走资产加载）。
   */
  get_plugin_panel_rev: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    const panelId = String(msg.panelId ?? "");
    if (!pluginId || !panelId) {
      throw new Error("get_plugin_panel_rev: pluginId and panelId are required");
    }
    const r = readPluginPanelRev(pluginId, panelId);
    send({
      id: reqId,
      type: "plugin_panel_rev",
      pluginId,
      panelId,
      rev: r?.rev ?? null,
      linked: r?.linked === true,
    });
  },
};

/** 耗时操作（git clone / 大目录复制）：受理即应答，后台执行，完成自发帧 */
async function pluginOp(reqId: string, msg: Record<string, unknown>): Promise<void> {
  const opId = `plugin-op-${Date.now().toString(36)}-${nextFallbackSeq()}`;
  const op =
    msg.type === "add_marketplace"
      ? "add_marketplace"
      : msg.type === "refresh_marketplace"
        ? "refresh_marketplace"
        : msg.type === "install_plugin_local"
          ? "install_plugin_local"
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
      } else if (op === "install_plugin_local") {
        const path = String(msg.path ?? "");
        if (!path.trim()) throw new Error("install_plugin_local: path is required");
        await installLocalPlugin(path);
      } else {
        const marketplaceId = String(msg.marketplaceId ?? "");
        const name = String(msg.name ?? "");
        if (!marketplaceId || !name) {
          throw new Error("install_plugin: marketplaceId and name are required");
        }
        // link 三态：true=链接装 false=强制拷贝装 缺省=保持现有模式
        const link =
          msg.link === true ? true : msg.link === false ? false : undefined;
        await installPlugin(marketplaceId, name, link === undefined ? {} : { link });
      }
      // 载荷里的 type 字段弃用，结果帧以 plugin_op_result 为准
      const { type: _pType, ...pluginsData } = await pluginsPayload(cwd);
      const { type: _mType, ...marketplacesData } = marketplacesPayload();
      // 安装类操作附带目标插件名（结果帧到达时前端 pending 可能尚未登记，
      // 成功提示不依赖 key）：本地安装的清单校验保证 name === 目录 basename
      const targetName =
        op === "install_plugin"
          ? String(msg.name ?? "")
          : op === "install_plugin_local"
            ? basename(String(msg.path ?? ""))
            : "";
      send({
        type: "plugin_op_result",
        opId,
        op,
        ok: true,
        ...(targetName ? { name: targetName } : {}),
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
