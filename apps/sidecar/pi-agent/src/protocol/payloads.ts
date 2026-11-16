/**
 * 协议层应答载荷构建器：设置页与变更命令共用的清单形状（改后即见），
 * 以及 MCP 草稿解析与变更后的热重载编排。命令 handler 见 handlers/。
 */
import { logErr } from "../log";
import { listInstalledPlugins, resolvePluginComponent, resolvePluginIconDataUrl, readPluginPanels, resolvePanelIconDataUrl, getMarketplaceCatalog, listMarketplaces, localMarketplaceEntry, listPluginHookEntriesWithDiagnostics, parsePluginManifest, resolveMarketplacePluginSource, type InstalledPlugin } from "../plugins/plugins";
import { listPluginMcpEntries, loadMcpServers, activeMcpServers, type McpDraft } from "../mcp/mcp-config";
import { computeConfigHash, dropServer } from "../mcp/mcp-cache";
import { mcpSecretBindingFor, mcpSecretBindingStale } from "../mcp/mcp-secrets";
import { mcpManager } from "../mcp/mcp-manager";
import { ensureSkillsLoaded, skillsSnapshot, listPluginSkillEntries } from "../skills/skills";
import { projectExtraDirs } from "../agent/projects";
import {
  GRANTABLE_TOOLS,
  listPluginSubagentEntries,
  loadSubagentDefinitions,
} from "../subagent/subagent-definitions";
import { reloadSkills, reloadSubagents, reloadMcpToolsIfPresenceChanged } from "../sessions/sessions";

export function maskApiKey(key: string): string {
  return key.length > 4 ? `****${key.slice(-4)}` : "****";
}

/** 子智能体清单应答负载：设置页与所有变更命令共用同一形状（改后即见）。
 * scope = "plugin" 的条目单列在 pluginAgents——子智能体设置页只渲染常规三层，
 * 插件子智能体由输入框 `@` 提及与插件详情消费 */
export async function subagentsPayload(cwd?: string) {
  // 项目附加目录：历史定义只读兼容；stateKey 已在加载层重挂到主目录
  const r = await loadSubagentDefinitions({
    cwd,
    extraDirs: cwd ? projectExtraDirs(cwd) : undefined,
  });
  const toEntry = (e: (typeof r.entries)[number]) => ({
    name: e.name,
    description: e.description,
    tools: e.tools,
    ...(e.maxTurns !== undefined ? { maxTurns: e.maxTurns } : {}),
    ...(e.model ? { model: e.model } : {}),
    prompt: e.prompt,
    scope: e.scope,
    // 能力授予维度：未声明就不出现（前端据此决定是否渲染对应控件）
    ...(e.skills?.length ? { skills: e.skills } : {}),
    ...(e.mcpServers?.length ? { mcpServers: e.mcpServers } : {}),
    ...(e.knowledge?.length ? { knowledge: e.knowledge } : {}),
    ...(e.memory ? { memory: e.memory } : {}),
    ...(e.path ? { path: e.path } : {}),
    ...(e.raw ? { raw: e.raw } : {}),
    // 头像是 kv 覆盖层烘焙进来的（builtin:<id> 或 data URL），没设就不出现
    ...(e.avatar ? { avatar: e.avatar } : {}),
    enabled: e.enabled,
    editable: e.editable,
    // 插件层的开关与模型覆盖都按 pluginId 命名空间，前端回命令时必须带上
    ...(e.scope === "plugin" ? { pluginId: e.pluginId } : {}),
  });
  return {
    agents: r.entries.filter((e) => e.scope !== "plugin").map(toEntry),
    pluginAgents: r.entries.filter((e) => e.scope === "plugin").map(toEntry),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
    // 可授予工具目录：设置页表单据此渲染，不在前端留硬编码副本
    // （旧实现把六个名字写死在 TOOL_OPTIONS，后端一改就漂移）
    grantableTools: [...GRANTABLE_TOOLS],
  };
}

/** 技能清单应答负载：设置页与所有变更命令共用同一形状（改后即见）。
 * scope = "plugin" 的条目单列在 pluginSkills——技能设置页只渲染常规四层，
 * 插件技能由输入框 `/` 菜单与插件详情消费（components 字段带 pluginId 供开关） */
export async function skillsPayload(cwd?: string) {
  // 项目附加目录：历史技能只读兼容（设置页可见，写入仍落主目录）
  const extraDirs = cwd ? projectExtraDirs(cwd) : [];
  await ensureSkillsLoaded(cwd, extraDirs);
  const r = skillsSnapshot(cwd, extraDirs);
  const toEntry = (e: (typeof r.entries)[number]) => ({
    name: e.name,
    description: e.description,
    scope: e.scope,
    ...(e.pluginId ? { pluginId: e.pluginId } : {}),
    ...(e.disableModelInvocation ? { disableModelInvocation: true } : {}),
    enabled: e.enabled,
    shadowed: e.shadowed,
    editable: e.editable,
    ...(e.managed ? { managed: true } : {}),
    path: e.path,
    content: e.content,
    sizeBytes: e.sizeBytes,
    ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
  });
  return {
    skills: r.entries.filter((e) => e.scope !== "plugin").map(toEntry),
    pluginSkills: r.entries.filter((e) => e.scope === "plugin").map(toEntry),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** MCP 服务器清单应答负载：设置页与所有变更命令共用同一形状（改后即见）。
 * layer = "plugin" 的条目单列在 pluginServers——MCP 设置页把它们放在只读的
 * 「插件 MCP」分组（可连接/启停，编辑在插件详情），输入框 `/` 菜单与插件
 * 详情也消费这份清单 */
export async function mcpServersPayload(cwd?: string) {
  const r = await loadMcpServers(cwd);
  const statuses = new Map(mcpManager.listStatuses(r.defs).map((s) => [s.name, s]));
  const toEntry = async (def: (typeof r.defs)[number]) => {
    // configHash 供设置页判断「编辑配置后原密钥绑定是否还适用于新配置」；
    // secretEnv 只在哈希匹配时返回——stale 绑定留在 kv 里等用户重新确认，
    // 但绝不会被管理器使用。
    const secretEnv =
      def.transport === "stdio" ? (await mcpSecretBindingFor(def))?.env : undefined;
    const secretHeaders =
      def.transport === "http" ? (await mcpSecretBindingFor(def))?.headers : undefined;
    const secretBindingStale =
      def.transport === "stdio"
        ? !secretEnv && (await mcpSecretBindingStale(def))
        : def.transport === "http"
          ? !secretHeaders && (await mcpSecretBindingStale(def))
          : false;
    return {
      name: def.name,
      layer: def.layer,
      source: def.source,
      ...(def.fromStandard ? { fromStandard: true } : {}),
      ...(def.pluginId ? { pluginId: def.pluginId } : {}),
      transport: def.transport,
      configHash: computeConfigHash(def),
      ...(def.command ? { command: def.command } : {}),
      ...(def.args?.length ? { args: def.args } : {}),
      ...(def.env && Object.keys(def.env).length > 0 ? { env: def.env } : {}),
      ...(def.url ? { url: def.url } : {}),
      ...(def.headers && Object.keys(def.headers).length > 0 ? { headers: def.headers } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(def.lifecycle ? { lifecycle: def.lifecycle } : {}),
      ...(def.idleTimeout !== undefined ? { idleTimeout: def.idleTimeout } : {}),
      ...(def.callTimeout !== undefined ? { callTimeout: def.callTimeout } : {}),
      ...(def.approveTools?.length ? { approveTools: def.approveTools } : {}),
      ...(def.enabledTools?.length ? { enabledTools: def.enabledTools } : {}),
      ...(def.connectorId ? { connectorId: def.connectorId } : {}),
      ...(secretEnv?.length ? { secretEnv } : {}),
      ...(secretHeaders?.length ? { secretHeaders } : {}),
      ...(secretBindingStale ? { secretBindingStale: true } : {}),
      enabled: r.enabledBy.get(def.name) === true,
      status: statuses.get(def.name) ?? { name: def.name, state: "idle", toolCount: 0 },
    };
  };
  const [servers, pluginServers] = await Promise.all([
    Promise.all(r.defs.filter((def) => def.layer !== "plugin").map(toEntry)),
    Promise.all(r.defs.filter((def) => def.layer === "plugin").map(toEntry)),
  ]);
  return {
    servers,
    pluginServers,
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** 变更后的连接池热重载：以当前启用集合 diff，断开被删/改/禁用的服务器 */
export async function reloadMcpConnections(cwd?: string): Promise<void> {
  const defs = await activeMcpServers(cwd);
  const keep = new Set(defs.map((d) => d.name));
  // 连接池里有、当前启用集合里没有的条目 = 被删除/禁用/换工作区淘汰：
  // 一并清掉工具缓存，避免重加同名同配置服务器时先读到旧工具面。
  const removed = mcpManager.entryNames().filter((name) => !keep.has(name));
  mcpManager.applyConfig(defs);
  // eager 服务器即时预连（fire-and-forget）：新加/改配置的 eager 不用等首次调用
  mcpManager.prewarm(defs);
  for (const name of removed) dropServer(name);
}

/**
 * 插件状态变更后的全链路热重载：skills 系统提示词重组 + MCP 连接池 diff +
 * 子智能体工具组重排 + MCP 网关按「有无启用服务器」条件重建（插件常携带
 * mcpServers 组件，启停/卸载会翻转网关在场与否）。
 * hooks 本就每次调用实时读（activePluginHooks 签名缓存），无需显式刷新。
 */
export async function reloadAllPluginComponents(cwd?: string): Promise<void> {
  await Promise.all([reloadSkills(), reloadSubagents()]);
  await reloadMcpConnections(cwd);
  await reloadMcpToolsIfPresenceChanged();
}

/** 插件清单应答负载：市场页「已装插件」与变更命令共用同一形状 */
export async function pluginsPayload(cwd?: string) {
  const plugins = listInstalledPlugins();
  return {
    type: "plugins" as const,
    plugins: await Promise.all(
      plugins.map(async (p) => {
        const skillsDir = resolvePluginComponent(p.manifest, "skills");
        const mcpFile = resolvePluginComponent(p.manifest, "mcpServers");
        const subagentsDir = resolvePluginComponent(p.manifest, "subagents");
        const [skills, mcpServers] = await Promise.all([
          skillsDir ? listPluginSkillEntries(skillsDir, p.pluginId) : Promise.resolve([]),
          mcpFile ? listPluginMcpEntries(mcpFile, p.pluginId) : Promise.resolve([]),
        ]);
        const subagents = subagentsDir
          ? listPluginSubagentEntries(subagentsDir, p.pluginId)
          : [];
        // 钩子组件：解析/占位符展开已由 store 完成，这里只保留展示需要的摘要；
        // 正文（command/args/超时等）走 get_plugin_component_doc 按需现取，
        // 与技能/MCP/子智能体同口径，避免每次 list_plugins 搬运全部命令。
        // 只并入文件解析诊断（坏 JSON/未知事件）；占位符诊断依赖会话工作区，
        // 不随全局插件负载下发，避免未选工作区时在详情页误报。
        const {
          hooks: hookEntries,
          diagnostics: hookDiagnostics,
        } = listPluginHookEntriesWithDiagnostics(p);
        const hooks = hookEntries.map((h) => ({
          id: h.id,
          name: h.name,
          description: h.event,
          // 单条 enabled 与整包开关共同决定这条钩子当前是否真的会执行；
          // 详情页行状态据此置灰，避免停用插件/停用钩子看起来仍在生效。
          enabled: p.enabled && h.enabled,
          event: h.event,
          ...(h.matcher ? { matcher: h.matcher } : {}),
          ...(h.type ? { type: h.type } : {}),
        }));
        // UI 面板贡献：entry 原文不消费方需要（前端走 get_plugin_panel_asset 现取），
        // 图标按清单图标同语义解析成可显示 src
        const panels = readPluginPanels(p).map((d) => ({
          id: d.id,
          title: d.title,
          ...(d.icon ? { icon: resolvePanelIconDataUrl(p.manifest, d.icon) } : {}),
          opens: d.opens,
          permissions: d.permissions,
        }));
        return {
          pluginId: p.pluginId,
          name: p.name,
          ...(p.manifest.displayName ? { displayName: p.manifest.displayName } : {}),
          marketplaceId: p.mktId,
          marketplaceName: p.mktName,
          version: p.version,
          ...(p.revision ? { revision: p.revision } : {}),
          installedAt: p.installedAt,
          ...(p.manifest.description ? { description: p.manifest.description } : {}),
          // 可显示 src：远程 URL 原样 / 本地文件已读成 data URL（无图标则缺省）
          ...(resolvePluginIconDataUrl(p.manifest)
            ? { icon: resolvePluginIconDataUrl(p.manifest) }
            : {}),
          ...(p.manifest.category ? { category: p.manifest.category } : {}),
          manifestKind: p.manifest.manifestKind,
          sourceMissing: p.sourceMissing,
          // 链接安装（dev 模式）标记 + 源路径：市场 UI 展示徽标与可重载判据；
          // 本地安装（拷贝）也带 sourcePath——"检查更新"与市场页提示按此展示
          ...(p.linked ? { linked: true } : {}),
          ...(p.sourcePath ? { sourcePath: p.sourcePath } : {}),
          enabled: p.enabled,
          components: { skills, mcpServers, subagents, hooks, panels },
          diagnostics: [...p.diagnostics, ...p.manifest.unsupported, ...hookDiagnostics],
        };
      }),
    ),
    workspaceCwd: cwd ?? null,
  };
}

/** 市场清单应答负载：登记表 + 各市场目录（含已装标记由前端比对）。
 * 注意「本地安装」伪市场必须拼进 marketplaces 数组——展开进对象顶层会产生
 * 数字键并把序列化后的帧首键从 type 顶掉，前端前缀预筛将整帧丢弃。 */
export function marketplacesPayload() {
  const entries = listMarketplaces().map((r) => {
    const { catalog, revision, needsRefresh } = getMarketplaceCatalog(r.id);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      ...(r.type === "directory" ? { path: r.path } : { repo: r.repo }),
      addedAt: r.addedAt,
      ...(r.lastRefresh ? { lastRefresh: r.lastRefresh } : {}),
      ...(revision ? { revision } : {}),
      needsRefresh,
      plugins: catalog.plugins,
    };
  });
  // 「本地安装」伪市场垫底呈现（有条目才出现）：现场合成，不落登记表
  const local = localMarketplaceEntry();
  return {
    type: "marketplaces" as const,
    marketplaces: [...entries, ...(local ? [local] : [])],
  };
}

/**
 * 市场条目预览负载：未安装插件在详情弹窗里也要能看到组件清单（技能 / MCP /
 * 子智能体 / 钩子 / 面板），不能等装完才知道有什么。直接读市场源目录里的
 * 插件清单，组件形状与 list_plugins 对齐；未安装没有本机开关，enabled 恒 true。
 * 缓存缺失 / 条目不在目录 / 源目录不存在由调用方回 error。
 */
export async function marketplacePluginPreviewPayload(mktId: string, name: string) {
  const source = resolveMarketplacePluginSource(mktId, name);
  if (!source) {
    throw new Error(`市场 "${mktId}" 中未找到可预览的插件 "${name}"（目录未刷新或源目录不存在）`);
  }
  // 根写法条目（source: "./"）的目录名不是插件名，按市场条目名钉住清单校验
  const manifest = parsePluginManifest(
    source.dir,
    source.entry.path === "" ? { dirName: source.entry.name } : {},
  );
  const pluginId = `${manifest.name}@${mktId}`;
  // 借用已装插件的读模型：hooks/panels 的解析只依赖 manifest + 根目录；
  // 子智能体/技能/MCP 清单函数只读一次，不落安装状态
  const previewPlugin: InstalledPlugin = {
    pluginId,
    mktId,
    mktName: source.record.name,
    name: manifest.name,
    version: source.entry.version ?? manifest.version,
    installedAt: "",
    sourceMissing: false,
    enabled: true,
    manifest,
    diagnostics: [],
  };
  const skillsDir = resolvePluginComponent(manifest, "skills");
  const mcpFile = resolvePluginComponent(manifest, "mcpServers");
  const subagentsDir = resolvePluginComponent(manifest, "subagents");
  const [skills, mcpServers] = await Promise.all([
    skillsDir ? listPluginSkillEntries(skillsDir, pluginId) : Promise.resolve([]),
    mcpFile ? listPluginMcpEntries(mcpFile, pluginId) : Promise.resolve([]),
  ]);
  const subagents = subagentsDir
    ? listPluginSubagentEntries(subagentsDir, pluginId)
    : [];
  const { hooks, diagnostics: hookDiagnostics } =
    listPluginHookEntriesWithDiagnostics(previewPlugin);
  const panels = readPluginPanels(previewPlugin).map((d) => ({
    id: d.id,
    title: d.title,
    ...(d.icon ? { icon: resolvePanelIconDataUrl(manifest, d.icon) } : {}),
    opens: d.opens,
    permissions: d.permissions,
  }));
  return {
    type: "marketplace_plugin_preview" as const,
    marketplaceId: mktId,
    name: manifest.name,
    ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
    version: source.entry.version ?? manifest.version,
    manifestKind: manifest.manifestKind,
    ...(manifest.description ? { description: manifest.description } : {}),
    components: {
      // 未安装条目没有组件级开关，统一按启用呈现
      skills: skills.map((c) => ({ ...c, enabled: true })),
      mcpServers: mcpServers.map((c) => ({ ...c, enabled: true })),
      subagents: subagents.map((c) => ({ ...c, enabled: true })),
      hooks: hooks.map((h) => ({
        id: h.id,
        name: h.name,
        description: h.event,
        enabled: true,
        event: h.event,
        ...(h.matcher ? { matcher: h.matcher } : {}),
        ...(h.type ? { type: h.type } : {}),
      })),
      panels,
    },
    diagnostics: [
      ...manifest.diagnostics,
      ...manifest.unsupported,
      ...hookDiagnostics,
    ],
  };
}

/** 从消息里解析 MCP 草稿（save 用）；字段宽松规整，校验交给 saveMcpServer */
export function mcpDraftFromMessage(raw: unknown): McpDraft {
  const d = (raw ?? {}) as Record<string, unknown>;
  const transport = d.transport === "http" ? "http" : "stdio";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const map = (v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter((s) => s.trim()) : undefined;
  return {
    name: String(d.name ?? "").trim(),
    transport,
    ...(transport === "stdio"
      ? {
          command: str(d.command),
          ...(arr(d.args)?.length ? { args: arr(d.args) } : {}),
          ...(map(d.env) ? { env: map(d.env) } : {}),
        }
      : {
          url: str(d.url),
          ...(map(d.headers) ? { headers: map(d.headers) } : {}),
        }),
    ...(str(d.description) ? { description: str(d.description) } : {}),
    ...(typeof d.lifecycle === "string" && ["lazy", "eager", "keep-alive"].includes(d.lifecycle)
      ? { lifecycle: d.lifecycle as McpDraft["lifecycle"] }
      : {}),
    ...(typeof d.idleTimeout === "number" && Number.isFinite(d.idleTimeout)
      ? { idleTimeout: d.idleTimeout }
      : {}),
    ...(typeof d.callTimeout === "number" && Number.isFinite(d.callTimeout)
      ? { callTimeout: d.callTimeout }
      : {}),
    ...(arr(d.approveTools)?.length ? { approveTools: arr(d.approveTools) } : {}),
    ...(arr(d.enabledTools)?.length ? { enabledTools: arr(d.enabledTools) } : {}),
    ...(str(d.connectorId) ? { connectorId: str(d.connectorId) } : {}),
  };
}
