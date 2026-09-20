/**
 * 主代理的插件管理工具组：plugins_list / plugins_install / plugins_scaffold。
 *
 * 与技能/子智能体管理组（skill-mgmt-tools / subagent-mgmt-tools）同款设计：
 * 执行体直接复用 plugins.ts 存储层函数，市场页有的一切语义——清单三态探测、
 * 路径包含性校验、安装物化与目录缓存——都长在同一处。管理组挂在 Task 组旁、
 * 不在 baseTools 里：delegate 按定义取工具时结构性拿不到它们。
 *
 * 信任分层（install/scaffold 在 modes.ts 的 APPROVAL_REQUIRED_TOOLS 里）：
 * - list 只读，无需审批；
 * - install 从市场拉取外部内容并物化（MCP 会起进程、hooks 会执行命令），
 *   触发审批让用户做信任决策；安装后 skills/subagents 热重载 + MCP 连接池
 *   diff 由本模块完成（reload 回调由 sessions 注入，避免模块环）；
 * - scaffold 让 AI 生成插件目录写进专属 dev 市场（devMarketplaceDir）并自动
 *   登记——创作交给 AI，安装决策仍由用户在市场 UI 点下。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logErr } from "./log";
import {
  addMarketplace,
  devMarketplaceDir,
  getMarketplaceCatalog,
  installPlugin,
  listInstalledPlugins,
  listMarketplaces,
  PLUGIN_NAME_RE,
  refreshMarketplace,
  type MarketplaceCatalog,
} from "./plugins";
import { activeMcpServers } from "./mcp-config";
import { mcpManager } from "./mcp-manager";
import { renderSkillDoc, type SkillDraft } from "./skills";
import type { Running } from "./types";

export const PLUGIN_MGMT_TOOL_NAMES = {
  list: "plugins_list",
  install: "plugins_install",
  scaffold: "plugins_scaffold",
} as const;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${text}` }],
    details: { error: text },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 市场条目的单行描述（list 输出与 install 的市场解析共用） */
function catalogLine(
  mktName: string,
  catalog: MarketplaceCatalog,
  installedIds: Set<string>,
  mktId: string,
): string[] {
  return catalog.plugins.map((p) => {
    const installed = installedIds.has(`${p.name}@${mktId}`);
    return `- [${mktName}] ${p.name}${p.version ? ` v${p.version}` : ""}${installed ? "（已安装）" : ""}${p.description ? ` — ${p.description}` : ""}`;
  });
}

export function buildPluginMgmtTools(
  run: Running,
  reload: () => Promise<void>,
): AgentTool[] {
  const listTool: AgentTool = {
    name: PLUGIN_MGMT_TOOL_NAMES.list,
    label: "列出插件",
    description: [
      "列出插件系统全貌：已登记的市场（名称/类型）与各自目录里的插件（版本/描述/是否已安装），以及本机已安装插件的组件摘要（技能/MCP/钩子/子智能体数量与开关）。",
      "想安装插件或创建新插件前先调用它：你会知道市场里有什么、名字是否已被占用、用户装了什么。",
    ].join("\n\n"),
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const records = listMarketplaces();
        const installed = listInstalledPlugins();
        const installedIds = new Set(installed.map((p) => p.pluginId));
        const lines: string[] = [];
        if (records.length === 0) {
          lines.push("（尚未添加任何插件市场——请用户在 插件市场 → ＋ 添加市场 里操作）");
        }
        for (const r of records) {
          const { catalog, needsRefresh } = getMarketplaceCatalog(r.id);
          lines.push(
            `市场 ${r.name}（${r.type === "git" ? `git ${r.repo ?? ""}` : r.path ?? ""}）${needsRefresh ? "——目录未加载，install 前会自动刷新" : ""}`,
          );
          lines.push(...catalogLine(r.name, catalog, installedIds, r.id));
        }
        lines.push("", `已安装插件（${installed.length}）：`);
        for (const p of installed) {
          const c = p.manifest.components;
          const parts = [
            c.skills ? `技能${countEntries(p, "skills")}` : null,
            c.mcpServers ? "MCP" : null,
            c.hooks ? "钩子" : null,
            c.subagents ? `子智能体${countEntries(p, "subagents")}` : null,
          ].filter(Boolean);
          lines.push(
            `- ${p.pluginId} v${p.version} [${p.manifest.manifestKind}] ${p.enabled ? "启用" : "停用"}${parts.length ? `（${parts.join(" / ")}）` : "（无组件）"}`,
          );
          for (const d of p.diagnostics.slice(0, 3)) lines.push(`    诊断: ${d}`);
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  const installTool: AgentTool = {
    name: PLUGIN_MGMT_TOOL_NAMES.install,
    label: "安装插件",
    description: [
      "从已登记的插件市场安装（或更新）一个插件：物化到本机后立即热生效——技能进系统提示词目录、MCP 服务器接入连接池、钩子与子智能体挂载。",
      "安装外部内容会触发用户审批（MCP 服务器会运行进程、钩子会执行命令），这是有意的信任闸门，不要试图绕过。",
      "先调 plugins_list 确认市场名与插件名；未添加市场时提示用户在 插件市场 → ＋ 添加市场 操作。",
    ].join("\n\n"),
    parameters: Type.Object({
      marketplace: Type.String({
        description: "市场名（如 leinator-codex）或市场 id；模糊匹配唯一命中即可",
      }),
      name: Type.String({ description: "要安装的插件名（市场目录里的 name）" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { marketplace?: string; name?: string };
      try {
        const marketplace = String(p.marketplace ?? "").trim();
        const name = String(p.name ?? "").trim();
        if (!marketplace) throw new Error("marketplace 必填（先调 plugins_list 查看可用市场）");
        if (!name) throw new Error("name 必填");
        const records = listMarketplaces();
        const record =
          records.find((r) => r.id === marketplace) ??
          records.find((r) => r.name === marketplace) ??
          records.find((r) => r.name.toLowerCase().includes(marketplace.toLowerCase()));
        if (!record) {
          throw new Error(
            `未找到市场 "${marketplace}"。已登记：${records.map((r) => r.name).join("、") || "（无）"}`,
          );
        }
        const { plugin, updated } = await installPlugin(record.id, name);
        // 与协议层 set_plugin_enabled 同款全链路热重载：技能提示词重组 +
        // 子智能体重排（注入回调）+ MCP 连接池 diff（本模块直接做，避免模块环）
        await reload();
        mcpManager.applyConfig(await activeMcpServers(run.cwd));
        const c = plugin.manifest.components;
        return textResult(
          [
            `${updated ? "已更新" : "已安装"} ${plugin.pluginId} v${plugin.version}`,
            `组件：${[c.skills ? "技能" : null, c.mcpServers ? "MCP" : null, c.hooks ? "钩子" : null, c.subagents ? "子智能体" : null].filter(Boolean).join(" / ") || "无"}`,
            "已热生效：技能进 <available_skills> 目录，MCP/钩子/子智能体即时挂载。",
          ].join("\n"),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  const scaffoldTool: AgentTool = {
    name: PLUGIN_MGMT_TOOL_NAMES.scaffold,
    label: "创建插件",
    description: [
      "为用户创建一个新插件包：生成清单（.xulux-plugin/plugin.json）与技能文件，写进专属 dev 市场（本机 " +
        devMarketplaceDir() +
        "）并自动登记/刷新该市场——之后用户在 插件市场 页选中该市场点安装即可。",
      "适合「帮我做一个 xx 技能插件」类请求：你提供 name/description 和技能数组，本工具负责 SKILL.md frontmatter 渲染、目录布局与市场登记。",
      "v1 只生成技能组件；MCP/钩子/子智能体组件请提示用户在生成的插件目录里手工添加（或先用 skills_save 直接建技能）。",
      "生成内容会写盘，触发用户审批。",
    ].join("\n\n"),
    parameters: Type.Object({
      name: Type.String({
        description: "插件名：小写字母/数字开头，仅可含小写字母、数字、._-（≤128 字符），须与生成目录名一致",
      }),
      description: Type.String({ description: "插件一句话描述（市场卡片与清单 description）" }),
      skills: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "技能名（≤64 字符，作为 frontmatter name）" }),
            description: Type.String({
              description: "技能描述：模型据此判断何时使用，务必写清触发场景",
            }),
            content: Type.String({ description: "技能正文 Markdown（frontmatter 之后的部分）" }),
          }),
          { description: "要打包进插件的技能列表（至少 1 个）" },
        ),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as {
        name?: string;
        description?: string;
        skills?: Array<{ name?: string; description?: string; content?: string }>;
      };
      try {
        const name = String(p.name ?? "").trim();
        const description = String(p.description ?? "").trim();
        if (!PLUGIN_NAME_RE.test(name)) {
          throw new Error(`name 需匹配 ${PLUGIN_NAME_RE.source}（如 "my-pack"）`);
        }
        if (!description) throw new Error("description 必填");
        const skills = Array.isArray(p.skills) ? p.skills : [];
        if (skills.length === 0) throw new Error("skills 至少提供 1 个（v1 插件只生成技能组件）");

        // 生成插件目录（已存在即拒绝：AI 改名重试，绝不静默覆盖用户文件）
        const pluginDir = join(devMarketplaceDir(), "plugins", name);
        if (existsSync(pluginDir)) {
          throw new Error(`插件目录已存在：${pluginDir}（换一个 name，或让用户先删除旧目录）`);
        }
        const drafts: SkillDraft[] = skills.map((s) => {
          const d = {
            name: String(s.name ?? "").trim(),
            description: String(s.description ?? "").trim(),
            content: String(s.content ?? "").trim(),
          };
          if (!d.name) throw new Error("skills[].name 必填");
          if (!d.description) throw new Error(`技能 "${d.name}" 缺 description`);
          if (!d.content) throw new Error(`技能 "${d.name}" 缺正文`);
          return d;
        });

        mkdirSync(join(pluginDir, ".xulux-plugin"), { recursive: true });
        writeFileSync(
          join(pluginDir, ".xulux-plugin", "plugin.json"),
          `${JSON.stringify(
            {
              name,
              version: "0.1.0",
              description,
              author: { name: "generated" },
              skills: "skills",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        mkdirSync(join(pluginDir, "skills"), { recursive: true });
        for (const d of drafts) {
          writeFileSync(join(pluginDir, "skills", `${d.name}.md`), renderSkillDoc(d), "utf8");
        }

        // 市场清单 upsert（保留其他条目），再幂等登记/刷新市场（更新目录缓存）
        const mktJson = join(devMarketplaceDir(), "marketplace.json");
        let doc: { name?: string; plugins?: Array<Record<string, unknown>> } = {};
        try {
          doc = JSON.parse(readFileSync(mktJson, "utf8"));
        } catch {
          doc = { name: "dev-marketplace", plugins: [] };
        }
        if (!Array.isArray(doc.plugins)) doc.plugins = [];
        const entry = {
          name,
          version: "0.1.0",
          description,
          source: { source: "directory", path: `./plugins/${name}` },
        };
        const idx = doc.plugins.findIndex((e) => e.name === name);
        if (idx >= 0) doc.plugins[idx] = entry;
        else doc.plugins.push(entry);
        mkdirSync(devMarketplaceDir(), { recursive: true });
        writeFileSync(mktJson, `${JSON.stringify({ name: "dev-marketplace", ...doc }, null, 2)}\n`, "utf8");
        const { record } = await addMarketplace({ type: "directory", path: devMarketplaceDir() });
        await refreshMarketplace(record.id).catch((err) =>
          logErr("plugin scaffold refresh:", errorMessage(err)),
        );

        return textResult(
          [
            `插件已生成：${pluginDir}`,
            `包含技能：${drafts.map((d) => d.name).join("、")}`,
            `dev 市场已登记：${record.name}（${record.id}）`,
            "下一步：请用户在 插件市场 页选中 dev-marketplace 点「刷新」，然后安装该插件（安装需用户确认）。",
          ].join("\n"),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  return [listTool, installTool, scaffoldTool];
}

/** 组件条目计数（list 输出用；目录缺失/不可读按 0） */
function countEntries(
  p: ReturnType<typeof listInstalledPlugins>[number],
  kind: "skills" | "subagents",
): number {
  const rel = p.manifest.components[kind];
  if (!rel) return 0;
  try {
    return readdirSync(join(p.manifest.root, rel)).length;
  } catch {
    return 0;
  }
}
