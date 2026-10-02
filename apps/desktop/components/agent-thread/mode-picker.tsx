"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  CheckIcon,
  ClipboardListIcon,
  HandIcon,
  Loader2Icon,
  LockOpenIcon,
  MessageCircleQuestionIcon,
  SquarePenIcon,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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

/**
 * 会话模式切换器（composer 区）——五选项，前三项之外的两个是能力形态而非权限：
 * - 问答：只读工具（read/glob/grep/联网），不给 bash、不下发子代理，系统提示词
 *   剔掉任务追踪与子代理两段。问问题就得到答案，不会顺手开工
 * - 变更前确认：改文件/跑命令前先问我（agent + ask）
 * - 自动编辑：自动编辑文件，命令仍需确认（agent + auto-edit）
 * - 计划模式：编辑前先出计划（plan_enter/plan_write/plan_exit），批准后再实施（plan）
 * - 完全访问：全部自动执行，减少确认次数（agent + auto）
 * 切换即发 set_mode（可随时切换，含运行中——与模型自主 plan_enter/plan_exit 同路径，
 * 后者经 data-planningState chunk 推送，这里镜像显示）；挂载/换线程时经
 * get_planning_state 水合快照（页面刷新后 UI 不漂移）。
 * Shift+Tab 在选项间循环（与 Cursor / Claude Code 一致），下拉未展开时生效。
 */

export type PickerOption = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  mode: SessionMode;
  approvalLevel?: ApprovalLevel;
  /** 高危选项：选中后以警告色提示（如完全访问） */
  warning?: boolean;
};

/** 五档选项（导出给 composer 的 + 菜单复用，两处形态不同、语义同一份） */
export const OPTIONS: PickerOption[] = [
  {
    key: "ask",
    label: "问答",
    description: "只读工具，不碰你的项目。",
    icon: MessageCircleQuestionIcon,
    mode: "ask",
  },
  {
    key: "confirm",
    label: "变更前确认",
    description: "改文件前先问我。",
    icon: HandIcon,
    mode: "agent",
    approvalLevel: "ask",
  },
  {
    key: "auto-edit",
    label: "自动编辑",
    description: "自动编辑文件。",
    icon: SquarePenIcon,
    mode: "agent",
    approvalLevel: "auto-edit",
  },
  {
    key: "plan",
    label: "计划模式",
    description: "编辑前先出计划。",
    icon: ClipboardListIcon,
    mode: "plan",
  },
  {
    key: "auto",
    label: "完全访问",
    description: "减少确认次数。",
    icon: LockOpenIcon,
    mode: "agent",
    approvalLevel: "auto",
    warning: true,
  },
];

/** 当前档位对应的选项：ask/plan 各自独占一档，agent 档再按审批级别细分。
 *  写成按 mode 查表而不是 `mode === "plan" ? "plan" : approvalLevel` 的三元——
 *  后者会让新增的第三档塌陷成某个审批级别，UI 显示的档位和真实模式对不上 */
export function currentOption(snap: PlanningSnapshot): PickerOption {
  return (
    OPTIONS.find((o) => o.mode === snap.mode && o.mode !== "agent") ??
    OPTIONS.find((o) => o.mode === "agent" && o.approvalLevel === snap.approvalLevel) ??
    OPTIONS[1]
  );
}

export const ModePicker: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 挂载/换线程时水合快照（刷新后本地 store 为空，sidecar 模式才是事实源）
  useEffect(() => {
    if (!threadId) return;
    fetchPlanningState(threadId).catch(() => {});
  }, [threadId]);

  if (!threadId) return null;

  const current = currentOption(snap);
  const inPlanning = snap.planning !== "inactive";
  const CurrentIcon = current.icon;

  const pick = (o: PickerOption) => {
    setOpen(false);
    if (o === current) return;
    setBusy(true);
    setSessionMode(threadId, o.mode, o.approvalLevel)
      .catch((err) => console.error("set_mode failed:", err))
      .finally(() => setBusy(false));
  };

  // Shift+Tab 循环档位（与 Cursor / Claude Code 一致）：下拉展开时让给菜单自身，
  // 焦点在输入框或本按钮上时接管。跳过纯权限档的等距循环——五档线性轮转更好按。
  useEffect(() => {
    if (open || busy || !threadId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && !target.closest(".aui-composer-input, [data-slot='aui-composer-mode']")) return;
      e.preventDefault();
      const idx = OPTIONS.indexOf(current);
      pick(OPTIONS[(idx + 1) % OPTIONS.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, threadId, current]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-mode"
            aria-label="Session mode"
            disabled={busy}
            title={current.description}
            className={cn(
              "hover:bg-muted inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-sm transition-colors disabled:opacity-50 @max-2xl:px-2",
              // 高危模式选中时用警告色提醒（覆盖常规/计划态文字色）
              current.warning
                ? "text-amber-600 dark:text-amber-400"
                : inPlanning
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            {busy ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <CurrentIcon className="size-3.5 shrink-0" />
            )}
            {/* 窄栏只留图标：档位名收进 title（悬停可见），图标形状 + 警告色已能区分五档 */}
            <span className="@max-2xl:hidden">{current.label}</span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          {OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.key}
              onClick={() => pick(o)}
              className="gap-2.5 py-2"
            >
              <o.icon className="text-muted-foreground size-4 shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span
                  className={cn(
                    "text-sm font-medium",
                    // 高危选项在选中态下也用警告色
                    o.warning && o === current && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {o.label}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {o.description}
                </span>
              </div>
              {o === current && (
                <CheckIcon className="ml-auto size-4 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
