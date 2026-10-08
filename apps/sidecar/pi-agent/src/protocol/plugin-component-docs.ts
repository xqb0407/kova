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
 * 三类组件的"原文"语义不同，各自取最贴近作者所写的那份：
 * - skill：SKILL.md 全文（含 frontmatter——插件作者写的禁用开关等字段在里面）
 * - mcp：mcpServers 文件里该服务器的那条 JSON（未经规范化，保留作者原始写法）
 * - subagent：该条目的 YAML 原文
 *
 * 未知/未安装/已卸载的组件一律返回 undefined，由 handler 转协议错误；
 * 单文件超上限截断并在 truncated 里告知，不让一个畸形文件撑爆前端。
 */
import { readFileSync } from "node:fs";
import { listInstalledPlugins, resolvePluginComponent } from "../plugins/plugins";
import { listPluginSkillEntries } from "../skills/skills";
import { readPluginSubagentDoc } from "../subagent/subagent-definitions";

/** 单组件正文上限：与技能文档自身的 128KB 上限同量级，留一倍余量给 YAML/MCP */
const DOC_MAX_BYTES = 256 * 1024;

export type PluginComponentKind = "skill" | "mcp" | "subagent";

export type PluginComponentDoc = {
  kind: PluginComponentKind;
  name: string;
  /** 展示用的来源路径（技能/子智能体为定义文件，MCP 为 mcpServers 文件） */
  path: string;
  content: string;
  /** 超上限被截断 */
  truncated: boolean;
};

/** 读文件并按字节上限截断（按字符切，避免切碎多字节字符） */
function readCapped(abs: string): { content: string; truncated: boolean } | undefined {
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= DOC_MAX_BYTES) return { content: raw, truncated: false };
  return { content: raw.slice(0, DOC_MAX_BYTES), truncated: true };
}

/** 按 pluginId 找已装插件（未安装/已卸载返回 undefined） */
function findPlugin(pluginId: string) {
  return listInstalledPlugins().find((p) => p.pluginId === pluginId);
}

/**
 * 取单个插件组件的正文。kind 只认三种；组件在该插件里不存在（没声明该类组件、
 * 名称对不上、文件缺失或读失败）返回 undefined。
 */
export async function readPluginComponentDoc(
  pluginId: string,
  kind: PluginComponentKind,
  name: string,
): Promise<PluginComponentDoc | undefined> {
  const plugin = findPlugin(pluginId);
  if (!plugin) return undefined;

  if (kind === "skill") {
    const dir = resolvePluginComponent(plugin.manifest, "skills");
    if (!dir) return undefined;
    // 复用技能层的清单函数取定义文件路径：命名/frontmatter 解析与生效链完全同源，
    // 免得这里再解一遍目录结构得出与实际加载不一致的路径
    const entries = await listPluginSkillEntries(dir, pluginId);
    const entry = entries.find((e) => e.name === name);
    if (!entry) return undefined;
    const read = readCapped(entry.path);
    if (!read) return undefined;
    return { kind, name, path: entry.path, ...read };
  }

  if (kind === "subagent") {
    const dir = resolvePluginComponent(plugin.manifest, "subagents");
    if (!dir) return undefined;
    const doc = readPluginSubagentDoc(dir, pluginId, name);
    if (!doc) return undefined;
    const read = readCapped(doc.path);
    // 原文以解析层读到的为准（列表层与文档层读的是同一份 YAML），仅用读取结果判可用性
    if (!read) return undefined;
    return { kind, name, path: doc.path, content: doc.raw, truncated: read.truncated };
  }

  // MCP：取 mcpServers 文件里该服务器的那条 JSON，保留作者原始写法。
  // 整文件读进来解析（截断过的 JSON 解析必然失败），只对最终那条做上限截断。
  const file = resolvePluginComponent(plugin.manifest, "mcpServers");
  if (!file) return undefined;
  let servers: Record<string, unknown>;
  try {
    const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
    const raw = (doc as Record<string, unknown> | null)?.mcpServers;
    if (typeof raw !== "object" || raw === null) return undefined;
    servers = raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const entry = servers[name];
  if (entry === undefined) return undefined;
  let content = JSON.stringify(entry, null, 2);
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > DOC_MAX_BYTES) {
    content = content.slice(0, DOC_MAX_BYTES);
    truncated = true;
  }
  return { kind, name, path: file, content, truncated };
}