"use client";

/**
 * 新会话欢迎建议（composer 为空时显示在输入框下方）。
 *
 * 结构：分组胶囊（横向滚动）→ 点开展开该组的提示词列表（贴左沿的菜单卡）
 * → 点击把完整提示词填入输入框，可改完再发。默认不选中任何组，
 * 点了哪个分类才展开哪个。
 *
 * 动效：分类条与提示词列表各是一个 fluid hover 作用域——灰的高亮胶囊跟着指针
 * 在同类之间滑行；选中的分类另有一块蓝色滑块，换分类时弹簧滑过去（底色不画在
 * 胶囊自己身上，画上去只能是瞬间跳变）。换组时旧列表整块淡出、新列表逐行错峰
 * 落位。曲线取 lib/motion 里的 tokens；减弱动效时只留淡入，位移全删。
 *
 * 显示时机：新对话页**始终显示**（填入提示词后也在）——它是"我还能做什么"的
 * 入口，不随输入框内容起落；离开新对话页（已开聊）整块欢迎区本来就退场。
 *
 * 内容不是死清单：每组维护一个更大的候选池，展示时做五层"应景"调整，
 * 全部纯前端推导（git 状态走 composer 同款的共享缓存，无额外请求）：
 * - 应用模式筛选：跟着新对话页顶部的「编码/工作」切换——模式专属的组
 *   （办公）只在对应档出现，「写代码」只在编码档；条目也能按模式限定
 *   （「整理会议纪要」只给工作档）。切档即换一批，主场组排最前。
 * - 时段排序：分组顺序随时间段变（早上偏写代码/写作，下午偏分析，晚上偏写作/灵感）；
 * - 按日轮换：每组用"当年第几天"做种子旋转候选池，取前几条——同一天内稳定，
 *   隔天再看就是一批新的；
 * - 时段专属：个别提示词只在特定小时出现（清晨规划、傍晚日报、深夜收尾）；
 * - 仓库/工作区定制：有未提交改动或未推送提交时置顶对应建议（提示词带上具体数字）；
 *   选了 workspace 的提示词模板用「目录名」替换 {ws}，没选则退回通用措辞。
 *   这一层是编码档专属——工作档隐藏 Git，不该被 git 建议占位。
 */
import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useFluidHover, useRegisterFluidHoverItem } from "@/hooks/use-fluid-hover";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import { FluidHoverHighlight } from "@/components/fluid-hover-highlight";
import { FluidHoverRow } from "@/components/fluid-hover-row";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/motion/ease";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useGitStatus } from "@/lib/git/git-status";
import { useThreadAppMode } from "@/lib/pi/pi-session-app-mode";
import type { AppMode } from "@/lib/pi/app-mode";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BookOpenIcon,
  BracesIcon,
  BrainIcon,
  BriefcaseIcon,
  BugIcon,
  CalculatorIcon,
  CalendarClockIcon,
  CalendarRangeIcon,
  ChartColumnIcon,
  ClipboardListIcon,
  CodeXmlIcon,
  Columns2Icon,
  DatabaseIcon,
  FileTextIcon,
  FlaskConicalIcon,
  FolderTreeIcon,
  GaugeIcon,
  GitPullRequestIcon,
  HighlighterIcon,
  LanguagesIcon,
  LayersIcon,
  LayoutPanelTopIcon,
  LightbulbIcon,
  ListTodoIcon,
  MailIcon,
  MegaphoneIcon,
  MessageSquareTextIcon,
  MoonIcon,
  NotebookPenIcon,
  PackageIcon,
  PackageOpenIcon,
  PencilLineIcon,
  PuzzleIcon,
  ScanSearchIcon,
  ShieldAlertIcon,
  ShuffleIcon,
  SparklesIcon,
  StoreIcon,
  TableIcon,
  TagIcon,
  TargetIcon,
  TerminalIcon,
  TimerIcon,
  TrendingUpIcon,
  WandSparklesIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";

type Slot = "morning" | "noon" | "afternoon" | "evening" | "night";

type SuggestionOption = {
  label: string;
  prompt: string;
  /** 列表行首的小图标（lucide 组件） */
  icon: LucideIcon;
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

const SUGGESTION_GROUPS: SuggestionGroup[] = [
  {
    label: "写代码",
    icon: <CodeXmlIcon />,
    modes: ["code"],
    options: [
      { label: "解释这段代码", icon: BookOpenIcon, prompt: "逐段解释当前打开文件里的核心逻辑，指出潜在问题" },
      { label: "写一个防抖函数", icon: TimerIcon, prompt: "用 TypeScript 写一个带立即执行选项的 debounce 函数，附使用示例" },
      { label: "审查未提交改动", icon: ScanSearchIcon, prompt: "审查当前仓库未提交的改动，按严重程度列出问题和建议" },
      { label: "补单元测试", icon: FlaskConicalIcon, prompt: "为最近改动的模块补充单元测试，覆盖边界情况" },
      { label: "定位一个报错", icon: BugIcon, prompt: "我这里有个报错（把堆栈贴到输入框），帮我定位根因并给出修复方案" },
      { label: "重构一段代码", icon: WrenchIcon, prompt: "挑出当前打开文件里最值得重构的一段，说明理由并给出重构后的版本" },
      { label: "设计一个接口", icon: BracesIcon, prompt: "为这个功能设计一套接口：入参、返回、错误码，附调用示例" },
      { label: "写一段 SQL", icon: DatabaseIcon, prompt: "帮我写一条 SQL 查询（表结构和要查什么我写在输入框里）" },
      { label: "写个小脚本", icon: TerminalIcon, prompt: "写一个整理当前目录文件的小脚本，先讲思路再给完整代码" },
    ],
  },
  {
    label: "办公",
    icon: <BriefcaseIcon />,
    modes: ["work"],
    options: [
      { label: "整理待办", icon: ListTodoIcon, prompt: "把这段零散待办整理成按优先级排序的清单（内容贴输入框）" },
      { label: "整理会议纪要", icon: NotebookPenIcon, prompt: "把这段会议记录整理成结构化纪要：结论、待办、负责人（记录贴输入框）" },
      { label: "起草一封邮件", icon: MailIcon, prompt: "帮我起草一封邮件，语气专业但不生硬（要点我写进输入框）" },
      { label: "汇总成表格", icon: TableIcon, prompt: "把这段文字里的信息整理成表格，列名你定（内容贴输入框）" },
      { label: "写成可交接的 SOP", icon: ClipboardListIcon, prompt: "把这件事的流程写成一份别人照着就能做的 SOP 步骤" },
      { label: "翻译成英文", icon: LanguagesIcon, prompt: "把下面这段翻译成地道的英文商务表达（原文贴输入框）" },
      { label: "提炼要点", icon: HighlighterIcon, prompt: "把这份长文档提炼成十条要点，按重要性排序（文档贴输入框）" },
    ],
  },
  {
    label: "插件",
    icon: <PuzzleIcon />,
    options: [
      { label: "做一个技能插件", icon: PuzzleIcon, prompt: "帮我创建一个「会议纪要整理」技能插件，生成后告诉我怎么安装" },
      { label: "看看市场里有什么", icon: StoreIcon, prompt: "列出已添加的插件市场和可安装的插件，推荐一个适合我手头工作的" },
      { label: "管理已装插件", icon: PackageIcon, prompt: "列出当前已安装的插件和它们的组件，指出哪些长期没用了" },
      { label: "做一个面板插件", icon: LayoutPanelTopIcon, prompt: "帮我创建一个桌面时钟面板插件，生成后告诉我怎么启用" },
      { label: "把流程做成技能", icon: WorkflowIcon, prompt: "帮我把「每周整理待办和进展」这套流程做成技能插件，告诉我在哪装" },
      { label: "插件能给我什么", icon: SparklesIcon, prompt: "列出当前插件提供的组件与工具，说说哪些能用在我现在做的事上" },
    ],
  },
  {
    label: "分析",
    icon: <ChartColumnIcon />,
    options: [
      { label: "项目结构总览", icon: FolderTreeIcon, prompt: "梳理当前项目的目录结构和技术栈，画出模块依赖关系", wsTemplate: "梳理「{ws}」的目录结构和技术栈，画出模块依赖关系", modes: ["code"] },
      { label: "对比技术选型", icon: ArrowLeftRightIcon, prompt: "用表格对比 React、Vue、Svelte 的优缺点和适用场景", modes: ["code"] },
      { label: "找出性能瓶颈", icon: GaugeIcon, prompt: "分析当前项目里可能的性能瓶颈，给出排查步骤", modes: ["code"] },
      { label: "依赖健康检查", icon: ActivityIcon, prompt: "检查项目依赖里有没有明显过时或有已知漏洞的包，给出升级建议", modes: ["code"] },
      { label: "读懂一个模块", icon: LayersIcon, prompt: "挑一个这个仓库里最核心的模块，讲清楚它的职责和上下游", modes: ["code"] },
      { label: "算一笔数", icon: CalculatorIcon, prompt: "帮我核算这份数据的合计与占比，指出异常项（数据贴输入框）", modes: ["work"] },
      { label: "两版方案对比", icon: Columns2Icon, prompt: "对比这两版方案的差异：成本、风险、工期各差在哪（内容贴输入框）", modes: ["work"] },
      { label: "找出漏掉的点", icon: ShieldAlertIcon, prompt: "看下这份方案有没有明显的遗漏或风险，按严重程度排（方案贴输入框）", modes: ["work"] },
    ],
  },
  {
    label: "写作",
    icon: <PencilLineIcon />,
    options: [
      { label: "写周报", icon: CalendarRangeIcon, prompt: "根据本周的 git 提交记录，帮我起草一份周报" },
      { label: "写发布说明", icon: MegaphoneIcon, prompt: "为最近的改动写一段面向用户的发布说明" },
      { label: "写 PR 描述", icon: GitPullRequestIcon, prompt: "为当前改动写一份 PR 描述：改动点、动机、影响面", modes: ["code"] },
      { label: "润色一段文字", icon: WandSparklesIcon, prompt: "帮我润色一段文字，更简洁有力（把原文贴到输入框里）" },
      { label: "写人话版更新说明", icon: MessageSquareTextIcon, prompt: "把这次改动写成人话版的更新说明，面向非技术同事", modes: ["work"] },
      { label: "规划今天", icon: CalendarClockIcon, prompt: "把我脑子里的想法整理成今天的待办清单，按优先级排（想法贴到输入框里）", hours: [5, 11] },
      { label: "写今日日报", icon: FileTextIcon, prompt: "根据今天的 git 提交记录，帮我起草一份今日工作日报", hours: [17, 22], modes: ["code"] },
      { label: "写今日进度", icon: TrendingUpIcon, prompt: "把我今天做完和没做完的事整理成一段进度说明（素材贴输入框）", hours: [17, 22], modes: ["work"] },
    ],
  },
  {
    label: "灵感",
    icon: <LightbulbIcon />,
    options: [
      { label: "头脑风暴", icon: BrainIcon, prompt: "头脑风暴五个适合独立开发者的小工具创意，说明切入点" },
      { label: "给产品起名", icon: TagIcon, prompt: "为一个 AI 编程助手产品起十个名字，每个附一句理由" },
      { label: "拆解一个产品", icon: PackageOpenIcon, prompt: "选一个你熟悉的产品拆解它的核心功能设计，说说为什么这么做" },
      { label: "换个思路", icon: ShuffleIcon, prompt: "我现在卡在「（把卡点写进输入框）」，给我三个完全不同的思路" },
      { label: "找几个小切入点", icon: TargetIcon, prompt: "围绕我现在在做的事，给三个今天就能动手的小切入点" },
      { label: "总结今天", icon: MoonIcon, prompt: "把今天的工作进展总结成三句话，方便我明天接着干", hours: [22, 5] },
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

/** 模式的主场组：切到哪一档，哪一档的内容排最前（legacy design 档无主场组，按时段序） */
const MODE_PRIMARY_GROUPS: Partial<Record<AppMode, string[]>> = {
  code: ["写代码"],
  work: ["办公"],
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
  prompt: string;
  icon: LucideIcon;
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

// 尾部 active:…translate-y-0：Button 基类按压时整体下移 1px（和基类的 transform
// 过渡组合出"上下跳"的观感），推荐区是常驻入口不是动作按钮，压平它。
// 变体栈必须和基类逐字一致，tailwind-merge 才认得出是同一组、把基类那条删掉。
// hover 底色统一压掉：悬停反馈整块交给 fluid hover 的高亮胶囊（见渲染处），
// 按钮再各亮一块就成了两套反馈打架
const suggestionChipClass =
  "aui-thread-welcome-suggestion text-foreground h-auto gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-normal whitespace-nowrap transition-colors hover:bg-transparent dark:hover:bg-transparent [&_svg]:size-4 active:not-aria-[haspopup]:translate-y-0";

// 展开组的提示词胶囊：与分类胶囊同款的贴内容描边胶囊（同色阶、同圆角），
// 行首带该条自己的小图标，纵向堆叠、整列居中；入场逐条错峰落位（见渲染处）
const suggestionItemClass =
  "aui-thread-welcome-suggestion text-foreground h-auto w-fit max-w-full justify-start gap-1.5 rounded-full border px-3.5 py-1.5 text-left text-sm font-normal whitespace-nowrap transition-colors hover:bg-transparent dark:hover:bg-transparent [&_svg]:size-4 active:not-aria-[haspopup]:translate-y-0";

/** 换组时整块列表的编排：容器只管节拍，位移交给每行自己。旧列表一次性淡出
 *  （逐行退场会把"换一批"拖成两段戏），新列表再逐行错峰落位 */
const listSwap: Variants = {
  hidden: {},
  show: { transition: { delayChildren: 0.02, staggerChildren: 0.04 } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } },
};

/** 行的入场：向上 6px 落位 + 淡入。减弱动效时只留淡入——位移幅度小也是位移，
 *  节拍照旧（少了位移的错峰读起来仍是"一条条出现"） */
const rowSwap = (reduce: boolean): Variants => ({
  hidden: { opacity: 0, y: reduce ? 0 : -6 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: reduce ? 0.12 : 0.24, ease: EASE_OUT },
  },
});

/**
 * 展开组的单行：自己就是登记进所在列表的 fluid hover 行盒（悬停高亮滑向它的
 * rect），同时承担入场那一段位移。包一层 motion.div 不改变列布局——按钮照旧
 * 按内容撑开行宽；行必须是定位元素且晚于高亮渲染，才压得在高亮之上。
 */
const SuggestionRow: FC<{
  option: PlannedOption;
  index: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  reduce: boolean;
  onPick: (prompt: string) => void;
}> = ({ option, index, registerItem, reduce, onPick }) => {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  // 变体对象身份钉住：悬停高亮每次移动都会重渲染这些行，重建变体会让
  // framer 每帧重解一次入场动画
  const variants = useMemo(() => rowSwap(reduce), [reduce]);
  return (
    <motion.div ref={ref} variants={variants} className="relative w-fit max-w-full">
      <Button
        variant="ghost"
        className={suggestionItemClass}
        title={option.prompt}
        onClick={() => onPick(option.prompt)}
      >
        <option.icon />
        {option.label}
      </Button>
    </motion.div>
  );
};

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
  const order = [...(MODE_PRIMARY_GROUPS[appMode] ?? []), ...SLOT_GROUP_ORDER[slotOf(hour)]];
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
          icon: o.icon,
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
  // 默认不选中任何组（null）：初始只看到分类胶囊行，点了哪个才展开哪个的
  // 提示词列表，再点当前组收起。切档时清回不选中——旧档的展开组可能在新档
  // 根本不存在，留着只会让列表空转或换组错位。
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
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

  // 默认不选中：pickedLabel 为 null 就没有展开组；用户点过的组若因模式/建议
  // 刷新不再存在，也回落到不选中（不自动顶替成别的组）。
  const activeLabel =
    pickedLabel && groups.some((group) => group.label === pickedLabel)
      ? pickedLabel
      : null;
  const expandedGroup = groups.find((group) => group.label === activeLabel);

  const reduce = useReducedMotion() ?? false;

  // 两条胶囊各自一个 fluid hover 作用域：高亮块按测量出的 rect 滑行，
  // gapClick 关掉——胶囊之间的空隙和右侧那片空白不是"最近的胶囊"，点它们
  // 不该触发任何一条建议（列表行的空隙同理）。
  const chipRowRef = useRef<HTMLDivElement>(null);
  const chipHover = useFluidHover(chipRowRef, { axis: "x", gapClick: false });
  const listRef = useRef<HTMLDivElement>(null);
  const listHover = useFluidHover(listRef, { axis: "y", gapClick: false });

  // 选中的分类：底色由单独的滑块承担（同一套测量出的 rect），换组时弹簧滑过去；
  // 没选中 → null → 滑块淡出。胶囊自己只改文字/描边颜色
  const selectedIndex = activeLabel
    ? groups.findIndex((group) => group.label === activeLabel)
    : -1;
  const selectedRect =
    chipHover.isMeasured && selectedIndex >= 0
      ? (chipHover.itemRects[selectedIndex] ?? null)
      : null;

  /** 填入输入框而不直发：优先**插入到光标处**（保留用户已写内容，与资料库
   *  引用芯片同一条 CM 插入桥）；输入框未挂载时才退回整段 setText。
   *  点击条目时焦点在按钮上，插入桥回退到最近使用的输入框并沿用其光标位置。 */
  const fillComposer = (prompt: string) => {
    if (aui.thread.getState().isRunning) return;
    if (insertIntoComposer(prompt)) return;
    aui.composer.setText(prompt);
  };

  return (
    // 与欢迎页问候语/输入框同一条左沿：本容器与 ViewportFooter 同盒，靠不留
    // 水平内边距对齐（别加 px-4）；行内也不再用 mx-auto 居中——胶囊行贴左沿起排，
    // 溢出时横向滚动
    <div className="aui-thread-welcome-suggestions flex w-full flex-col gap-2">
      <div className="w-full scrollbar-none overflow-x-auto">
        {/* 分类条自己就是 fluid hover 的作用域：横条按 x 取最近项。高亮块在
            这一行里，坐标是内容坐标——条子横向滚动时高亮跟着胶囊一起走 */}
        <div
          ref={chipRowRef}
          className="relative flex w-max items-center gap-2"
          {...chipHover.handlers}
        >
          {/* 悬停高亮：指针扫过分类条时，灰胶囊在分类之间滑行 */}
          <FluidHoverHighlight hover={chipHover} className="rounded-full" />
          {/* 选中滑块：底色画在这块上而不是胶囊自己身上（画在胶囊上只能是
              瞬间跳变），换分类时用 no-overshoot 弹簧滑到新的 rect。
              session 恒为 0：只在首挂载淡入，之后只滑位置，不随鼠标进出闪 */}
          <FluidHoverHighlight
            rect={selectedRect}
            session={0}
            transition={SPRING_LAYOUT}
            className="rounded-full bg-blue-500/10 dark:bg-blue-400/15"
          />
          {groups.map((group, i) => (
            <FluidHoverRow
              key={group.label}
              registerItem={chipHover.registerItem}
              index={i}
              className="shrink-0"
            >
              <Button
                variant="ghost"
                className={cn(
                  suggestionChipClass,
                  "border border-border/60",
                  // 选中态蓝色高亮：文字与描边换蓝即可，底色由上面那块滑块
                  // 滑过来。不再挂 --primary——没选强调色预设时 primary 是近黑
                  // 单色，选中就成了一条灰。直接钉死外观设置「蓝色」预设同一族
                  // 的色值（浅色 blue-600 / 深色 blue-400）
                  group.label === activeLabel &&
                    "border-blue-600/60! text-blue-600! dark:text-blue-400",
                )}
                onClick={() =>
                  setPickedLabel(
                    group.label === activeLabel ? null : group.label,
                  )
                }
              >
                {group.icon}
                {group.label}
              </Button>
            </FluidHoverRow>
          ))}
        </div>
      </div>
      {/* 列表区恒定占位：高度 = 满 5 行胶囊 + 4 个行距（34×5 + 8×4 = 202px）。
          点选分类/收起/换组都不再改变这块的高度——之前列表一出现，居中的
          欢迎布局整体被顶高、输入框跟着上下跳。胶囊条数不足 5 时顶部对齐，
          差额留在占位区底部（页面本来就空，比跳版好） */}
      <div className="h-[202px] w-full">
        {/* 作用域贴着内容（w-fit）而不是占满整行：指针飘到右侧空白里时
            不该点亮任何一行 */}
        <div
          ref={listRef}
          className="relative flex w-fit max-w-full flex-col items-start gap-2"
          {...listHover.handlers}
        >
          {/* 悬停高亮：指针在行间上下移动时，灰胶囊在提示词之间滑行 */}
          <FluidHoverHighlight hover={listHover} className="rounded-full" />
          {/* AnimatePresence 必须待在条件渲染之外：挂在条件内部的话，收起/
              换组时它和子树一起卸载，退场动画永远不执行（同一坑见
              thread-preview-rail 的注释）。mode="wait" 让旧列表先退干净，
              再放新列表进场——两批行同时挂在 DOM 里会同时登记进 fluid hover，
              高亮的 rect 就成了两套坐标打架 */}
          <AnimatePresence mode="wait">
            {expandedGroup ? (
              <motion.div
                key={expandedGroup.label}
                variants={listSwap}
                initial="hidden"
                animate="show"
                exit="exit"
                className="flex w-full flex-col items-start gap-2"
              >
                {expandedGroup.options.map((option, i) => (
                  <SuggestionRow
                    key={option.label}
                    option={option}
                    index={i}
                    registerItem={listHover.registerItem}
                    reduce={reduce}
                    onPick={fillComposer}
                  />
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
