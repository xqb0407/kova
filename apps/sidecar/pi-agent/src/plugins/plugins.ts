/**
 * 插件系统（插件市场）：skills / MCP / hooks / 子智能体四类组件的打包分发层。
 *
 * 插件 = 一个目录，清单在 .kova-plugin/plugin.json（按序兼容探测 .claude-plugin/
 * .codex-plugin/，安装时规范化为内部形状）；组件是清单声明的相对路径：
 * skills（技能目录）/ mcpServers（mcpServers map json）/ hooks（json）/
 * subagents（子代理 YAML 目录）。本模块是叶子：只被四个子系统和协议层引用，
 * 不反向依赖（hooks 只取类型）。
 *
 * 身份与存储（应用数据目录 plugins/ 下，与 state.db 同族）：
 * - 插件身份 = `<name>@<marketplaceId>`；安装物化到 cache/<mktId>/<name>/
 *   （单版本，更新整体替换，组件级开关天然保留），元数据写 installed.json。
 * - 市场 = 含 marketplace.json 的目录（本地路径，或 git 仓库 clone 到
 *   repos/<mktId>/）；登记表 marketplaces.json，目录缓存 catalogs/<mktId>.json。
 * - 启用开关是"本机的运行时决定"：整包 SQLite kv（key = KV_KEY）的 disabled
 *   map（默认启用，显式关闭才记键，与 skills/MCP 同款）；卸载清残留。
 *
 * 合并语义（四链接入点见各子系统文件）：插件层在所有合并链中垫底——
 * 工作区 > 系统 > 插件，同名被遮蔽；插件级 enabled 门控全部组件，
 * 组件级开关沿用各子系统已有 kv（stateKey 带 pluginId 命名空间）。
 *
 * 耗时操作（git clone / refresh）由协议层异步受理，完成后自发
 * plugin_op_result 帧；本模块只暴露 await 语义的函数。
 *
 * 安全约束：组件路径必须相对且解析后不逃逸插件根；插件 MCP 只认标准字段
 * （approveTools 等 kova 专属字段不可由插件携带）；hooks 决策语义与手配
 * 钩子完全一致（exit 2 / stdout JSON）。
 *
 * 物理布局（本文件为门面，签名与原单文件完全一致）：
 * - ./plugins/manifest.ts      清单解析/生态规范化/hooks 文件读取（纯函数）
 * - ./plugins/registry.ts      市场登记表（marketplaces.json）+ 稳定 id 派生
 * - ./plugins/store.ts         启用开关 + 已装扫描缓存 + 组件/图标/hooks 读模型
 * - ./plugins/marketplaces.ts  目录缓存 + git + 添加/移除/刷新/安装/卸载写路径
 */
export {
  // 类型
  LOCAL_MKT_ID,
  LOCAL_MKT_NAME,
  type PluginManifestKind,
  type PluginComponents,
  type PluginManifest,
  type InstalledPlugin,
  type MarketplaceType,
  type MarketplaceRecord,
  type CatalogPluginEntry,
  type MarketplaceCatalog,
  type MarketplaceCatalogCache,
  // 路径与清单
  pluginsRootDir,
  marketplacesFilePath,
  installedPluginDir,
  devMarketplaceDir,
  PLUGIN_NAME_RE,
  parsePluginManifest,
  readPluginHooksFile,
  // UI 面板声明（纯解析层）
  type PluginPanelDecl,
  type PluginPanelPermission,
  PANEL_PERMISSIONS,
  readPluginPanelsFile,
  globMatch,
} from "./manifest";

export { listMarketplaces, marketplaceIdFor } from "./registry";

export {
  // 启用开关
  type PluginsEnabledState,
  PLUGINS_ENABLED_KV_KEY,
  initPluginsState,
  isPluginEnabled,
  setPluginEnabled,
  // 已装扫描与读模型
  listInstalledPlugins,
  activePlugins,
  resolvePluginComponent,
  resolvePluginIconDataUrl,
  activePluginHooks,
  currentPluginsStateVersion,
  resetPluginsForTest,
  // UI 面板读模型（清单/图标/资产/定位）
  readPluginPanels,
  resolvePanelIconDataUrl,
  type PluginPanelAsset,
  readPluginPanelAsset,
  readPluginPanelRev,
  findEnabledPluginPanel,
} from "./store";

export {
  // 市场与安装
  type AddMarketplaceInput,
  type AddMarketplaceResult,
  addMarketplace,
  removeMarketplace,
  type RefreshResult,
  refreshMarketplace,
  getMarketplaceCatalog,
  type InstallResult,
  installPlugin,
  installLocalPlugin,
  type LocalMarketplaceEntry,
  localMarketplaceEntry,
  uninstallPlugin,
} from "./marketplaces";
