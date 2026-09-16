"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  unstable_useMentionAdapter,
  useAui,
  type Unstable_Mention,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";
import { fetchMcpServerTools, useMcpServers, type McpToolInfo } from "@/lib/mcp";
import { useSkills, type SkillEntry } from "@/lib/skills";
import { useSubagents } from "@/lib/subagents";
import { useWorkspace } from "@/lib/workspace-store";
import { isTauri } from "@/lib/tauri";
import { openPanelTab } from "@/lib/panel-tabs";
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  EyeIcon,
  FolderTreeIcon,
  GitGraphIcon,
  GlobeIcon,
  ListTodoIcon,
  PlugIcon,
  SlashIcon,
  SquareTerminalIcon,
  ZapIcon,
} from "lucide-react";

/**
 * 输入框触发菜单的数据聚合（composer.tsx 消费）：
 * - `/` 指令菜单：命令（纯前端动作）+ 技能 + MCP 工具，三分类钻取；
 * - `@` 提及：子智能体（占位文案「@选择智能体」）。
 *
 * 执行语义（sidecar 无 slash 解析，技能/工具都由模型执行，前端只负责把意图说清楚）：
 * - 命令：execute 直接做前端动作，触发文本随手剥离；
 * - 技能：向输入框前置一段引导文本（读技能文件路径 + 按指引处理），用户的草稿保留在后；
 * - MCP 工具：前置「请使用 MCP 工具 xxx（服务器 yyy）」，工具仍由 agent 循环经 MCP 网关调用。
 *
 * 顺序依赖一个实现细节：TriggerPopover.Action 在 removeOnExecute 时先剥离触发文本、
 * 后调 onExecute（见 triggerSelectionResource.selectItem），所以 onExecute 里读
 * aui.composer.getState().text 拿到的就是剥离后的剩余文本，前置拼接无竞态；
 * 且弹层自身就用 setText 改文本，LexicalComposerInput 对外部 setText 同步。
 */

/** 弹层图标解析表：分类按 id、条目按 metadata.icon 查键 */
const ICON_MAP: Record<string, FC<{ className?: string }>> = {
  commands: ZapIcon,
  skills: BookOpenIcon,
  tools: PlugIcon,
  Bot: BotIcon,
  BookOpen: BookOpenIcon,
  Plug: PlugIcon,
  GitGraph: GitGraphIcon,
  SquareTerminal: SquareTerminalIcon,
  Globe: GlobeIcon,
  FolderTree: FolderTreeIcon,
  Activity: ActivityIcon,
  ListTodo: ListTodoIcon,
  Eye: EyeIcon,
};

/** 面板类命令：开右侧面板标签 + 展开面板（模式同分支菜单的「Git 图谱」） */
const openPanel = (type: Parameters<typeof openPanelTab>[0]) => {
  openPanelTab(type);
  window.dispatchEvent(new Event("agent-panel:open"));
};

type SlashCommandDef = {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** 面板标签仅 Tauri 桌面端可见（shell/explorer，见 tab-registry 过滤） */
  tauriOnly?: boolean;
  run: () => void;
};

const SLASH_COMMANDS: readonly SlashCommandDef[] = [
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
    tauriOnly: true,
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
    tauriOnly: true,
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
    id: "plan",
    label: "/plan",
    description: "打开计划面板",
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
];

function toSkillItem(skill: SkillEntry): Unstable_TriggerItem {
  return {
    id: `skill:${skill.name}`,
    type: "skill",
    label: skill.name,
    description: skill.description,
    metadata: {
      icon: "BookOpen",
      insert: `请先读取技能文件 ${skill.path}，严格按技能「${skill.name}」的指引处理以下任务：`,
    },
  };
}

function toToolItem(server: string, tool: McpToolInfo): Unstable_TriggerItem {
  return {
    id: `tool:${server}:${tool.name}`,
    type: "tool",
    label: tool.name,
    description: tool.description ? `${server}：${tool.description}` : server,
    metadata: {
      icon: "Plug",
      insert: `请使用 MCP 工具「${tool.name}」（服务器 ${server}）处理以下任务：`,
    },
  };
}

/** 拉取各就绪服务器的工具清单：sidecar 元数据缓存优先（ready 态必有缓存），缺失才握手。
 *  只取 ready 态——避免在输入框里打字就把懒服务器唤醒握手。 */
function useMcpToolsByServer(workspace: string | null) {
  const mcp = useMcpServers(workspace);
  const readyKey = mcp.servers
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

/** `/` 指令菜单：命令 + 技能 + MCP 工具 三分类 adapter，供 ComposerTriggerPopover 展开 */
export function useComposerSlashMenu(): {
  adapter: Unstable_TriggerAdapter;
  action: { onExecute: (item: Unstable_TriggerItem) => void; removeOnExecute: true };
  iconMap: Record<string, FC<{ className?: string }>>;
  fallbackIcon: FC<{ className?: string }>;
} {
  const workspace = useWorkspace();
  const skills = useSkills(workspace);
  const toolsByServer = useMcpToolsByServer(workspace);
  const aui = useAui();

  const commandItems = useMemo<Unstable_TriggerItem[]>(
    () =>
      SLASH_COMMANDS.filter((c) => !c.tauriOnly || isTauri()).map((c) => ({
        id: c.id,
        type: "command",
        label: c.label,
        description: c.description,
        metadata: { icon: c.icon },
      })),
    [],
  );

  const skillItems = useMemo<Unstable_TriggerItem[]>(
    () =>
      skills.skills
        .filter((s) => s.enabled && !s.shadowed)
        .map(toSkillItem),
    [skills.skills],
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

  const onExecute = (item: Unstable_TriggerItem) => {
    if (item.type === "command") {
      SLASH_COMMANDS.find((c) => c.id === item.id)?.run();
      return;
    }
    // 技能/工具：前置引导文本（此刻触发文本已被剥离，读到的即剩余草稿）
    const insert =
      typeof item.metadata?.insert === "string" ? item.metadata.insert : null;
    if (!insert) return;
    const rest = aui.composer.getState().text.replace(/^\s+/, "");
    aui.composer.setText(insert + (rest ? `\n${rest}` : ""));
  };

  return {
    adapter,
    action: { onExecute, removeOnExecute: true },
    iconMap: ICON_MAP,
    fallbackIcon: SlashIcon,
  };
}

/** `@` 提及：子智能体清单（启用项），插芯片随消息发给模型 */
export function useSubagentMention() {
  const workspace = useWorkspace();
  const subagents = useSubagents(workspace);
  const items = useMemo<readonly Unstable_Mention[]>(
    () =>
      subagents.agents
        .filter((a) => a.enabled)
        .map((a) => ({
          id: `agent:${a.name}`,
          type: "agent",
          label: a.name,
          description: a.description,
          icon: "Bot",
        })),
    [subagents.agents],
  );
  return unstable_useMentionAdapter({
    items,
    includeModelContextTools: false,
    iconMap: { Bot: BotIcon },
    fallbackIcon: BotIcon,
  });
}
