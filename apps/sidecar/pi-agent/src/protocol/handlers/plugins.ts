/**
 * 插件命令：清单/开关/卸载走变更-重载-回清单；市场添加/刷新/安装是耗时操作
 * （git clone / 大目录复制），受理即应答 plugin_op_accepted，后台执行完成后
 * 自发 plugin_op_result 帧（载荷见 payloads.ts，写路径见 plugins/marketplaces.ts）。
 */
import { basename } from "node:path";
import { logErr } from "../../log";
import { send } from "../stream";
import { scopedCwd } from "./workspace-cwd";
import { readPluginPanelAsset, readPluginPanelRev } from "../../plugins/store";
import {
  addMarketplace,
  installLocalPlugin,
  installPlugin,
  listInstalledPlugins,
  refreshMarketplace,
  removeMarketplace,
  resolvePluginComponents,
  setPluginEnabled,
  uninstallPlugin,
} from "../../plugins/plugins";
import { nextFallbackSeq } from "../command";
import { readPluginComponentDoc } from "../plugin-component-docs";
import { marketplacePluginPreviewPayload, marketplacesPayload, pluginsPayload, reloadAllPluginComponents } from "../payloads";
import { listPluginMcpComponents, loadMcpServers, loadMcpServersSync } from "../../mcp/mcp-config";
import { dropServer } from "../../mcp/mcp-cache";
import { mcpManager } from "../../mcp/mcp-manager";
import { installPluginDeps, pluginDepsStatus } from "../../plugins/plugin-deps";
import { secretList } from "../../storage/hostdb";
import {
  getPluginConfigState,
  pluginConfigView,
  purgePluginConfig,
  rebindPluginConfig,
  savePluginConfig,
} from "../../plugins/plugin-config";
import { listPluginSkillEntries } from "../../skills/skills";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  list_plugins: async (reqId, msg) => {
    const cwd = scopedCwd(msg.cwd);
    send({ id: reqId, ...(await pluginsPayload(cwd)) });
  },

  set_plugin_enabled: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    if (!pluginId) throw new Error("set_plugin_enabled: pluginId is required");
    await setPluginEnabled(pluginId, msg.enabled === true);
    const cwd = scopedCwd(msg.cwd);
    await reloadAllPluginComponents(cwd);
    send({ id: reqId, ...(await pluginsPayload(cwd)) });
  },

  // 依赖状态：插件详情页判断是否显示「安装依赖」入口
  get_plugin_deps: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    const plugin = listInstalledPlugins().find((p) => p.pluginId === pluginId);
    if (!plugin) throw new Error(`get_plugin_deps: 未找到插件 ${pluginId}`);
    send({
      id: reqId,
      type: "plugin_deps" as const,
      pluginId,
      status: pluginDepsStatus(plugin.manifest.root),
    });
  },

  // 安装依赖是用户显式动作（UI 按钮），默认 --ignore-scripts；完成后断开该插件
  // 的 MCP 连接并重新预热，让之前因缺依赖进入退避的服务器可立即重试。
  install_plugin_deps: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    const plugin = listInstalledPlugins().find((p) => p.pluginId === pluginId);
    if (!plugin) throw new Error(`install_plugin_deps: 未找到插件 ${pluginId}`);
    const result = await installPluginDeps(plugin.manifest.root);
    const cwd = scopedCwd(msg.cwd);
    if (result.ok) {
      const defs = loadMcpServersSync(cwd).defs.filter((def) => def.pluginId === pluginId);
      for (const def of defs) mcpManager.disconnect(def.name, "plugin_deps_installed");
      mcpManager.warmCatalog(defs);
    }
    send({
      id: reqId,
      type: "plugin_deps_result" as const,
      pluginId,
      ...result,
      status: pluginDepsStatus(plugin.manifest.root),
    });
  },

  uninstall_plugin: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    if (!pluginId) throw new Error("uninstall_plugin: pluginId is required");
    const cwd = scopedCwd(msg.cwd);
    // 卸载前先记下该插件声明的 MCP 名（含当前禁用的插件：元数据缓存可能还在）。
    // 卸载后只在同名定义彻底没人用时才清缓存，避免误清系统/工作区同名服务器。
    // 清单读取失败不能挡住卸载本身。
    let declaredMcp: Array<{ name: string }> = [];
    try {
      const plugin = listInstalledPlugins().find((p) => p.pluginId === pluginId);
      if (plugin) {
        declaredMcp = (await listPluginMcpComponents(plugin.manifest, pluginId)).servers;
      }
    } catch (err) {
      logErr(
        "uninstall_plugin: read mcp components failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    await uninstallPlugin(pluginId);
    await reloadAllPluginComponents(cwd);
    try {
      const { defs: afterDefs } = await loadMcpServers(cwd);
      const goneNames = declaredMcp
        .filter(({ name }) => !afterDefs.some((d) => d.name === name))
        .map(({ name }) => name);
      for (const name of goneNames) dropServer(name);
      // 装后配置清理（kv 分桶 + 密钥值 + secrets-env 授权必清；mcp-secrets
      // 绑定只清卸载后已无同名定义的服务器，与上面 dropServer 同判据）
      await purgePluginConfig(pluginId, goneNames);
    } catch (err) {
      // 缓存/配置清理是附带账：卸载/重载已完成，不能因为清缓存失败把卸载报成失败
      logErr(
        "uninstall_plugin: drop mcp cache failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    send({ id: reqId, ...(await pluginsPayload(cwd)) });
  },

  // 装后配置读路径：schema + 掩码视图（secret 只回是否已设置）+ 三态。
  // 未声明 config 的插件回空 schema（UI 不出现配置入口）。
  get_plugin_config: async (reqId, msg) => {
    const cwd = scopedCwd(msg.cwd);
    const plugin = listInstalledPlugins().find((p) => p.pluginId === String(msg.pluginId ?? ""));
    if (!plugin) throw new Error(`get_plugin_config: 未找到插件 ${String(msg.pluginId ?? "")}`);
    const schema = plugin.manifest.config;
    let state;
    if (schema?.length) {
      const defsOfPlugin = loadMcpServersSync(cwd).defs.filter(
        (d) => d.pluginId === plugin.pluginId,
      );
      state = await getPluginConfigState(
        plugin.pluginId,
        plugin.manifest,
        defsOfPlugin,
        await secretList(),
      );
    }
    send({
      id: reqId,
      type: "plugin_config" as const,
      pluginId: plugin.pluginId,
      ...(schema?.length ? { schema } : {}),
      ...(state ? { state } : {}),
      ...pluginConfigView(plugin.pluginId, plugin.manifest),
    });
  },

  // 装后配置写路径：secret 转发 hostdb 密钥库并自动建两层绑定，非敏感进 kv 并
  // 热重载；rebind=true = stale 一键重绑（不接明文帧，按 kv 记录重建绑定）。
  set_plugin_config: async (reqId, msg) => {
    const cwd = scopedCwd(msg.cwd);
    const plugin = listInstalledPlugins().find((p) => p.pluginId === String(msg.pluginId ?? ""));
    if (!plugin) throw new Error(`set_plugin_config: 未找到插件 ${String(msg.pluginId ?? "")}`);
    if (!plugin.manifest.config?.length) throw new Error("set_plugin_config: 插件未声明 config");
    const values = (msg.values ?? {}) as Record<string, string>;
    const skillLists = await Promise.all(
      resolvePluginComponents(plugin.manifest, "skills").map((dir) =>
        listPluginSkillEntries(dir, plugin.pluginId, plugin.manifest.name),
      ),
    );
    const skills = skillLists.flat();
    // defs 由 save/rebind 内部在缓存失效后现取（绑定哈希必须对齐注入后的 def）
    const state =
      msg.rebind === true
        ? await rebindPluginConfig(
            plugin.manifest,
            plugin.pluginId,
            skills.map((s) => s.name),
          )
        : await savePluginConfig(
            plugin.manifest,
            plugin.pluginId,
            values,
            skills.map((s) => s.name),
          );
    await reloadAllPluginComponents(cwd);
    send({
      id: reqId,
      type: "plugin_config" as const,
      pluginId: plugin.pluginId,
      schema: plugin.manifest.config,
      ...(state ? { state } : {}),
      ...pluginConfigView(plugin.pluginId, plugin.manifest),
    });
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
   * 市场条目预览（未安装插件详情页的组件清单）：直接读市场源目录里的插件
   * 清单，不能等安装完才知道带了哪些技能 / MCP / 子智能体 / 钩子 / 面板。
   * 目录未刷新、条目不在目录或源目录缺失时回 error。
   */
  get_marketplace_plugin_preview: async (reqId, msg) => {
    const marketplaceId = String(msg.marketplaceId ?? "");
    const name = String(msg.name ?? "");
    if (!marketplaceId || !name) {
      throw new Error(
        "get_marketplace_plugin_preview: marketplaceId and name are required",
      );
    }
    const payload = await marketplacePluginPreviewPayload(marketplaceId, name);
    send({ id: reqId, ...payload });
  },

  /**
   * 单个插件组件的正文（插件详情页"查看内容"）：技能 SKILL.md / 子智能体 YAML /
   * MCP 条目 JSON / 钩子条目 JSON，按需现取。插件未安装或该组件不存在回 error。
   */
  get_plugin_component_doc: async (reqId, msg) => {
    const pluginId = String(msg.pluginId ?? "");
    const kind = String(msg.kind ?? "");
    const name = String(msg.name ?? "");
    if (
      !pluginId ||
      !name ||
      (kind !== "skill" && kind !== "mcp" && kind !== "subagent" && kind !== "hook")
    ) {
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
  const cwd = scopedCwd(msg.cwd);
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
      // 安装/更新完成后必须做四链热重载：技能提示词、子智能体、MCP 连接池
      // 都按插件层清单重建。此前只在启停/卸载做，安装后的组件要等下一次
      // 会话装配才生效（实报「插件装完 MCP 不出现」）。
      // 重载失败不把已完成的安装报成失败：插件已在盘上，下一次会话装配会再读。
      if (op === "install_plugin" || op === "install_plugin_local") {
        try {
          await reloadAllPluginComponents(cwd);
        } catch (err) {
          logErr(
            `plugin ${op}: reload components failed:`,
            err instanceof Error ? err.message : String(err),
          );
        }
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
