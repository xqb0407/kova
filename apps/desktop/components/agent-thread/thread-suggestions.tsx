"use client";

/**
 * 新会话欢迎建议（composer 为空时显示在输入框下方）。
 *
 * 结构：分组胶囊（横向滚动）→ 展开该组的案例卡片（示意图 + 标题 + 一句说明）
 * → 点击把完整提示词填入输入框，可改完再发。默认展开当前模式的主场组，
 * 切档即换一批案例卡。
 *
 * 显示时机：新对话页**始终显示**（填入提示词后也在）——它是"我还能做什么"的
 * 入口，不随输入框内容起落；离开新对话页（已开聊）整块欢迎区本来就退场。
 *
 * 内容不是死清单：每组维护一个更大的候选池，展示时做五层"应景"调整，
 * 全部纯前端推导（git 状态走 composer 同款的共享缓存，无额外请求）：
 * - 应用模式筛选：跟着新对话页顶部的「编码/工作/设计」切换——模式专属的组
 *   （办公 / 设计）只在对应档出现，「写代码」只在编码档；条目也能按模式限定
 *   （「整理会议纪要」只给工作档）。切档即换一批，主场组排最前。
 * - 时段排序：分组顺序随时间段变（早上偏写代码/写作，下午偏分析，晚上偏写作/灵感）；
 * - 按日轮换：每组用"当年第几天"做种子旋转候选池，取前几条——同一天内稳定，
 *   隔天再看就是一批新的；
 * - 时段专属：个别提示词只在特定小时出现（清晨规划、傍晚日报、深夜收尾）；
 * - 仓库/工作区定制：有未提交改动或未推送提交时置顶对应建议（提示词带上具体数字）；
 *   选了 workspace 的提示词模板用「目录名」替换 {ws}，没选则退回通用措辞。
 *   这一层是编码档专属——工作/设计档隐藏 Git，不该被 git 建议占位。
 */
import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useGitStatus } from "@/lib/git/git-status";
import { useThreadAppMode } from "@/lib/pi/pi-session-app-mode";
import type { AppMode } from "@/lib/pi/app-mode";
import { SuggestionArtwork, type SuggestionArt } from "./suggestion-art";
import {
  BriefcaseIcon,
  ChartColumnIcon,
  CodeXmlIcon,
  LightbulbIcon,
  PaletteIcon,
  PencilLineIcon,
  PuzzleIcon,
} from "lucide-react";

type Slot = "morning" | "noon" | "afternoon" | "evening" | "night";

type SuggestionOption = {
  label: string;
  /** 卡片上的一句话说明（提示词是"填进去什么"，hint 是"点了会发生什么"） */
  hint: string;
  /** 卡片示意图（见 suggestion-art） */
  art: SuggestionArt;
  prompt: string;
  /** 选中 workspace 时替代 prompt 的模板，{ws} 替换为工作目录名；未选工作区时用 prompt */
  wsTemplate?: string;
  /** 仅在这些小时出现，[from, to) 左闭右开，跨零点写作 [22, 5] */
  hours?: [number, number];
  /** 只在这些模式下出现；不写 = 各档都显示 */
  modes?: AppMode[];
};

type SuggestionGroup = {
  label: string;
  icon: ReactNode;
  /** 只在这些模式下出现的整组；不写 = 各档都显示 */
  modes?: AppMode[];
  options: SuggestionOption[];
};

/** 每组展开时最多展示的候选条数（池子里轮换取前 N 条） */
const OPTIONS_PER_GROUP = 5;

/** 各组候选池。条目按模式标注：不标 = 各档通用；标了 = 只在对应档出现 */

/**
 * 每个分类的主色：图标、选中胶囊、缩略图底色三处共用。
 *
 * 应用本体是单色的（primary 近黑），整块推荐区如果也全灰就"看着素"——
 * 颜色只落在这三处，给的是"分类可辨"而不是彩色贴纸：图标带色、选中态染一点底、
 * 缩略图底色跟着分类走（图本身的语法色再由 art 自己带）。
 */
const GROUP_ACCENT: Record<
  string,
  { icon: string; chipActive: string; tile: string }
> = {
  写代码: {
    icon: "text-sky-600 dark:text-sky-400",
    chipActive: "bg-sky-500/12 border-sky-500/30 dark:bg-sky-400/15",
    tile: "bg-sky-500/8 dark:bg-sky-400/10",
  },
  办公: {
    icon: "text-teal-600 dark:text-teal-400",
    chipActive: "bg-teal-500/12 border-teal-500/30 dark:bg-teal-400/15",
    tile: "bg-teal-500/8 dark:bg-teal-400/10",
  },
  设计: {
    icon: "text-violet-600 dark:text-violet-400",
    chipActive: "bg-violet-500/12 border-violet-500/30 dark:bg-violet-400/15",
    tile: "bg-violet-500/8 dark:bg-violet-400/10",
  },
  插件: {
    icon: "text-emerald-600 dark:text-emerald-400",
    chipActive: "bg-emerald-500/12 border-emerald-500/30 dark:bg-emerald-400/15",
    tile: "bg-emerald-500/8 dark:bg-emerald-400/10",
  },
  分析: {
    icon: "text-indigo-600 dark:text-indigo-400",
    chipActive: "bg-indigo-500/12 border-indigo-500/30 dark:bg-indigo-400/15",
    tile: "bg-indigo-500/8 dark:bg-indigo-400/10",
  },
  写作: {
    icon: "text-rose-600 dark:text-rose-400",
    chipActive: "bg-rose-500/12 border-rose-500/30 dark:bg-rose-400/15",
    tile: "bg-rose-500/8 dark:bg-rose-400/10",
  },
  灵感: {
    icon: "text-amber-600 dark:text-amber-400",
    chipActive: "bg-amber-500/12 border-amber-500/30 dark:bg-amber-400/15",
    tile: "bg-amber-500/8 dark:bg-amber-400/10",
  },
};

/** 取不到就退回中性灰（分类增删时不会开天窗） */
const NEUTRAL_ACCENT = {
  icon: "text-muted-foreground",
  chipActive: "bg-muted",
  tile: "bg-muted/40",
};

const accentOf = (label: string) => GROUP_ACCENT[label] ?? NEUTRAL_ACCENT;

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "写代码",
    icon: <CodeXmlIcon />,
    modes: ["code"],
    options: [
      { label: "解释这段代码", hint: "逐段讲核心逻辑，挑出问题", art: "editor", prompt: "逐段解释当前打开文件里的核心逻辑，指出潜在问题" },
      { label: "写一个防抖函数", hint: "带立即执行选项，附用例", art: "editor", prompt: "用 TypeScript 写一个带立即执行选项的 debounce 函数，附使用示例" },
      { label: "审查未提交改动", hint: "按严重程度列出问题", art: "diff", prompt: "审查当前仓库未提交的改动，按严重程度列出问题和建议" },
      { label: "补单元测试", hint: "覆盖边界情况", art: "tests", prompt: "为最近改动的模块补充单元测试，覆盖边界情况" },
      { label: "定位一个报错", hint: "从堆栈找根因、给修法", art: "bug", prompt: "我这里有个报错（把堆栈贴到输入框），帮我定位根因并给出修复方案" },
      { label: "重构一段代码", hint: "挑最值得改的一段，讲理由", art: "editor", prompt: "挑出当前打开文件里最值得重构的一段，说明理由并给出重构后的版本" },
      { label: "设计一个接口", hint: "入参返回错误码 + 示例", art: "api", prompt: "为这个功能设计一套接口：入参、返回、错误码，附调用示例" },
      { label: "写一段 SQL", hint: "你说表结构，它出查询", art: "sheet", prompt: "帮我写一条 SQL 查询（表结构和要查什么我写在输入框里）" },
      { label: "写个小脚本", hint: "批量整理文件之类的小工具", art: "editor", prompt: "写一个整理当前目录文件的小脚本，先讲思路再给完整代码" },
    ],
  },
  {
    label: "办公",
    icon: <BriefcaseIcon />,
    modes: ["work"],
    options: [
      { label: "整理待办", hint: "排好优先级，可直接勾", art: "tests", prompt: "把这段零散待办整理成按优先级排序的清单（内容贴输入框）" },
      { label: "整理会议纪要", hint: "结论、待办、负责人", art: "doc", prompt: "把这段会议记录整理成结构化纪要：结论、待办、负责人（记录贴输入框）" },
      { label: "起草一封邮件", hint: "专业但不生硬", art: "mail", prompt: "帮我起草一封邮件，语气专业但不生硬（要点我写进输入框）" },
      { label: "汇总成表格", hint: "把文字整理成行列", art: "sheet", prompt: "把这段文字里的信息整理成表格，列名你定（内容贴输入框）" },
      { label: "写成可交接的 SOP", hint: "别人照着就能做", art: "steps", prompt: "把这件事的流程写成一份别人照着就能做的 SOP 步骤" },
      { label: "翻译成英文", hint: "地道的商务表达", art: "doc", prompt: "把下面这段翻译成地道的英文商务表达（原文贴输入框）" },
      { label: "提炼要点", hint: "长文变十条要点", art: "doc", prompt: "把这份长文档提炼成十条要点，按重要性排序（文档贴输入框）" },
    ],
  },
  {
    label: "设计",
    icon: <PaletteIcon />,
    modes: ["design"],
    options: [
      { label: "出一个页面原型", hint: "结构、版式、配色都给", art: "ui", prompt: "帮我做一个落地页原型：结构、版式、配色都要（产品我简单说一下）" },
      { label: "配一套颜色", hint: "主辅中性色，深浅两版", art: "palette", prompt: "为这个产品出一套配色：主色/辅助色/中性色，含深浅两版" },
      { label: "按截图还原页面", hint: "尽量贴近原图", art: "ui", prompt: "把这张截图还原成可用页面，尽量接近（截图我贴在输入框里）" },
      { label: "定一套组件规范", hint: "按钮输入框的状态与间距", art: "ui", prompt: "为这个产品定义组件规范：按钮/输入框/卡片的状态、间距与圆角" },
      { label: "想几个 Logo 方向", hint: "各附含义与适用场景", art: "palette", prompt: "为这个产品想几版 Logo 方向，说明各自的含义和适用场景" },
      { label: "挑界面的毛病", hint: "指出可用性问题与改法", art: "ui", prompt: "把界面截图发我，指出可用性问题并给出具体改法" },
      { label: "做一版信息架构", hint: "页面清单、层级与导航", art: "ui", prompt: "为这个产品梳理信息架构：页面清单、层级与导航关系" },
    ],
  },
  {
    label: "插件",
    icon: <PuzzleIcon />,
    options: [
      { label: "做一个技能插件", hint: "从零生成，并告诉你在哪装", art: "plugin", prompt: "帮我创建一个「会议纪要整理」技能插件，生成后告诉我怎么安装" },
      { label: "看看市场里有什么", hint: "已加市场与可装插件", art: "plugin", prompt: "列出已添加的插件市场和可安装的插件，推荐一个适合我手头工作的" },
      { label: "管理已装插件", hint: "列组件，指出长期没用的", art: "plugin", prompt: "列出当前已安装的插件和它们的组件，指出哪些长期没用了" },
      { label: "做一个面板插件", hint: "生成后告诉你怎么启用", art: "plugin", prompt: "帮我创建一个桌面时钟面板插件，生成后告诉我怎么启用" },
      { label: "把流程做成技能", hint: "把常做的流程固化下来", art: "plugin", prompt: "帮我把「每周整理待办和进展」这套流程做成技能插件，告诉我在哪装" },
      { label: "插件能给我什么", hint: "组件与工具能用在哪", art: "plugin", prompt: "列出当前插件提供的组件与工具，说说哪些能用在我现在做的事上" },
    ],
  },
  {
    label: "分析",
    icon: <ChartColumnIcon />,
    options: [
      { label: "项目结构总览", hint: "目录、技术栈、模块依赖", art: "chart", prompt: "梳理当前项目的目录结构和技术栈，画出模块依赖关系", wsTemplate: "梳理「{ws}」的目录结构和技术栈，画出模块依赖关系", modes: ["code"] },
      { label: "对比技术选型", hint: "表格对比优缺点与场景", art: "chart", prompt: "用表格对比 React、Vue、Svelte 的优缺点和适用场景", modes: ["code"] },
      { label: "找出性能瓶颈", hint: "给出排查步骤", art: "chart", prompt: "分析当前项目里可能的性能瓶颈，给出排查步骤", modes: ["code"] },
      { label: "依赖健康检查", hint: "过时与已知漏洞", art: "chart", prompt: "检查项目依赖里有没有明显过时或有已知漏洞的包，给出升级建议", modes: ["code"] },
      { label: "读懂一个模块", hint: "职责与上下游", art: "editor", prompt: "挑一个这个仓库里最核心的模块，讲清楚它的职责和上下游", modes: ["code"] },
      { label: "算一笔数", hint: "合计与占比，挑异常", art: "sheet", prompt: "帮我核算这份数据的合计与占比，指出异常项（数据贴输入框）", modes: ["work"] },
      { label: "两版方案对比", hint: "成本、风险、工期", art: "chart", prompt: "对比这两版方案的差异：成本、风险、工期各差在哪（内容贴输入框）", modes: ["work"] },
      { label: "找出漏掉的点", hint: "遗漏与风险按严重度排", art: "chart", prompt: "看下这份方案有没有明显的遗漏或风险，按严重程度排（方案贴输入框）", modes: ["work"] },
      { label: "竞品在怎么做", hint: "三个同类产品的取舍", art: "chart", prompt: "挑三个同类产品，说说它们在这一点上的做法和取舍", modes: ["design"] },
      { label: "拆解一个界面", hint: "信息层级与交互路径", art: "ui", prompt: "拆解一个熟悉产品的界面设计：信息层级、交互路径、为什么不那么做", modes: ["design"] },
    ],
  },
  {
    label: "写作",
    icon: <PencilLineIcon />,
    options: [
      { label: "写周报", hint: "从本周提交起草", art: "doc", prompt: "根据本周的 git 提交记录，帮我起草一份周报" },
      { label: "写发布说明", hint: "面向用户的一段说明", art: "doc", prompt: "为最近的改动写一段面向用户的发布说明" },
      { label: "写 PR 描述", hint: "改动点、动机、影响面", art: "diff", prompt: "为当前改动写一份 PR 描述：改动点、动机、影响面", modes: ["code"] },
      { label: "润色一段文字", hint: "更简洁有力", art: "doc", prompt: "帮我润色一段文字，更简洁有力（把原文贴到输入框里）" },
      { label: "写人话版更新说明", hint: "面向非技术同事", art: "doc", prompt: "把这次改动写成人话版的更新说明，面向非技术同事", modes: ["work"] },
      { label: "规划今天", hint: "想法整理成待办清单", art: "tests", prompt: "把我脑子里的想法整理成今天的待办清单，按优先级排（想法贴到输入框里）", hours: [5, 11] },
      { label: "写今日日报", hint: "从今天的提交起草", art: "doc", prompt: "根据今天的 git 提交记录，帮我起草一份今日工作日报", hours: [17, 22], modes: ["code"] },
      { label: "写今日进度", hint: "做完与没做完的进度说明", art: "doc", prompt: "把我今天做完和没做完的事整理成一段进度说明（素材贴输入框）", hours: [17, 22], modes: ["work"] },
    ],
  },
  {
    label: "灵感",
    icon: <LightbulbIcon />,
    options: [
      { label: "头脑风暴", hint: "五个小工具创意与切入点", art: "idea", prompt: "头脑风暴五个适合独立开发者的小工具创意，说明切入点" },
      { label: "给产品起名", hint: "十个名字各附理由", art: "idea", prompt: "为一个 AI 编程助手产品起十个名字，每个附一句理由" },
      { label: "拆解一个产品", hint: "核心功能设计与取舍", art: "idea", prompt: "选一个你熟悉的产品拆解它的核心功能设计，说说为什么这么做" },
      { label: "换个思路", hint: "卡住了，给三条新路", art: "idea", prompt: "我现在卡在「（把卡点写进输入框）」，给我三个完全不同的思路" },
      { label: "找几个小切入点", hint: "今天就能动手的三件", art: "idea", prompt: "围绕我现在在做的事，给三个今天就能动手的小切入点" },
      { label: "总结今天", hint: "进展收成三句话", art: "idea", prompt: "把今天的工作进展总结成三句话，方便我明天接着干", hours: [22, 5] },
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

/** 模式的主场组：切到哪一档，哪一档的内容排最前 */
const MODE_PRIMARY_GROUPS: Record<AppMode, string[]> = {
  code: ["写代码"],
  work: ["办公"],
  design: ["设计"],
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

/** 条目 / 组是否属于当前模式（不标 modes = 通用） */
const fitsMode = (modes: AppMode[] | undefined, mode: AppMode) =>
  !modes || modes.includes(mode);

type PlannedOption = {
  label: string;
  hint: string;
  art: SuggestionArt;
  prompt: string;
};
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

/** 置顶规则都是 git 相关，只在编码档生效——工作/设计档隐藏 Git，不该被它占位 */
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

/**
 * 从候选池算出这一次要展示的分组与条目（纯函数：时钟、工作区、git、模式都由
 * 调用方喂进来，便于单测——欢迎页要 AuiProvider，测试里跑不起来）。
 *
 * 五层调整的落点：模式筛选（组与条目）→ 模式主场组排最前 → 时段排序 →
 * 仓库/工作区置顶 → 当日轮换截取。
 */
export function planSuggestions(input: {
  appMode: AppMode;
  now: Date;
  wsName: string | null;
  gitReady: boolean;
  gitDirty: number | null;
  gitAhead: number | null;
}): PlannedGroup[] {
  const { appMode, now, wsName, gitReady, gitDirty, gitAhead } = input;
  const hour = now.getHours();
  // 模式的主场组排最前，其余按时段顺序；两张表都没有的组落到最后
  //（Array.sort 稳定，保持它们在声明处的相对次序）
  const order = [...MODE_PRIMARY_GROUPS[appMode], ...SLOT_GROUP_ORDER[slotOf(hour)]];
  const rankOf = (label: string) => {
    const index = order.indexOf(label);
    return index === -1 ? order.length : index;
  };
  const seed = dayOfYear(now);
  const ctx: SuggestionContext = {
    // 置顶规则（git）只在编码档参与
    ready: gitReady && appMode === "code",
    dirty: gitDirty,
    ahead: gitAhead,
  };
  return SUGGESTION_GROUPS.filter((group) => fitsMode(group.modes, appMode))
    .sort((a, b) => rankOf(a.label) - rankOf(b.label))
    .map((group, gi) => {
      const pool = group.options.filter(
        (o) => fitsMode(o.modes, appMode) && (!o.hours || inHours(hour, o.hours)),
      );
      const rotated = rotate(pool, seed + gi);
      // 命中置顶规则的保证露出（时段专属其次，其余按当日轮换截取）
      const pins = gitReady
        ? CONTEXT_PINS.filter((p) => p.group === group.label && p.when(ctx))
        : [];
      const pinByLabel = new Map(pins.map((p) => [p.label, p]));
      const pinned = rotated.filter((o) => pinByLabel.has(o.label));
      const timed = rotated.filter((o) => o.hours && !pinByLabel.has(o.label));
      const rest = rotated.filter((o) => !o.hours && !pinByLabel.has(o.label));
      const buildOption = (o: SuggestionOption): PlannedOption => {
        const pin = pinByLabel.get(o.label);
        const template =
          pin?.promptTemplate ??
          (o.wsTemplate && wsName ? o.wsTemplate : o.prompt);
        return {
          label: o.label,
          hint: o.hint,
          art: o.art,
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
    })
    .filter((group) => group.options.length > 0);
}

export const ThreadSuggestions: FC = () => {
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const appMode = useThreadAppMode(threadId);
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  // 切档时把「手动收起 / 手动选组」一起清掉：清掉才会回落到新档的主场组。
  // 不这么做的话，在编码档手动收起后切到工作档会一直空着（收起状态跟着走），
  // 而"切到哪一档就看哪一档的案例"正是这个区域的主要用途。
  useEffect(() => {
    setPickedLabel(null);
  }, [appMode]);
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

  // 挂载/依赖变化时重算（含切档：模式变了整批建议跟着换）
  const groups = useMemo<PlannedGroup[]>(
    () =>
      // now 不进依赖：建议在挂载时算一次即可，跨过整点重算没意义
      planSuggestions({
        appMode,
        now: new Date(),
        wsName,
        gitReady,
        gitDirty,
        gitAhead,
      }),
    [wsName, gitReady, gitDirty, gitAhead, appMode],
  );

  // 默认展开当前模式的主场组（groups[0] 就是它）：切到设计档就能直接看到设计
  // 案例，不用先点一次分类。pickedLabel === "" 表示用户手动收起了（再点一次
  // 当前组即收起）；这个状态在切档时会被上面的 effect 重置，免得带着旧档的
  // 收起状态切过去、底下空一片。
  const autoLabel = groups[0]?.label ?? null;
  const activeLabel =
    pickedLabel === null
      ? autoLabel
      : pickedLabel === ""
        ? null
        : groups.some((group) => group.label === pickedLabel)
          ? pickedLabel
          : autoLabel;
  const expandedGroup = groups.find((group) => group.label === activeLabel);

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
                group.label === activeLabel && accentOf(group.label).chipActive,
              )}
              onClick={() =>
                setPickedLabel(
                  group.label === activeLabel ? "" : group.label,
                )
              }
            >
              <span className={accentOf(group.label).icon}>{group.icon}</span>
              {group.label}
            </Button>
          ))}
        </div>
      </div>
      {expandedGroup &&
        (() => {
          // 主推一张 + 右侧纯文字列表：一排同权重卡片看着像组件展示页，改成
          // "一个主案例 + 几条次要"更像产品里的推荐动作区（当日轮换/置顶规则
          // 决定谁当主推——有未提交改动时"审查未提交改动"就顶上来）
          const [hero, ...restOptions] = expandedGroup.options;
          if (!hero) return null;
          return (
            <div
              key={expandedGroup.label}
              className="fade-in slide-in-from-top-1 animate-in w-full duration-200"
            >
              {/* max-w + mx-auto：上面那排分类胶囊是窄的居中块，这块如果铺满整列
                  就会读成"贴左边"（主推卡在最左）；收窄居中后两块轴心对齐 */}
              <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 sm:flex-row sm:gap-3">
                <button
                  type="button"
                  title={hero.prompt}
                  onClick={() => fillComposer(hero.prompt)}
                  className="hover:border-border flex w-full shrink-0 flex-col gap-1.5 rounded-xl border border-border/60 p-2 text-start transition-colors sm:w-56"
                >
                  <SuggestionArtwork
                    kind={hero.art}
                    className={cn(
                      "aspect-[3/2] w-full",
                      accentOf(expandedGroup.label).tile,
                    )}
                  />
                  <span className="mt-0.5 px-0.5 text-sm font-medium">
                    {hero.label}
                  </span>
                  <span className="text-muted-foreground line-clamp-2 px-0.5 text-xs">
                    {hero.hint}
                  </span>
                </button>
                <div className="flex min-w-0 flex-1 flex-col justify-center">
                  {restOptions.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      title={option.prompt}
                      onClick={() => fillComposer(option.prompt)}
                      className="hover:bg-muted/40 flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-start transition-colors"
                    >
                      <span className="shrink-0 text-sm">{option.label}</span>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                        {option.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};
