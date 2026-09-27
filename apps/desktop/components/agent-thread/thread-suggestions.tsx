"use client";

/**
 * 新会话欢迎建议（composer 为空时显示在输入框下方）。
 *
 * 结构：分组胶囊（横向滚动）→ 点开展开该组的提示词胶囊 → 点击填入输入框，可改完再发。
 *
 * 内容不是死清单：每组维护一个更大的候选池，展示时做四层"应景"调整，
 * 全部纯前端推导（git 状态走 composer 同款的共享缓存，无额外请求）：
 * - 时段排序：分组顺序随时间段变（早上偏写代码/写作，下午偏分析，晚上偏写作/灵感）；
 * - 按日轮换：每组用"当年第几天"做种子旋转候选池，取前几条——同一天内稳定，
 *   隔天再看就是一批新的；
 * - 时段专属：个别提示词只在特定小时出现（清晨规划、傍晚日报、深夜收尾）；
 * - 仓库/工作区定制：有未提交改动或未推送提交时置顶对应建议（提示词带上具体数字）；
 *   选了 workspace 的提示词模板用「目录名」替换 {ws}，没选则退回通用措辞。
 */
import { useMemo, useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAui } from "@assistant-ui/react";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useGitStatus } from "@/lib/git/git-status";
import {
  ChartColumnIcon,
  CodeXmlIcon,
  LightbulbIcon,
  PencilLineIcon,
  PuzzleIcon,
} from "lucide-react";

type Slot = "morning" | "noon" | "afternoon" | "evening" | "night";

type SuggestionOption = {
  label: string;
  prompt: string;
  /** 选中 workspace 时替代 prompt 的模板，{ws} 替换为工作目录名；未选工作区时用 prompt */
  wsTemplate?: string;
  /** 仅在这些小时出现，[from, to) 左闭右开，跨零点写作 [22, 5] */
  hours?: [number, number];
};

type SuggestionGroup = {
  label: string;
  icon: ReactNode;
  options: SuggestionOption[];
};

/** 每组展开时最多展示的候选条数（池子里轮换取前 N 条） */
const OPTIONS_PER_GROUP = 4;

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "写代码",
    icon: <CodeXmlIcon />,
    options: [
      { label: "解释这段代码", prompt: "逐段解释当前打开文件里的核心逻辑，指出潜在问题" },
      { label: "写一个防抖函数", prompt: "用 TypeScript 写一个带立即执行选项的 debounce 函数，附使用示例" },
      { label: "审查未提交改动", prompt: "审查当前仓库未提交的改动，按严重程度列出问题和建议" },
      { label: "补单元测试", prompt: "为最近改动的模块补充单元测试，覆盖边界情况" },
      { label: "定位一个报错", prompt: "我这里有个报错（把堆栈贴到输入框），帮我定位根因并给出修复方案" },
      { label: "重构一段代码", prompt: "挑出当前打开文件里最值得重构的一段，说明理由并给出重构后的版本" },
    ],
  },
  {
    label: "插件",
    icon: <PuzzleIcon />,
    options: [
      { label: "做一个技能插件", prompt: "帮我创建一个「会议纪要整理」技能插件，生成后告诉我怎么安装" },
      { label: "看看市场里有什么", prompt: "列出已添加的插件市场和可安装的插件，推荐一个适合写代码的" },
      { label: "管理已装插件", prompt: "列出当前已安装的插件和它们的组件，指出哪些长期没用了" },
      { label: "做一个面板插件", prompt: "帮我创建一个桌面时钟面板插件，生成后告诉我怎么启用" },
    ],
  },
  {
    label: "分析",
    icon: <ChartColumnIcon />,
    options: [
      {
        label: "项目结构总览",
        prompt: "梳理当前项目的目录结构和技术栈，画出模块依赖关系",
        wsTemplate: "梳理「{ws}」的目录结构和技术栈，画出模块依赖关系",
      },
      { label: "对比技术选型", prompt: "用表格对比 React、Vue、Svelte 的优缺点和适用场景" },
      { label: "找出性能瓶颈", prompt: "分析当前项目里可能的性能瓶颈，给出排查步骤" },
      { label: "依赖健康检查", prompt: "检查项目依赖里有没有明显过时或有已知漏洞的包，给出升级建议" },
      { label: "读懂一个模块", prompt: "挑一个这个仓库里最核心的模块，讲清楚它的职责和上下游" },
    ],
  },
  {
    label: "写作",
    icon: <PencilLineIcon />,
    options: [
      { label: "写周报", prompt: "根据本周的 git 提交记录，帮我起草一份周报" },
      { label: "写发布说明", prompt: "为最近的改动写一段面向用户的发布说明" },
      { label: "写 PR 描述", prompt: "为当前改动写一份 PR 描述：改动点、动机、影响面" },
      { label: "润色一段文字", prompt: "帮我润色一段文字，更简洁有力（把原文贴到输入框里）" },
      {
        label: "规划今天",
        prompt: "把我脑子里的想法整理成今天的待办清单，按优先级排（想法贴到输入框里）",
        hours: [5, 11],
      },
      {
        label: "写今日日报",
        prompt: "根据今天的 git 提交记录，帮我起草一份今日工作日报",
        hours: [17, 22],
      },
    ],
  },
  {
    label: "灵感",
    icon: <LightbulbIcon />,
    options: [
      { label: "头脑风暴", prompt: "头脑风暴五个适合独立开发者的小工具创意，说明切入点" },
      { label: "给产品起名", prompt: "为一个 AI 编程助手产品起十个名字，每个附一句理由" },
      { label: "拆解一个产品", prompt: "选一个你熟悉的产品拆解它的核心功能设计，说说为什么这么做" },
      {
        label: "总结今天",
        prompt: "把今天的工作进展总结成三句话，方便我明天接着干",
        hours: [22, 5],
      },
    ],
  },
];

/** 时段 → 分组展示顺序：把最应景的组排前面 */
const SLOT_GROUP_ORDER: Record<Slot, string[]> = {
  morning: ["写代码", "写作", "分析", "插件", "灵感"],
  noon: ["写作", "写代码", "分析", "插件", "灵感"],
  afternoon: ["写代码", "分析", "插件", "写作", "灵感"],
  evening: ["写作", "灵感", "分析", "写代码", "插件"],
  night: ["灵感", "写作", "写代码", "分析", "插件"],
};

const slotOf = (hour: number): Slot =>
  hour >= 5 && hour < 11
    ? "morning"
    : hour >= 11 && hour < 13
      ? "noon"
      : hour >= 13 && hour < 18
        ? "afternoon"
        : hour >= 18 && hour < 22
          ? "evening"
          : "night";

const inHours = (hour: number, [from, to]: [number, number]) =>
  from < to ? hour >= from && hour < to : hour >= from || hour < to;

/** 当年第几天（1 起），与欢迎语共用同一轮换节奏 */
const dayOfYear = (now: Date) => {
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now.getTime() - start.getTime()) / 86400000);
};

const rotate = <T,>(list: T[], by: number): T[] => {
  if (list.length === 0) return list;
  const n = ((by % list.length) + list.length) % list.length;
  return [...list.slice(n), ...list.slice(0, n)];
};

type PlannedOption = { label: string; prompt: string };
type PlannedGroup = { label: string; icon: ReactNode; options: PlannedOption[] };

/** 仓库上下文快照：ready = git 可用且状态已加载；数值缺省 = 不可知（非仓库/未加载） */
type SuggestionContext = { ready: boolean; dirty: number | null; ahead: number | null };

/** 上下文置顶规则：命中即把该组内同名选项提到最前，并可用模板改写提示词 */
type ContextPin = {
  group: string;
  label: string;
  when: (ctx: SuggestionContext) => boolean;
  /** 命中时替换 prompt 的模板，可用 {dirty} {ahead} 占位 */
  promptTemplate?: string;
};

const CONTEXT_PINS: ContextPin[] = [
  {
    group: "写代码",
    label: "审查未提交改动",
    when: (c) => (c.dirty ?? 0) > 0,
    promptTemplate:
      "当前仓库有 {dirty} 个文件的未提交改动，按严重程度审查并列出问题和建议",
  },
  {
    group: "写作",
    label: "写 PR 描述",
    when: (c) => (c.ahead ?? 0) > 0,
    promptTemplate:
      "本地领先上游 {ahead} 个提交，为这些改动写一份 PR 描述：改动点、动机、影响面",
  },
];

const suggestionChipClass =
  "aui-thread-welcome-suggestion text-foreground hover:bg-muted border-border/60 h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors [&_svg]:size-4";

export const ThreadSuggestions: FC = () => {
  const aui = useAui();
  const [expandedLabel, setExpandedLabel] = useState<string | null>(null);
  const workspace = useWorkspace();
  const { status, loading: gitLoading } = useGitStatus(workspace);

  // 工作目录名（路径最后一段），注入带 {ws} 的提示词模板
  const wsName = useMemo(
    () => workspace?.split(/[\\/]+/).filter(Boolean).at(-1) ?? null,
    [workspace],
  );

  // 基本类型拆出来当 memo 依赖：状态刷新（数值变化）才重建建议，对象身份变化不算
  const gitReady = !gitLoading && !!status;
  const gitDirty = status?.dirty ?? null;
  const gitAhead = status?.ahead ?? null;

  // 挂载/依赖变化时算：时段排序 + 当日轮换 + 时段专属置顶 + 仓库/工作区定制
  const groups = useMemo<PlannedGroup[]>(() => {
    const now = new Date();
    const hour = now.getHours();
    const order = SLOT_GROUP_ORDER[slotOf(hour)];
    const seed = dayOfYear(now);
    const ctx: SuggestionContext = {
      ready: gitReady,
      dirty: gitDirty,
      ahead: gitAhead,
    };
    return [...SUGGESTION_GROUPS]
      .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
      .map((group, gi) => {
        const pool = group.options.filter(
          (o) => !o.hours || inHours(hour, o.hours),
        );
        const rotated = rotate(pool, seed + gi);
        // 命中置顶规则的保证露出（时段专属其次，其余按当日轮换截取）
        const pins = gitReady
          ? CONTEXT_PINS.filter((p) => p.group === group.label && p.when(ctx))
          : [];
        const pinByLabel = new Map(pins.map((p) => [p.label, p]));
        const pinned = rotated.filter((o) => pinByLabel.has(o.label));
        const timed = rotated.filter((o) => o.hours && !pinByLabel.has(o.label));
        const rest = rotated.filter(
          (o) => !o.hours && !pinByLabel.has(o.label),
        );
        const buildOption = (o: SuggestionOption): PlannedOption => {
          const pin = pinByLabel.get(o.label);
          const template =
            pin?.promptTemplate ??
            (o.wsTemplate && wsName ? o.wsTemplate : o.prompt);
          return {
            label: o.label,
            prompt: template
              .replaceAll("{dirty}", String(ctx.dirty ?? 0))
              .replaceAll("{ahead}", String(ctx.ahead ?? 0))
              .replaceAll("{ws}", wsName ?? ""),
          };
        };
        return {
          label: group.label,
          icon: group.icon,
          options: [...pinned, ...timed, ...rest]
            .slice(0, OPTIONS_PER_GROUP)
            .map((o) => buildOption(o)),
        };
      });
  }, [wsName, gitReady, gitDirty, gitAhead]);

  const expandedGroup = groups.find((group) => group.label === expandedLabel);

  /** 填入输入框而不直发：用户可改完再发（与排队条回填/自动化页同款 setText） */
  const fillComposer = (prompt: string) => {
    if (aui.thread.getState().isRunning) return;
    aui.composer.setText(prompt);
  };

  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col gap-2 px-4">
      <div className="w-full scrollbar-none overflow-x-auto">
        <div className="mx-auto flex w-max items-center gap-2">
          {groups.map((group) => (
            <Button
              key={group.label}
              variant="ghost"
              className={cn(
                suggestionChipClass,
                group.label === expandedLabel && "bg-muted",
              )}
              onClick={() =>
                setExpandedLabel(
                  group.label === expandedLabel ? null : group.label,
                )
              }
            >
              {group.icon}
              {group.label}
            </Button>
          ))}
        </div>
      </div>
      {expandedGroup && (
        <div
          key={expandedGroup.label}
          className="fade-in slide-in-from-top-1 animate-in w-full scrollbar-none overflow-x-auto duration-200"
        >
          <div className="mx-auto flex w-max items-center gap-2">
            {expandedGroup.options.map((option) => (
              <Button
                key={option.label}
                variant="ghost"
                className={suggestionChipClass}
                onClick={() => fillComposer(option.prompt)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
