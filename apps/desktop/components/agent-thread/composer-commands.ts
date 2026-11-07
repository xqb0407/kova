"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  unstable_useMentionAdapter,
  useAuiState,
  type Unstable_IconComponent,
  type Unstable_Mention,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  buildLibraryDirectiveId,
  joinFsPath,
  sanitizeDirectiveLabel,
} from "@/lib/composer/library-reference";
import { useRecentLibraryEntries } from "@/lib/workspace/library-index";
import { getLibraryRootInfo } from "@/lib/workspace/library-root";
import { fetchMcpServerTools, useMcpServers, type McpToolInfo } from "@/lib/mcp/mcp";
import { useSkills, type SkillEntry } from "@/lib/skills/skills";
import { useCustomCommands } from "@/lib/pi/pi-commands";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import { useSubagents } from "@/lib/subagent/subagents";
import { subagentAvatarIconComponent } from "@/components/custom-ui/subagent-avatar";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useIsRemoteWorkspace } from "@/lib/workspace/remote-projects";
import { isDesktop } from "@/lib/desktop-env";
import { getPetPrefs, patchPetPrefs } from "@/lib/settings/pet-prefs";
import { openPanelTab } from "@/lib/panels/panel-tabs";
import { setSessionMode } from "@/lib/pi/pi-session-mode";
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  CatIcon,
  EyeIcon,
  FolderTreeIcon,
  GitGraphIcon,
  GlobeIcon,
  LibraryIcon,
  ListTodoIcon,
  PlugIcon,
  SlashIcon,
  StickyNoteIcon,
  ClipboardListIcon,
  MessageCircleQuestionIcon,
  SquareTerminalIcon,
  TargetIcon,
  ZapIcon,
} from "lucide-react";

/**
 * 输入框触发菜单的数据聚合（composer.tsx 消费）：
 * - `/` 指令菜单：命令（纯前端动作）+ 技能 + MCP 工具，三分类钻取；
 * - `@` 提及：子智能体（占位文案「@选择智能体」）。
 *
 * 执行语义（sidecar 无 slash 解析，技能/工具都由模型执行，前端只负责插入芯片）：
 * - 命令：onExecute 直接做前端动作，触发文本由库剥离；
 * - 技能：插入 :skill[名]{name=skill:id} 指令芯片（模型端系统提示词已含
 *   <available_skills> 的 name/location，凭名即可定位读取），草稿同行接续；
 * - MCP 工具：同款 :tool[名] 芯片，工具仍由 agent 循环经 MCP 网关调用。
 *
 * 技能/工具的芯片插入由输入框的 selectItemOverride 接管（cm-composer-input.tsx）：
 * 库默认路径的剥离 setText 经 tap store 异步生效，onExecute 里读 getState()
 * 拿到的还是未剥离文本（触发字符会残留），override 则用 CM 文档 + 光标同步剥离。
 * 弹层自身就用 setText 改文本，composer 输入组件对外部 setText 同步。
 */

/** 弹层图标解析表：分类按 id、条目按 metadata.icon 查键 */
const ICON_MAP: Record<string, FC<{ className?: string }>> = {
  commands: ZapIcon,
  Cat: CatIcon,
  skills: BookOpenIcon,
  tools: PlugIcon,
  Bot: BotIcon,
  BookOpen: BookOpenIcon,
  Library: LibraryIcon,
  StickyNote: StickyNoteIcon,
  Plug: PlugIcon,
  GitGraph: GitGraphIcon,
  SquareTerminal: SquareTerminalIcon,
  Globe: GlobeIcon,
  FolderTree: FolderTreeIcon,
  Activity: ActivityIcon,
  ListTodo: ListTodoIcon,
  Eye: EyeIcon,
  Target: TargetIcon,
  MessageCircleQuestion: MessageCircleQuestionIcon,
  ClipboardList: ClipboardListIcon,
};

/** 面板类命令：开右侧面板标签 + 展开面板（模式同分支菜单的「Git 图谱」） */
const openPanel = (type: Parameters<typeof openPanelTab>[0]) => {
  openPanelTab(type);
  window.dispatchEvent(new Event("agent-panel:open"));
};

/**
 * 模式类命令（问答 / 目标）的共同动作：切档，**不代发消息**。
 *
 * 不代发是刻意的：目标模式里「用户说的第一句话就是目标」，命令自己编一条目标会让
 * 目标原文脱离用户原话——而那段原文要进系统提示词、还会被逐字重述进每一轮续跑。
 * 问答模式同理，问什么得由用户打。
 */
const switchMode = (
  threadId: string | undefined,
  mode: "ask" | "plan" | "goal",
  label: string,
) => {
  if (!threadId) return;
  setSessionMode(threadId, mode).catch((err) =>
    console.error(`set_mode(${mode}) from ${label} failed:`, err),
  );
};

type SlashCommandDef = {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** 面板标签仅 桌面端可见（shell/explorer，见 tab-registry 过滤） */
  desktopOnly?: boolean;
  /** 远程项目不提供（文件树暂不支持，门控与 tab-registry 同源） */
  remoteUnsupported?: boolean;
  /**
   * 命令动作。ctx.threadId 是当前会话线程（面板类命令用不到，模式类命令要用它发
   * set_mode）——菜单在这一层才拿得到 threadId，所以作为参数注入而不是模块级闭包。
   */
  run: (ctx: { threadId: string | undefined }) => void;
};

const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    id: "pet",
    label: "/pet",
    description: "显示/隐藏桌宠",
    icon: "Cat",
    run: () => {
      // 召唤/收起二态切换：隐藏态回到上次的形态（应用内/悬浮窗）
      const prefs = getPetPrefs();
      patchPetPrefs({ mode: prefs.mode === "off" ? prefs.lastNonOffMode : "off" });
    },
  },
  {
    id: "git",
    label: "/git",
    description: "打开 Git 图谱面板",
    icon: "GitGraph",
    run: () => openPanel("git"),
  },
  {
    id: "shell",
    label: "/shell",
    description: "打开终端面板",
    icon: "SquareTerminal",
    desktopOnly: true,
    run: () => openPanel("shell"),
  },
  {
    id: "browser",
    label: "/browser",
    description: "打开浏览器面板",
    icon: "Globe",
    run: () => openPanel("browser"),
  },
  {
    id: "explorer",
    label: "/explorer",
    description: "打开文件树面板",
    icon: "FolderTree",
    desktopOnly: true,
    remoteUnsupported: true,
    run: () => openPanel("explorer"),
  },
  {
    id: "activity",
    label: "/activity",
    description: "打开活动面板",
    icon: "Activity",
    run: () => openPanel("activity"),
  },
  {
    id: "plan-panel",
    label: "/plan-panel",
    description: "打开计划面板（任务清单）",
    icon: "ListTodo",
    run: () => openPanel("plan"),
  },
  {
    id: "review",
    label: "/review",
    description: "打开审查面板",
    icon: "Eye",
    run: () => openPanel("review"),
  },
  {
    id: "plan",
    label: "/plan",
    description: "切到计划模式：先出计划，批准后再实施",
    icon: "ClipboardList",
    run: ({ threadId }) => switchMode(threadId, "plan", "/plan"),
  },
  {
    id: "ask",
    label: "/ask",
    description: "切到问答模式：只读工具，问问题就得到答案",
    icon: "MessageCircleQuestion",
    run: ({ threadId }) => switchMode(threadId, "ask", "/ask"),
  },
  {
    id: "goal",
    label: "/goal",
    description: "切到目标模式：说一个目标，我跨轮把它做完",
    icon: "Target",
    run: ({ threadId }) => switchMode(threadId, "goal", "/goal"),
  },
];

function toSkillItem(skill: SkillEntry): Unstable_TriggerItem {
  return {
    id: `skill:${skill.name}`,
    type: "skill",
    label: skill.name,
    description: skill.description,
    metadata: { icon: "BookOpen" },
  };
}

function toToolItem(server: string, tool: McpToolInfo): Unstable_TriggerItem {
  return {
    id: `tool:${server}:${tool.name}`,
    type: "tool",
    label: tool.name,
    description: tool.description ? `${server}：${tool.description}` : server,
    metadata: { icon: "Plug" },
  };
}

/** 拉取各就绪服务器的工具清单：sidecar 元数据缓存优先（ready 态必有缓存），缺失才握手。
 *  只取 ready 态——避免在输入框里打字就把懒服务器唤醒握手。
 *  导出给 composer 的 + 菜单「连接器」面板复用（同一份就绪集合，避免两处口径漂移）。 */
export function useMcpToolsByServer(workspace: string | null) {
  const mcp = useMcpServers(workspace);
  // 插件服务器与常规服务器同场：只在 ready 态取工具（避免打字唤醒懒服务器）
  const readyKey = [...mcp.servers, ...mcp.pluginServers]
    .filter((s) => s.enabled && s.status.state === "ready")
    .map((s) => s.name)
    .join(",");
  const serversRef = useRef(mcp.servers);
  serversRef.current = mcp.servers;
  const [toolsByServer, setToolsByServer] = useState<
    Record<string, McpToolInfo[]>
  >({});

  useEffect(() => {
    if (!readyKey) {
      setToolsByServer((prev) =>
        Object.keys(prev).length === 0 ? prev : {},
      );
      return;
    }
    let alive = true;
    const names = readyKey.split(",");
    void Promise.all(
      names.map(async (name) => {
        try {
          return [name, await fetchMcpServerTools(name, workspace)] as const;
        } catch {
          return [name, [] as McpToolInfo[]] as const;
        }
      }),
    ).then((entries) => {
      if (alive) setToolsByServer(Object.fromEntries(entries));
    });
    return () => {
      alive = false;
    };
  }, [readyKey, workspace]);

  return toolsByServer;
}

/** `/` 指令菜单：命令 + 技能 + MCP 工具 三分类 adapter，供 ComposerTriggerPopover 展开。
 *  includeCommands=false 时去掉面板类命令（自动化弹窗里没有可开的面板，留着只会误导）。 */
export function useComposerSlashMenu(
  opts: { includeCommands?: boolean } = {},
): {
  adapter: Unstable_TriggerAdapter;
  action: { onExecute: (item: Unstable_TriggerItem) => void; removeOnExecute: true };
  iconMap: Record<string, FC<{ className?: string }>>;
  fallbackIcon: FC<{ className?: string }>;
} {
  const { includeCommands = true } = opts;
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const workspace = useWorkspace();
  const remote = useIsRemoteWorkspace(workspace);
  const skills = useSkills(workspace);
  const toolsByServer = useMcpToolsByServer(workspace);
  const customCommands = useCustomCommands(workspace);

  const commandItems = useMemo<Unstable_TriggerItem[]>(
    () =>
      includeCommands
        ? [
            // 自定义命令（.kova/commands + 全局 + 内置 /init）在最前：用户定义
            // 的优先于内置面板动作。选中插 `/name ` 纯文本，展开在发送时由
            // sidecar 完成（见 onExecute）——不是芯片，参数由用户续写
            ...customCommands.map((c) => ({
              id: `prompt-cmd:${c.name}`,
              type: "command",
              label: `/${c.name}`,
              description:
                (c.description || "自定义命令") +
                (c.argumentHint ? `（${c.argumentHint}）` : ""),
              metadata: {
                icon: "Zap",
                customPrompt: c.name,
                customSource: c.source,
              },
            })),
            ...SLASH_COMMANDS.filter(
              (c) =>
                (!c.desktopOnly || isDesktop()) &&
                !(c.remoteUnsupported && remote),
            ).map((c) => ({
              id: c.id,
              type: "command",
              label: c.label,
              description: c.description,
              metadata: { icon: c.icon },
            })),
          ]
        : [],
    [includeCommands, remote, customCommands],
  );

  const skillItems = useMemo<Unstable_TriggerItem[]>(
    () =>
      // 插件技能（pluginSkills）与常规技能同场：芯片凭名定位，模型侧已同链生效
      [...skills.skills, ...skills.pluginSkills]
        .filter((s) => s.enabled && !s.shadowed)
        .map(toSkillItem),
    [skills.skills, skills.pluginSkills],
  );

  const toolItems = useMemo<Unstable_TriggerItem[]>(
    () =>
      Object.entries(toolsByServer).flatMap(([server, tools]) =>
        tools.map((tool) => toToolItem(server, tool)),
      ),
    [toolsByServer],
  );

  const adapter = useMemo<Unstable_TriggerAdapter>(() => {
    const all = [...commandItems, ...skillItems, ...toolItems];
    return {
      // 平铺分组视图：categories() 返回空使弹层恒为搜索模式，条目全由 search(query)
      // 供给（空 query 返回全量即完整分组视图）；分组由渲染层按条目 type 插组头
      categories: () => [],
      categoryItems: () => [],
      search: (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return all;
        return all.filter(
          (i) =>
            i.label.toLowerCase().includes(q) ||
            (i.description ?? "").toLowerCase().includes(q),
        );
      },
    };
  }, [commandItems, skillItems, toolItems]);

  // 仅 command 走到这里：skill/tool 的芯片插入由输入框的 selectItemOverride
  // 接管（见 cm-composer-input.tsx——库默认路径的剥离 setText 异步生效，
  // onExecute 里读 getState() 会拿到未剥离的触发文本）
  const onExecute = (item: Unstable_TriggerItem) => {
    if (item.type !== "command") return;
    // 自定义命令：库剥离已敲的触发文本（removeOnExecute，store setText 异步
    // 落到 CM），这里把完整的 `/name ` 插到光标处——插的是纯文本不是芯片，
    // 参数由用户续写后发送，展开在 sidecar（runTurnBody 入口）。
    // 必须延迟一拍（冒烟实锤）：onExecute 同步直写 CM 会抢在库剥离前面，
    // 两相踩踏产出 "/ /init"。macrotask 让剥离先落地，再插入完整命令。
    const customPrompt = item.metadata?.customPrompt;
    if (typeof customPrompt === "string") {
      setTimeout(() => insertIntoComposer(`/${customPrompt} `), 0);
      return;
    }
    SLASH_COMMANDS.find((c) => c.id === item.id)?.run({ threadId });
  };

  return {
    adapter,
    action: { onExecute, removeOnExecute: true },
    iconMap: ICON_MAP,
    fallbackIcon: SlashIcon,
  };
}

/**
 * 子代理条目的专属图标：iconMap 按每个条目自己的键取组件，组件闭包捕获该代理
 * 的名字与头像值。有头像（显式或按名默认）渲染圆角小图；解析不到落回 Bot 线条
 * 图标（fallback="plain"，与旧行为一致）。组件工厂在 subagent-avatar.tsx
 * （JSX 不能出现在 .ts）。
 */
const AGENT_AVATAR_KEY_PREFIX = "agent-avatar:";

/** `@` 提及的子智能体条目（启用项，含插件子智能体）。
 *  useSubagentMention（自动化弹窗沿用）与 useComposerMention（会话内，带资料库
 *  分组）共用同一份清单；iconMap 与条目一一配对（键 = agent-avatar:<名字>）。 */
function useSubagentMentions(): {
  items: readonly Unstable_Mention[];
  iconMap: Record<string, Unstable_IconComponent>;
} {
  const workspace = useWorkspace();
  const subagents = useSubagents(workspace);
  return useMemo(() => {
    const iconMap: Record<string, Unstable_IconComponent> = {};
    const items = [...subagents.agents, ...subagents.pluginAgents]
      .filter((a) => a.enabled)
      .map((a) => {
        const icon = `${AGENT_AVATAR_KEY_PREFIX}${a.name}`;
        iconMap[icon] = subagentAvatarIconComponent(a.name, a.avatar);
        return {
          id: `agent:${a.name}`,
          type: "agent",
          label: a.name,
          description: a.description,
          icon,
        };
      });
    return { items, iconMap };
  }, [subagents.agents, subagents.pluginAgents]);
}

/** `@` 提及：子智能体清单（启用项，含插件子智能体），插芯片随消息发给模型 */
export function useSubagentMention() {
  const { items, iconMap: agentIconMap } = useSubagentMentions();
  return unstable_useMentionAdapter({
    items,
    includeModelContextTools: false,
    iconMap: { Bot: BotIcon, ...agentIconMap },
    fallbackIcon: BotIcon,
  });
}

/** `@` 提及的资料库条目：笔记优先 + #tag，普通文件随后。
 *  数据来自 library-index（library_scan + 文件元数据合并打分）；条目 id 即
 *  引用芯片 id（固化的绝对路径），选择后由库的 Directive 行为序列化成芯片。
 *
 *  展示名一律用**文件名**（与树/查看器一致）：元数据里的派生标题（首标题/
 *  首行/去扩展名）只用于搜索——之前拿它当 label，会出现「新笔记 4」对不上
 *  「新笔记 4.md」、「1. OpenHands…」对不上实际文件名的问题。标题放在
 *  metadata.title 里参与过滤，不上屏。 */
function useLibraryMentionItems(): {
  items: Unstable_TriggerItem[];
  loading: boolean;
} {
  const { entries, loading } = useRecentLibraryEntries();
  const root = getLibraryRootInfo()?.root ?? null;
  const items = useMemo<Unstable_TriggerItem[]>(() => {
    if (!root) return [];
    const out: Unstable_TriggerItem[] = [];
    for (const entry of entries) {
      const absPath = joinFsPath(root, entry.rel);
      const isNote = /\.md$/iu.test(entry.rel);
      out.push({
        id: buildLibraryDirectiveId({
          rel: entry.rel,
          name: entry.name,
          absPath,
        }),
        type: "library",
        label: sanitizeDirectiveLabel(entry.name),
        description: entry.tags.length
          ? entry.tags.map((tag) => `#${tag}`).join(" ")
          : dirOfRel(entry.rel),
        metadata: {
          icon: isNote ? "StickyNote" : "Library",
          // 派生标题仅参与选择器过滤，不上屏（与文件名不一致会造成误解）
          ...(entry.title ? { title: entry.title } : {}),
        },
      });
    }
    return out;
  }, [entries, root]);
  return { items, loading };
}

/** rel 的目录部分（根目录文件返回「资料库根」） */
function dirOfRel(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash === -1 ? "资料库根" : rel.slice(0, slash);
}

/**
 * `@` 提及（会话内 composer）：子智能体 + 资料库 两组。
 *
 * 与 useSubagentMention 的差别只在数据源多一组资料库条目——那组来自本地索引
 * （异步首拉），所以 adapter 用平铺自定义 search 而不是 mention adapter 的
 * 全量池：空 query 返回「全部子智能体 + 最近 12 条资料库」（菜单不肿），
 * 有关键词在并集里过滤（子智能体在先，资料库条目保持打分后的顺序）。
 */
export function useComposerMention(): {
  adapter: Unstable_TriggerAdapter;
  directive: { formatter: typeof unstable_defaultDirectiveFormatter };
  iconMap: Record<string, FC<{ className?: string }>>;
  fallbackIcon: FC<{ className?: string }>;
  isLoading: boolean;
} {
  const { items: agentMentions, iconMap: agentIconMap } = useSubagentMentions();
  const { items: libraryItems, loading } = useLibraryMentionItems();

  const agentItems = useMemo<Unstable_TriggerItem[]>(
    () =>
      agentMentions.map((m) => ({
        id: m.id,
        type: m.type,
        label: m.label,
        description: m.description,
        metadata: { icon: m.icon ?? "Bot" },
      })),
    [agentMentions],
  );

  const adapter = useMemo<Unstable_TriggerAdapter>(() => {
    const all = [...agentItems, ...libraryItems];
    return {
      categories: () => [],
      categoryItems: () => [],
      search: (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return [...agentItems, ...libraryItems.slice(0, 12)];
        return all.filter((item) => {
          if (
            item.label.toLowerCase().includes(q) ||
            (item.description ?? "").toLowerCase().includes(q)
          ) {
            return true;
          }
          // 派生标题不上屏，但仍可被搜索命中（metadata.title）
          const title =
            typeof item.metadata?.title === "string"
              ? item.metadata.title.toLowerCase()
              : "";
          return title.includes(q);
        });
      },
    };
  }, [agentItems, libraryItems]);

  return {
    adapter,
    directive: { formatter: unstable_defaultDirectiveFormatter },
    iconMap: {
      Bot: BotIcon,
      Library: LibraryIcon,
      StickyNote: StickyNoteIcon,
      ...agentIconMap,
    },
    fallbackIcon: BotIcon,
    isLoading: loading,
  };
}
