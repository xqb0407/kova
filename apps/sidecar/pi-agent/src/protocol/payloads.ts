/**
 * 协议层应答载荷构建器：设置页与变更命令共用的清单形状（改后即见），
 * 以及 MCP 草稿解析与变更后的热重载编排。命令 handler 见 handlers/。
 */
import { logErr } from "../log";
import { listInstalledPlugins, resolvePluginComponent, resolvePluginIconDataUrl, readPluginPanels, resolvePanelIconDataUrl, getMarketplaceCatalog, listMarketplaces, localMarketplaceEntry } from "../plugins/plugins";
import { listPluginMcpEntries, loadMcpServers, activeMcpServers, type McpDraft } from "../mcp/mcp-config";
import { mcpManager } from "../mcp/mcp-manager";
import { ensureSkillsLoaded, skillsSnapshot, listPluginSkillEntries } from "../skills/skills";
import { listPluginSubagentEntries, loadSubagentDefinitions } from "../subagent/subagent-definitions";
import { reloadSkills, reloadSubagents } from "../sessions/sessions";

export function maskApiKey(key: string): string {
  return key.length > 4 ? `****${key.slice(-4)}` : "****";
}

/** 子智能体清单应答负载：设置页与所有变更命令共用同一形状（改后即见）。
 * scope = "plugin" 的条目单列在 pluginAgents——子智能体设置页只渲染常规三层，
 * 插件子智能体由输入框 `@` 提及与插件详情消费 */
export async function subagentsPayload(cwd?: string) {
  const r = await loadSubagentDefinitions({ cwd });
  const toEntry = (e: (typeof r.entries)[number]) => ({
    name: e.name,
    description: e.description,
    tools: e.tools,
    ...(e.maxTurns !== undefined ? { maxTurns: e.maxTurns } : {}),
    ...(e.model ? { model: e.model } : {}),
    prompt: e.prompt,
    scope: e.scope,
    ...(e.path ? { path: e.path } : {}),
    ...(e.raw ? { raw: e.raw } : {}),
    enabled: e.enabled,
    editable: e.editable,
  });
  return {
    agents: r.entries.filter((e) => e.scope !== "plugin").map(toEntry),
    pluginAgents: r.entries.filter((e) => e.scope === "plugin").map(toEntry),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** 技能清单应答负载：设置页与所有变更命令共用同一形状（改后即见）。
 * scope = "plugin" 的条目单列在 pluginSkills——技能设置页只渲染常规四层，
 * 插件技能由输入框 `/` 菜单与插件详情消费（components 字段带 pluginId 供开关） */
export async function skillsPayload(cwd?: string) {
  await ensureSkillsLoaded(cwd);
  const r = skillsSnapshot(cwd);
  const toEntry = (e: (typeof r.entries)[number]) => ({
    name: e.name,
    description: e.description,
    scope: e.scope,
    ...(e.pluginId ? { pluginId: e.pluginId } : {}),
    ...(e.disableModelInvocation ? { disableModelInvocation: true } : {}),
    enabled: e.enabled,
    shadowed: e.shadowed,
    editable: e.editable,
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
 * layer = "plugin" 的条目单列在 pluginServers——MCP 设置页只渲染常规两层，
 * 插件服务器由输入框 `/` 菜单（经网关调工具）与插件详情消费 */
export async function mcpServersPayload(cwd?: string) {
  const r = await loadMcpServers(cwd);
  const statuses = new Map(mcpManager.listStatuses(r.defs).map((s) => [s.name, s]));
  const toEntry = (def: (typeof r.defs)[number]) => ({
    name: def.name,
    layer: def.layer,
    source: def.source,
    ...(def.fromStandard ? { fromStandard: true } : {}),
    ...(def.pluginId ? { pluginId: def.pluginId } : {}),
    transport: def.transport,
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
    enabled: r.enabledBy.get(def.name) === true,
    status: statuses.get(def.name) ?? { name: def.name, state: "idle", toolCount: 0 },
  });
  return {
    servers: r.defs.filter((def) => def.layer !== "plugin").map(toEntry),
    pluginServers: r.defs.filter((def) => def.layer === "plugin").map(toEntry),
    workspaceCwd: cwd ?? null,
    diagnostics: r.diagnostics,
  };
}

/** 变更后的连接池热重载：以当前启用集合 diff，断开被删/改/禁用的服务器 */
export async function reloadMcpConnections(cwd?: string): Promise<void> {
  const defs = await activeMcpServers(cwd);
  mcpManager.applyConfig(defs);
  // eager 服务器即时预连（fire-and-forget）：新加/改配置的 eager 不用等首次调用
  mcpManager.prewarm(defs);
}

/**
 * 插件状态变更后的全链路热重载：skills 系统提示词重组 + MCP 连接池 diff +
 * 子智能体工具组重排；hooks 本就每次调用实时读（activePluginHooks 签名缓存），
 * 无需显式刷新。
 */
export async function reloadAllPluginComponents(cwd?: string): Promise<void> {
  await Promise.all([reloadSkills(), reloadSubagents()]);
  await reloadMcpConnections(cwd);
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
          components: { skills, mcpServers, subagents, panels },
          diagnostics: [...p.diagnostics, ...p.manifest.unsupported],
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
  // 「本地安装」伪市场垫底呈现（有本地安装项才出现）：现场合成，不落登记表
  const local = localMarketplaceEntry();
  return {
    type: "marketplaces" as const,
    marketplaces: local ? [...entries, local] : entries,
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
  };
}
