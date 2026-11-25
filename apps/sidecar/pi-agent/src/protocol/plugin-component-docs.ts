/**
 * 插件组件正文读取（插件详情页"查看内容"用）：按 pluginId + 组件类别 + 名称
 * 现取单个组件的原文，供详情弹窗展开查看。
 *
 * 为什么现取而不是随 list_plugins 一起带：技能正文（SKILL.md）与子智能体 YAML
 * 都可能是几十 KB 的文档，一个插件装十几条组件很正常，全量塞进清单会让每次
 * 刷新/开关都搬运全部正文。清单只保留 name/description 这类摘要字段。
 *
 * 放在协议层而非 plugins/ 下：plugins/ 是叶子模块（只被四个子系统与协议层引用，
 * 不反向依赖 skills/mcp/subagent），组件正文必须经各子系统自己的解析层取，
 * 在这里汇合才不会让 plugins/ 长出反向依赖。
 *
 * 四类组件的"原文"语义不同，各自取最贴近作者所写的那份：
 * - skill：SKILL.md 全文（含 frontmatter——插件作者写的禁用开关等字段在里面）
 * - mcp：mcpServers 文件里该服务器的那条 JSON（未经规范化，保留作者原始写法）
 * - subagent：该条目的 YAML 原文
 * - hook：解析后的条目（命令行保留 ${PLUGIN_ROOT} 等占位符原文；type/timeout
 *   已按运行时语义规范化——Claude 形状的 command 会映射成 shell、秒转毫秒）
 *
 * 未知/未安装/已卸载的组件一律返回 undefined，由 handler 转协议错误；
 * 单文件超上限截断并在 truncated 里告知，不让一个畸形文件撑爆前端。
 */
import { readFileSync } from "node:fs";
import {
  listInstalledPlugins,
  listPluginHookEntries,
  resolvePluginComponent,
  resolvePluginComponents,
} from "../plugins/plugins";
import { listPluginSkillEntries } from "../skills/skills";
import { readPluginSubagentDoc } from "../subagent/subagent-definitions";

/** 单组件正文上限：与技能文档自身的 128KB 上限同量级，留一倍余量给 YAML/MCP/钩子 JSON */
const DOC_MAX_BYTES = 256 * 1024;

export type PluginComponentKind = "skill" | "mcp" | "subagent" | "hook";

export type PluginComponentDoc = {
  kind: PluginComponentKind;
  name: string;
  /** 展示用的来源路径（技能/子智能体为定义文件，MCP/hook 为对应 JSON 文件） */
  path: string;
  content: string;
  /** 超上限被截断 */
  truncated: boolean;
};

/** 按 UTF-8 字节上限截断；截断点落在多字节序列中间时由解码器替换为 U+FFFD */
function capContent(content: string): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= DOC_MAX_BYTES) return { content, truncated: false };
  return { content: bytes.subarray(0, DOC_MAX_BYTES).toString("utf8"), truncated: true };
}

/** 读文件并按字节上限截断 */
function readCapped(abs: string): { content: string; truncated: boolean } | undefined {
  try {
    return capContent(readFileSync(abs, "utf8"));
  } catch {
    return undefined;
  }
}

/** 按 pluginId 找已装插件（未安装/已卸载返回 undefined） */
function findPlugin(pluginId: string) {
  return listInstalledPlugins().find((p) => p.pluginId === pluginId);
}

/**
 * 取单个插件组件的正文。kind 只认四种；组件在该插件里不存在（没声明该类组件、
 * 名称对不上、文件缺失或读失败）返回 undefined。
 * hook 的 name 参数兼容稳定 id 与展示名——同名条目由调用方传 id 精确命中。
 */
export async function readPluginComponentDoc(
  pluginId: string,
  kind: PluginComponentKind,
  name: string,
): Promise<PluginComponentDoc | undefined> {
  const plugin = findPlugin(pluginId);
  if (!plugin) return undefined;

  if (kind === "skill") {
    // 复用技能层的清单函数取定义文件路径：命名/frontmatter 解析与生效链完全同源，
    // 免得这里再解一遍目录结构得出与实际加载不一致的路径。多 skills 根逐个找。
    for (const dir of resolvePluginComponents(plugin.manifest, "skills")) {
      const entries = await listPluginSkillEntries(dir, pluginId, plugin.manifest.name);
      const entry = entries.find((e) => e.name === name || e.qualifiedName === name);
      if (!entry) continue;
      const read = readCapped(entry.path);
      if (!read) return undefined;
      return { kind, name, path: entry.path, ...read };
    }
    return undefined;
  }

  if (kind === "subagent") {
    for (const dir of resolvePluginComponents(plugin.manifest, "subagents")) {
      const doc = readPluginSubagentDoc(dir, pluginId, name);
      if (!doc) continue;
      const read = readCapped(doc.path);
      // 原文以解析层读到的为准（列表层与文档层读的是同一份 YAML），仅用读取结果判可用性
      if (!read) return undefined;
      return { kind, name, path: doc.path, content: doc.raw, truncated: read.truncated };
    }
    return undefined;
  }

  if (kind === "hook") {
    // name 兼容稳定 id（列表下发）与展示名：同名钩子靠 id 精确命中的是各自那条。
    // 正文保留作者原始命令串（含 ${PLUGIN_ROOT} 占位符），不为展示做展开。
    const entries = listPluginHookEntries(plugin);
    const entry = entries.find((h) => h.id === name || h.name === name);
    if (!entry) return undefined;
    const content = JSON.stringify(
      {
        name: entry.name,
        event: entry.event,
        ...(entry.matcher ? { matcher: entry.matcher } : {}),
        enabled: entry.enabled,
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.type ? { type: entry.type } : {}),
        ...(entry.shell ? { shell: entry.shell } : {}),
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      },
      null,
      2,
    );
    return {
      kind,
      name: entry.name,
      path:
        resolvePluginComponent(plugin.manifest, "hooks") ??
        `${plugin.manifest.root}/.codex-plugin/plugin.json#hooks`,
      ...capContent(content),
    };
  }

  // MCP：取 mcpServers 文件里该服务器的那条 JSON，保留作者原始写法。
  // 多文件 + manifest 内联对象都支持；整文件读进来解析，只对最终那条做上限截断。
  for (const file of resolvePluginComponents(plugin.manifest, "mcpServers")) {
    let servers: Record<string, unknown>;
    try {
      const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
      const record = doc as Record<string, unknown> | null;
      const raw = record && isMcpServersRecord(record.mcpServers) ? record.mcpServers : record;
      if (!isMcpServersRecord(raw)) continue;
      servers = raw;
    } catch {
      continue;
    }
    const entry = servers[name];
    if (entry === undefined) continue;
    return { kind, name, path: file, ...capContent(JSON.stringify(entry, null, 2)) };
  }
  const inline = plugin.manifest.components.mcpServersInline;
  if (inline && inline[name] !== undefined) {
    return {
      kind,
      name,
      path: `${plugin.manifest.root}/.codex-plugin/plugin.json#mcpServers`,
      ...capContent(JSON.stringify(inline[name], null, 2)),
    };
  }
  return undefined;
}

function isMcpServersRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
