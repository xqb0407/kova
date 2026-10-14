import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import {
  BookOpenIcon,
  BotIcon,
  CameraIcon,
  ChevronDownIcon,
  CircleQuestionMarkIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  DatabaseIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  LogOutIcon,
  MonitorIcon,
  MousePointerClickIcon,
  PaletteIcon,
  PencilLineIcon,
  PuzzleIcon,
  SearchCheckIcon,
  SearchIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TargetIcon,
  WrenchIcon,
} from "lucide-react-native";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react-native";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { monoStyle } from "./surfaces";
import { ToolFallback } from "./tool-fallback";

/**
 * 移动端工具行：对齐桌面端 tool-row.aui.tsx 的扁平行语言。
 *
 * 一行 = [图标|running 转圈] 中文标签 主文本 次文本 ±统计 失败红点 展开箭头；
 * 点行展开原始输出（桌面端展开走右侧面板，手机没面板，就地折叠展开是唯一出口）。
 *
 * 与桌面的差异是刻意的：
 * - 没有 AgentPanel：read/Task 等「整行开面板」在这里退化为普通展开行；
 * - 审批决策面唯一在 composer 上方的审批卡（pi-interactions 台账，桌面同构）：
 *   流内不渲染第二套批准按钮，待批的注册工具按运行中转圈，未知工具回退
 *   ToolFallback（中性行 + 已决回执）；
 * - todo 不隐藏：桌面把 todo 折进独立任务卡所以藏行，移动端任务卡未接线，
 *   藏了就等于丢了信息，先按普通行渲染；
 * - 未知工具兜底 ToolFallback（与桌面 AGENT_TOOL_UI 未注册即回退同构）。
 */

type Args = Record<string, unknown>;

const strArg = (args: unknown, key: string): string => {
  const v = (args as Args | undefined)?.[key];
  return typeof v === "string" ? v : "";
};

/** 结果 → 展示文本：字符串原样；{error} 信封剥原文（失败行不渲染成 JSON 转储）；其余格式化 */
function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && "error" in result) {
    return String((result as { error: unknown }).error);
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** 与桌面 tool-row 同款：bash 输出里的失败标记（退出码/超时） */
const FAILED_RE = /\[exit code: |\[timeout\]/;

/** 交互面在别处、消息流里不渲染的工具（对齐桌面 HIDDEN_TOOL_NAMES）：
 *  todo 的进度收敛在输入条上方的「计划」药丸 + 底部抽屉（components/ui/plan-bar），
 *  逐条工具行只是同一份清单的重复噪音。 */
const HIDDEN_TOOL_NAMES = new Set(["todo"]);

const splitPath = (path: string): { dir: string; base: string } => {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", base: norm };
  return { dir: norm.slice(0, i) || "/", base: norm.slice(i + 1) };
};

/** 命令首行 + 多行角标：`…+N` 与桌面同款（首行外还剩几行） */
function firstLine(text: string): { line: string; extra: number } {
  const lines = text.split("\n");
  return { line: lines[0] ?? "", extra: Math.max(0, lines.length - 1) };
}

/** 数字参数（browser_resize 的 width/height 是 number，strArg 只吃字符串） */
const numArg = (args: unknown, key: string): number | undefined => {
  const v = (args as Args | undefined)?.[key];
  return typeof v === "number" ? v : undefined;
};

/** 数组参数取字符串项（TaskWait 的 delegationIds） */
const arrArg = (args: unknown, key: string): string[] => {
  const v = (args as Args | undefined)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** Question 工具首题标题（行摘要用；questions[0].title） */
function firstQuestionTitle(args: unknown): string | undefined {
  const questions = (args as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return undefined;
  const first = questions[0] as { title?: unknown } | undefined;
  return typeof first?.title === "string" && first.title ? first.title : undefined;
}

/** 朴素行差集（公共前后缀裁剪）：edit 行的 ±N 统计，够展示用不必上 diff 库 */
function lineStats(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) {
    e += 1;
  }
  return { added: b.length - s - e, removed: a.length - s - e };
}

type RowSpec = {
  label: string;
  icon: ReactNode;
  primary?: string;
  secondary?: string;
  /** primary 走等宽（命令/URL） */
  mono?: boolean;
  stats?: { added: number; removed: number };
  /** 展开区顶部的完整命令行（bash） */
  header?: string;
};

/** toolName → 行规格；null = 未注册，交回 ToolFallback（桌面 AGENT_TOOL_UI 同构） */
function specFor(toolName: string, args: unknown): RowSpec | null {
  const s = (key: string) => strArg(args, key);
  switch (toolName) {
    case "bash": {
      const cmd = s("command");
      const { line, extra } = firstLine(cmd);
      return {
        label: "终端",
        icon: <Icon as={SquareTerminalIcon} className="text-muted-foreground size-4" />,
        primary: extra > 0 ? `${line} …+${extra}` : line,
        mono: true,
        header: cmd,
      };
    }
    case "read": {
      const { dir, base } = splitPath(s("file_path"));
      return {
        label: "查看",
        icon: <Icon as={SearchIcon} className="text-muted-foreground size-4" />,
        primary: base,
        secondary: dir,
      };
    }
    case "edit": {
      const { dir, base } = splitPath(s("file_path"));
      return {
        label: "编辑",
        icon: <Icon as={PencilLineIcon} className="text-muted-foreground size-4" />,
        primary: base,
        secondary: dir,
        stats: lineStats(s("old_string"), s("new_string")),
      };
    }
    case "write": {
      const { dir, base } = splitPath(s("file_path"));
      const content = s("content");
      return {
        label: "写入",
        icon: <Icon as={PencilLineIcon} className="text-muted-foreground size-4" />,
        primary: base,
        secondary: dir,
        stats: content ? { added: content.split("\n").length, removed: 0 } : undefined,
      };
    }
    case "glob":
    case "grep":
      return {
        label: toolName === "glob" ? "文件检索" : "内容检索",
        icon: <Icon as={SearchIcon} className="text-muted-foreground size-4" />,
        primary: s("pattern"),
        secondary: [s("path"), s("include")].filter(Boolean).join(" · "),
      };
    case "WebSearch":
      return {
        label: "网络搜索",
        icon: <Icon as={SearchIcon} className="text-muted-foreground size-4" />,
        primary: s("query"),
      };
    case "WebFetch":
      return {
        label: "抓取网页",
        icon: <Icon as={GlobeIcon} className="text-muted-foreground size-4" />,
        primary: s("url"),
        mono: true,
      };
    case "Task":
      return {
        label: "子智能体",
        icon: <Icon as={BotIcon} className="text-muted-foreground size-4" />,
        primary: s("subagent_type") || s("agent"),
        secondary: s("description"),
      };
    case "use_skill":
      return {
        label: "调用技能",
        icon: <Icon as={BookOpenIcon} className="text-muted-foreground size-4" />,
        primary: s("name") || s("skill"),
      };
    case "memory_write":
      return {
        label: "记忆写入",
        icon: <Icon as={PencilLineIcon} className="text-muted-foreground size-4" />,
        primary: s("file") || "MEMORY.md",
        secondary: s("scope"),
      };
    case "memory_read":
      return {
        label: "记忆读取",
        icon: <Icon as={DatabaseIcon} className="text-muted-foreground size-4" />,
        primary: s("file") || "文件列表",
        secondary: s("scope"),
      };
    case "memory_search":
      return {
        label: "记忆检索",
        icon: <Icon as={SearchCheckIcon} className="text-muted-foreground size-4" />,
        primary: s("query"),
      };
    case "plan_enter":
      return {
        label: "进入计划模式",
        icon: <Icon as={ClipboardListIcon} className="text-muted-foreground size-4" />,
      };
    case "plan_write":
      return {
        label: "写计划",
        icon: <Icon as={ClipboardCheckIcon} className="text-muted-foreground size-4" />,
        primary: s("title"),
      };
    case "plan_exit":
      return {
        label: "申请批准计划",
        icon: <Icon as={LogOutIcon} className="text-muted-foreground size-4" />,
        primary: s("rationale"),
      };
    case "generate_image":
      return {
        label: "生成图片",
        icon: <Icon as={SparklesIcon} className="text-muted-foreground size-4" />,
        primary: s("prompt") ? firstLine(s("prompt")).line : undefined,
      };
    // —— 浏览器驱动（sidecar browser-tools）：与桌面同为扁平行，
    //    桌面无专属 UI（走 ToolFallback 裸名），这里补中文标签 ——
    case "browser_navigate":
      return {
        label: "浏览器导航",
        icon: <Icon as={MonitorIcon} className="text-muted-foreground size-4" />,
        primary: s("url"),
        mono: true,
      };
    case "browser_snapshot":
      return {
        label: "页面快照",
        icon: <Icon as={MonitorIcon} className="text-muted-foreground size-4" />,
      };
    case "browser_resize": {
      const w = numArg(args, "width");
      const h = numArg(args, "height");
      return {
        label: "调整视口",
        icon: <Icon as={MonitorIcon} className="text-muted-foreground size-4" />,
        primary: w != null && h != null ? `${w} × ${h}` : undefined,
      };
    }
    case "browser_click":
      return {
        label: "点击元素",
        icon: <Icon as={MousePointerClickIcon} className="text-muted-foreground size-4" />,
        primary: s("ref"),
        mono: true,
      };
    case "browser_type":
      return {
        label: "输入文本",
        icon: <Icon as={MousePointerClickIcon} className="text-muted-foreground size-4" />,
        primary: s("text") ? firstLine(s("text")).line : undefined,
      };
    case "browser_scroll":
      return {
        label: "滚动页面",
        icon: <Icon as={MonitorIcon} className="text-muted-foreground size-4" />,
        primary: s("direction") || undefined,
      };
    case "browser_back":
      return {
        label: "浏览器后退",
        icon: <Icon as={MonitorIcon} className="text-muted-foreground size-4" />,
      };
    case "browser_shot":
      return {
        label: "页面截图",
        icon: <Icon as={CameraIcon} className="text-muted-foreground size-4" />,
        primary: s("url") || undefined,
        mono: true,
      };
    case "screenshot":
      return {
        label: "屏幕截图",
        icon: <Icon as={CameraIcon} className="text-muted-foreground size-4" />,
      };
    case "echo_image":
      return {
        label: "图片回显",
        icon: <Icon as={ImageIcon} className="text-muted-foreground size-4" />,
      };
    // —— 后台任务（bash runInBackground 的配套工具）——
    case "task_output":
    case "taskOutput":
      return {
        label: "后台任务输出",
        icon: <Icon as={SquareTerminalIcon} className="text-muted-foreground size-4" />,
        primary: s("taskId") || s("id"),
        mono: true,
      };
    case "task_stop":
      return {
        label: "停止后台任务",
        icon: <Icon as={SquareTerminalIcon} className="text-muted-foreground size-4" />,
        primary: s("taskId") || s("id"),
        mono: true,
      };
    // —— 子代理组（desktop 同走 ToolFallback 裸名，这里补中文）——
    case "TaskWait": {
      const ids = arrArg(args, "delegationIds");
      return {
        label: "等待子智能体",
        icon: <Icon as={BotIcon} className="text-muted-foreground size-4" />,
        primary: ids.length ? ids.join(", ") : "全部",
        mono: true,
      };
    }
    case "TaskList":
      return {
        label: "子智能体列表",
        icon: <Icon as={BotIcon} className="text-muted-foreground size-4" />,
      };
    case "TaskStop":
      return {
        label: "停止子智能体",
        icon: <Icon as={BotIcon} className="text-muted-foreground size-4" />,
        primary: s("id") || s("delegationId"),
        mono: true,
      };
    // —— 其他内置工具 ——
    case "open_file":
      return {
        label: "打开文件",
        icon: <Icon as={FileTextIcon} className="text-muted-foreground size-4" />,
        primary: s("path"),
        mono: true,
      };
    case "open_plugin_panel":
      return {
        label: "打开插件面板",
        icon: <Icon as={PuzzleIcon} className="text-muted-foreground size-4" />,
        primary: s("plugin") || s("panel"),
      };
    case "use_design_theme":
      return {
        label: "加载设计主题",
        icon: <Icon as={PaletteIcon} className="text-muted-foreground size-4" />,
        primary: s("name") || "当前主题",
      };
    case "ask_needs_work":
      return {
        label: "建议切工作模式",
        icon: <Icon as={SparklesIcon} className="text-muted-foreground size-4" />,
        primary: s("reason") || undefined,
      };
    case "mcp":
      return {
        label: "MCP 调用",
        icon: <Icon as={WrenchIcon} className="text-muted-foreground size-4" />,
        primary: s("query") || s("tool") || s("action"),
        mono: true,
      };
    case "Question":
      return {
        label: "提问",
        icon: <Icon as={CircleQuestionMarkIcon} className="text-muted-foreground size-4" />,
        primary: firstQuestionTitle(args),
      };
    // —— 目标模式出口（desktop 同为裸名，这里补中文）——
    case "goal_complete":
      return {
        label: "完成目标",
        icon: <Icon as={TargetIcon} className="text-muted-foreground size-4" />,
        primary: s("summary") || undefined,
      };
    case "goal_blocked":
      return {
        label: "目标受阻",
        icon: <Icon as={TargetIcon} className="text-muted-foreground size-4" />,
        primary: s("reason") || undefined,
      };
    // —— 管理面（子代理/技能/插件/主题定义写）——
    case "subagents_list":
    case "subagents_save":
    case "subagents_delete":
      return {
        label: "子智能体定义",
        icon: <Icon as={BotIcon} className="text-muted-foreground size-4" />,
        primary: s("name") || undefined,
      };
    case "skills_list":
    case "skills_save":
    case "skills_delete":
      return {
        label: "技能定义",
        icon: <Icon as={BookOpenIcon} className="text-muted-foreground size-4" />,
        primary: s("name") || undefined,
      };
    case "plugins_list":
    case "plugins_install":
    case "plugins_scaffold":
      return {
        label: "插件管理",
        icon: <Icon as={PuzzleIcon} className="text-muted-foreground size-4" />,
        primary: s("name") || s("id") || undefined,
      };
    case "design_themes_list":
    case "design_theme_save":
    case "design_theme_delete":
      return {
        label: "设计主题管理",
        icon: <Icon as={PaletteIcon} className="text-muted-foreground size-4" />,
        primary: s("name") || s("id") || undefined,
      };
    // —— 历史兼容：旧模式工具（已退役，历史转录里仍有）——
    case "SubmitPlan":
      return {
        label: "计划",
        icon: <Icon as={ClipboardListIcon} className="text-muted-foreground size-4" />,
        primary: s("title") || undefined,
      };
    case "SubmitGoal":
      return {
        label: "目标",
        icon: <Icon as={TargetIcon} className="text-muted-foreground size-4" />,
        primary: s("title") || undefined,
      };
    default:
      return null;
  }
}

export const ToolCallRow: ToolCallMessagePartComponent = (props) => {
  const { toolName, args, status, result, isError } = props;

  // hooks 一律走在早退之前：part 会从 requires-action（转交 ToolFallback）翻回
  // 完成态，早退之后再挂 hook 就是 React #310「渲染间 hook 数变了」。
  // 桌面端 tool-row 同款注释，这里同规。
  const [open, setOpen] = useState(false);
  const spec = useMemo(() => specFor(toolName, args), [toolName, args]);
  // 折叠时不做 JSON.stringify：大结果（读文件/长终端输出）每行每次渲染都全量
  // 格式化一遍，进一个工具调用密集的会话，首屏就是肉眼可见的卡。
  // 展开或失败态才要全文；字符串结果直取本体（正则判失败要用它，零成本）。
  const output = useMemo(
    () => (open || isError ? resultText(result) : typeof result === "string" ? result : ""),
    [open, isError, result],
  );

  // 交互面在别处、消息流里不再渲染的工具（对齐桌面 HIDDEN_TOOL_NAMES）：
  // todo 的进度收敛到输入条上方的「计划」药丸 → 底部抽屉（plan-bar），
  // 逐条工具行只是同一份清单的重复噪音。检查放在 spec 回退之前：这些工具
  // 即便没有专属规格也不该掉进 ToolFallback。
  if (HIDDEN_TOOL_NAMES.has(toolName)) return null;

  // 决策面唯一在 composer 上方的审批卡（pi-interactions 台账，桌面同构）：带
  // 审批 / requires-action 的注册工具照常走扁平行（待批时按运行中转圈），未知
  // 工具才回退 ToolFallback（中性行 + 已决回执，流内不再有第二套批准按钮）
  if (spec === null) {
    return <ToolFallback {...props} />;
  }

  const running =
    status.type === "running" || status.type === "requires-action";
  const hasResult =
    result != null && (typeof result === "string" ? result !== "" : true);
  const failed =
    isError === true ||
    (status.type === "incomplete" &&
      (status.error != null || FAILED_RE.test(output)));
  const expandable = running || hasResult || spec.header != null;

  const row = (
    <View className="flex-row items-center gap-2 py-2">
      {running ? (
        <ActivityIndicator size="small" />
      ) : (
        spec.icon
      )}
      <Text className="text-muted-foreground shrink-0 text-[13px]">{spec.label}</Text>
      {spec.primary ? (
        <Text
          numberOfLines={1}
          className={cn("text-foreground min-w-0 flex-1 text-[13px]", spec.mono && "text-[12.5px]")}
          style={spec.mono ? monoStyle : undefined}
        >
          {spec.primary}
        </Text>
      ) : (
        <View className="min-w-0 flex-1" />
      )}
      {spec.secondary ? (
        <Text
          numberOfLines={1}
          className="text-muted-foreground max-w-[40%] shrink-0 text-[12px] opacity-60"
        >
          {spec.secondary}
        </Text>
      ) : null}
      {spec.stats && (spec.stats.added > 0 || spec.stats.removed > 0) ? (
        <View className="flex-row">
          {spec.stats.added > 0 ? (
            <Text className="text-[12px] text-emerald-500" style={monoStyle}>
              +{spec.stats.added}
            </Text>
          ) : null}
          {spec.stats.removed > 0 ? (
            <Text className="ml-1 text-[12px] text-rose-500" style={monoStyle}>
              −{spec.stats.removed}
            </Text>
          ) : null}
        </View>
      ) : null}
      {failed ? (
        <View className="bg-destructive size-1.5 shrink-0 rounded-full" />
      ) : null}
      {expandable ? (
        <Icon
          as={ChevronDownIcon}
          className={cn(
            "text-muted-foreground size-4 shrink-0",
            !open && "-rotate-90",
          )}
        />
      ) : null}
    </View>
  );

  return (
    <View className="aui-tool-row my-0.5">
      {expandable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${spec.label}${spec.primary ? ` ${spec.primary}` : ""}，${open ? "收起" : "展开"}输出`}
          onPress={() => setOpen((v) => !v)}
        >
          {row}
        </Pressable>
      ) : (
        row
      )}
      {open ? (
        <View className="bg-foreground/5 mb-2 rounded-xl px-3 py-2.5">
          {spec.header ? (
            <Text className="mb-1.5 text-[12px] font-semibold text-emerald-500" style={monoStyle}>
              {`$ ${spec.header}`}
            </Text>
          ) : null}
          {output ? (
            <ScrollView style={{ maxHeight: 180 }} nestedScrollEnabled>
              <Text
                className={cn("text-[12px] leading-4", failed ? "text-destructive" : "text-muted-foreground")}
                style={monoStyle}
              >
                {output}
              </Text>
            </ScrollView>
          ) : running ? (
            <Text className="text-muted-foreground text-[12px]">执行中…</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};
