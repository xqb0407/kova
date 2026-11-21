"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  CheckIcon,
  ClipboardListIcon,
  HandIcon,
  Loader2Icon,
  LockOpenIcon,
  FolderLockIcon,
  MessageCircleQuestionIcon,
  ShieldCheckIcon,
  SquarePenIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  fetchPlanningState,
  setSessionMode,
  useSessionMode,
  type ApprovalLevel,
  type PlanningSnapshot,
  type SessionMode,
} from "@/lib/pi/pi-session-mode";
import { FullAccessConfirmDialog } from "@/components/agent-thread/full-access-confirm-dialog";

/**
 * 会话模式切换器（composer 区）——**只列权限档位**（按「问多少」从紧到松排）。
 * 能力形态（问答/计划/目标）不在这里：它们是正交的另一个维度，切了之后由
 * CapabilityModeChip 在右侧显示（见该组件注释）。
 * 下拉五项：
 * - 变更前确认：改文件/跑命令前先问我（agent + ask）
 * - 工作区内自动：项目内 write/edit 免确认，落到项目之外（含别的项目）要确认；
 *   命令仍确认（agent + workspace-write，边界判定见 sidecar 的 workspace-boundary.ts）
 * - 自动编辑：自动编辑文件，命令仍需确认（agent + auto-edit）
 * - AI 审查（实验）：不问人，由模型逐次判风险——低风险直接执行，高风险拦截，
 *   审查失败退回弹卡（agent + review，判定与失败回退见 sidecar 的
 *   permissions/auto-review.ts）
 * - 完全访问：全部自动执行，减少确认次数（agent + auto）。选中后先弹
 *   FullAccessConfirmDialog（范围与风险二次确认），确认才下发 set_mode——
 *   它是唯一一个会拿掉全部确认的档，不该与其余四档同样单击即生效
 *
 * 能力模式三项（不在下拉里，见 CAPABILITY_OPTIONS 与 CapabilityModeChip）：
 * - 问答：只读工具（read/glob/grep/联网），不给 bash、不下发子代理
 * - 计划模式：编辑前先出计划（plan_enter/plan_write/plan_exit），批准后再实施
 * - 目标模式：给一个目标，它跨轮自治做完（goal；常驻条见 goal-strip.tsx）
 * 切换即发 set_mode（可随时切换，含运行中——与模型自主 plan_enter/plan_exit 同路径，
 * 后者经 data-planningState chunk 推送，这里镜像显示）；挂载/换线程时经
 * get_planning_state 水合快照（页面刷新后 UI 不漂移）。
 * Shift+Tab 在选项间循环（与 Cursor / Claude Code 一致），下拉未展开时生效。
 */

/** 两个维度共用的展示字段 */
type PickerOptionBase = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

/**
 * 权限档位：只回答「改之前问不问」。
 *
 * **刻意不带 mode**。带上就会有人把那一项当成"切到这一档"的完整指令发出去——
 * 曾经四项都硬编码 `mode: "agent"`，于是在目标模式里点一下权限档，请求成了
 * `set_mode { mode: "agent", approvalLevel }`：会话被踢出目标模式，applyMode 的
 * 「离开 goal 档收尾」顺手把目标暂停了，而用户以为只是调了个问不问。
 * 类型上分开之后，想从权限项里读 mode 会直接编译不过。
 */
export type PermissionOption = PickerOptionBase & {
  approvalLevel: ApprovalLevel;
  /** 高危选项：选中后以警告色提示（如完全访问） */
  warning?: boolean;
  /** 值得醒目但不示警的档位：选中后按这张表的颜色强调（工作区内自动=绿，AI 审查=蓝） */
  accent?: keyof typeof ACCENT_CLASS;
};

/** 强调色表：warning（红）表达"当心"，accent 表达"这一档值得留意" */
export const ACCENT_CLASS = {
  blue: "text-blue-600 dark:text-blue-400",
  green: "text-emerald-600 dark:text-emerald-400",
} as const;

/** 能力档位：回答「能不能改、以什么形态干活」。决定 mode 的只有这一维。 */
export type CapabilityOption = PickerOptionBase & { mode: SessionMode };

/**
 * 权限档位：只回答「改之前问不问」。这是下拉里唯一的五个选项，也是 Shift+Tab 的循环集。
 *
 * 与能力模式（问答/计划/目标）正交——那两个维度在协议与 sidecar 里本来就是独立的
 * 两个字段（`run.approvalLevel` 与 `run.mode`），所以这里按维度分成两张表，
 * 而不是像以前那样把七项混在一个下拉里。
 */
export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    key: "confirm",
    label: "变更前确认",
    description: "改文件、跑命令前先问我。",
    icon: HandIcon,
    approvalLevel: "ask",
  },
  {
    key: "workspace-write",
    label: "工作区内自动",
    description: "项目内改文件免确认；命令仍要确认。",
    icon: FolderLockIcon,
    approvalLevel: "workspace-write",
    accent: "green",
  },
  {
    key: "auto-edit",
    label: "自动编辑",
    description: "自动编辑文件；命令仍需确认。",
    icon: SquarePenIcon,
    approvalLevel: "auto-edit",
  },
  {
    key: "review",
    label: "AI 审查",
    description: "模型逐次判风险，低风险直接执行。",
    icon: ShieldCheckIcon,
    approvalLevel: "review",
    accent: "blue",
  },
  {
    key: "auto",
    label: "完全访问",
    description: "全部自动执行，不再询问。",
    icon: LockOpenIcon,
    approvalLevel: "auto",
    warning: true,
  },
];

/**
 * 能力模式：回答「能不能改、以什么形态干活」。这三项**不在下拉里**——切到其中之一时
 * 由底栏的分隔线右侧那行字显示（CapabilityModeChip），退出点那行字。
 * 入口是 `/` 指令菜单（/ask /plan /goal）与 composer 的「+」菜单。
 */
export const CAPABILITY_OPTIONS: CapabilityOption[] = [
  {
    key: "ask",
    label: "问答",
    description: "只读工具，不碰你的项目。",
    icon: MessageCircleQuestionIcon,
    mode: "ask",
  },
  {
    key: "plan",
    label: "计划模式",
    description: "编辑前先出计划。",
    icon: ClipboardListIcon,
    mode: "plan",
  },
  {
    key: "goal",
    label: "目标模式",
    description: "给一个目标，我跨轮把它做完。",
    icon: TargetIcon,
    mode: "goal",
  },
];

/** 当前档位对应的选项：ask/plan/goal 各自独占一档，agent 档再按审批级别细分。
 *  写成按 mode 查表而不是 `mode === "plan" ? "plan" : approvalLevel` 的三元——
 *  后者会让新增的第三档塌陷成某个审批级别，UI 显示的档位和真实模式对不上 */
/**
 * 权限档位解析：**只看 approvalLevel，不看 mode**。
 *
 * 以前这里按「能力优先」挑选项，于是切到问答档时下拉按钮会显示"问答"而不是权限档；
 * 拆开两个维度之后，下拉只表达权限，能力由旁边的胶囊表达。
 */
export function permissionOption(snap: PlanningSnapshot): PermissionOption {
  return (
    PERMISSION_OPTIONS.find((o) => o.approvalLevel === snap.approvalLevel) ??
    PERMISSION_OPTIONS[0]
  );
}

/** 能力模式解析：不在能力档（agent）时返回 null —— 胶囊据此决定渲染与否 */
export function capabilityOption(snap: PlanningSnapshot): CapabilityOption | null {
  if (snap.mode === "agent") return null;
  return CAPABILITY_OPTIONS.find((o) => o.mode === snap.mode) ?? null;
}

export const ModePicker: FC<{
  /** 是否绑定全局 Shift+Tab 循环。主会话为 true；辅助会话副屏传 false——
   *  两个实例的 keydown 都挂在 window 上、只校验「焦点在某个 composer 里」，
   *  不禁用的话一次 Shift+Tab 会把主副两个会话的权限档同时循环掉。 */
  enableCycleShortcut?: boolean;
}> = ({ enableCycleShortcut = true }) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 完全访问待确认：确认弹窗打开期间不发 set_mode，取消则保持当前档 */
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);

  // 挂载/换线程时水合快照（刷新后本地 store 为空，sidecar 模式才是事实源）
  useEffect(() => {
    if (!threadId) return;
    fetchPlanningState(threadId).catch(() => {});
  }, [threadId]);

  // 换线程时收起未确认的完全访问：确认动作绑定的是上一个会话，不能落到新会话上
  useEffect(() => {
    setConfirmFullAccess(false);
  }, [threadId]);

  if (!threadId) return null;

  const current = permissionOption(snap);
  const CurrentIcon = current.icon;
  // 底栏胶囊统一「无底色 + 弱化文本色（悬停转前景色）」（与模型选择器同款
  // 幽灵样式：选中/生效不靠底色表达，hover 才给反馈底）。权限档的语义色只
  // 留给图标（绿=工作区内自动、蓝=AI 审查、红=完全访问），文字不再分色；
  // 「完全访问」保留红色文字，风险提示优先于视觉统一。
  const iconTone = current.warning
    ? "text-red-600 dark:text-red-400"
    : current.accent
      ? ACCENT_CLASS[current.accent]
      : "text-muted-foreground";
  const textTone = current.warning
    ? "text-red-600 dark:text-red-400"
    : "text-muted-foreground hover:text-foreground";

  const applyLevel = (level: ApprovalLevel) => {
    setBusy(true);
    // 权限项里没有 mode：能力档位是正交的另一维，切权限时原样沿用**当前**档位。
    // 传 o.mode（曾经是硬编码的 "agent"）等于顺手把会话踢出问答/计划/目标档——
    // 目标模式那边还会因此暂停目标，而用户只是想改个问不问
    setSessionMode(threadId, snap.mode, level)
      .catch((err) => console.error("set_mode failed:", err))
      .finally(() => setBusy(false));
  };

  const pick = (o: PermissionOption) => {
    setOpen(false);
    if (o === current) return;
    // 完全访问先过二次确认：这一档会把所有确认都拿掉，不能与其余四档同价单击
    if (o.approvalLevel === "auto") {
      setConfirmFullAccess(true);
      return;
    }
    applyLevel(o.approvalLevel);
  };

  // Shift+Tab 循环权限档（与 Cursor / Claude Code 一致）：下拉展开时让给菜单自身，
  // 焦点在输入框或本按钮上时接管。只循环这五项权限——能力模式（问答/计划/目标）
  // 不在这条环形里，靠 `/` 指令或「+」菜单切。
  useEffect(() => {
    if (!enableCycleShortcut || open || busy || confirmFullAccess || !threadId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && !target.closest(".aui-composer-input, [data-slot='aui-composer-mode']")) return;
      e.preventDefault();
      const idx = PERMISSION_OPTIONS.indexOf(current);
      pick(PERMISSION_OPTIONS[(idx + 1) % PERMISSION_OPTIONS.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enableCycleShortcut, open, busy, confirmFullAccess, threadId, current, snap.mode]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              data-slot="aui-composer-mode"
              aria-label="Session mode"
              disabled={busy}
              title={`${current.label}：${current.description}`}
              className={cn(
                "hover:bg-muted inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm transition-colors disabled:opacity-50 @max-2xl:px-2",
                textTone,
              )}
            >
              {busy ? (
                <Loader2Icon
                  className={cn("size-3.5 shrink-0 animate-spin", iconTone)}
                />
              ) : (
                <CurrentIcon className={cn("size-3.5 shrink-0", iconTone)} />
              )}
              {/* 窄栏只留图标：档位名收进 title（悬停可见），图标形状 + 警告色已能区分各档 */}
              <span className="@max-2xl:hidden">{current.label}</span>
            </button>
          }
        />
        <DropdownMenuContent
          align="start"
          // 默认 ring-foreground/10 叠上 shadow-xl 后边缘偏重；这里单独收淡
          className="w-72 ring-border/70"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 pb-1">确认方式</DropdownMenuLabel>
            {PERMISSION_OPTIONS.map((o) => {
              const selected = o === current;
              // 选中项的颜色同时作用于标题/图标/勾选；警告档即使未选中也让
              // 图标保持红色——「完全访问」的风险提示应当先于点击出现
              const selectedTone = selected
                ? o.warning
                  ? "text-red-600 dark:text-red-400"
                  : o.accent
                    ? ACCENT_CLASS[o.accent]
                    : undefined
                : undefined;
              const iconTone =
                selectedTone ??
                (o.warning ? "text-red-600/80 dark:text-red-400/80" : undefined);
              return (
                <DropdownMenuItem
                  key={o.key}
                  onClick={() => pick(o)}
                  className={cn("gap-2.5 py-2", selected && "bg-muted/50")}
                >
                  {/* 图标对齐标题行（两行内容时不再垂直居中到两行之间） */}
                  <o.icon
                    className={cn(
                      "text-muted-foreground mt-0.5 size-4 shrink-0 self-start",
                      iconTone,
                    )}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn("text-sm font-medium", selectedTone)}>
                      {o.label}
                    </span>
                    {/* 宽度放开后不再截断：说明是这一档的核心差异，半句省略反而误导 */}
                    <span className="text-muted-foreground text-xs leading-snug whitespace-normal">
                      {o.description}
                    </span>
                  </div>
                  {selected && (
                    <CheckIcon className={cn("ml-auto size-4 shrink-0", selectedTone)} />
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator className="bg-foreground/[0.06]" />
          <div className="text-muted-foreground/70 px-2 py-1.5 text-xs">
            Shift+Tab 快速切换
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <FullAccessConfirmDialog
        open={confirmFullAccess}
        busy={busy}
        onCancel={() => setConfirmFullAccess(false)}
        onConfirm={() => {
          setConfirmFullAccess(false);
          applyLevel("auto");
        }}
      />
    </>
  );
};

/**
 * 能力模式胶囊（底栏权限选择器右侧，隔一道竖线）。
 *
 * 为什么从下拉里挪出来：权限与能力是两个正交维度，混在一个七项下拉里，用户看到的是
 * 一串平铺的档位，分不清"哪些是问不问、哪些是能不能干"。拆开后下拉只表达权限，
 * 能力档在位时这里显示一行字——也就回到「一眼看出我现在处于什么形态」。
 *
 * 只在能力档渲染：agent 档这整块（含竖线）消失，底栏与以前完全一样。
 * 点它 = 退出该能力模式（仍是 set_mode 到 agent，保留当前权限档）——与今天在
 * 下拉里改选任一权限项是同一条路，这里只是把它挪到手边。
 * 进入这三个档的入口是 `/` 指令（/ask /plan /goal）与「+」菜单。
 */
export const CapabilityModeChip: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const [busy, setBusy] = useState(false);
  const cap = capabilityOption(snap);
  if (!threadId || !cap) return null;
  const Icon = cap.icon;

  const exit = () => {
    setBusy(true);
    setSessionMode(threadId, "agent")
      .catch((err) => console.error("exit capability mode failed:", err))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex items-center gap-1">
      {/* 竖线：分隔"问不问"与"以什么形态干活"两个维度 */}
      <span aria-hidden className="bg-border/60 h-4 w-px shrink-0" />
      <button
        type="button"
        data-slot="aui-composer-capability"
        disabled={busy}
        onClick={exit}
        title={`${cap.label}：${cap.description}（点击退出）`}
        className={cn(
          "text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm transition-colors disabled:opacity-50 @max-2xl:px-2",
        )}
      >
        {busy ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Icon className="size-3.5 shrink-0" />
        )}
        {/* 窄栏与权限档同规则只留图标：形状 + 位置已能区分，名字收进 title */}
        <span className="@max-2xl:hidden">{cap.label}</span>
      </button>
    </div>
  );
};
