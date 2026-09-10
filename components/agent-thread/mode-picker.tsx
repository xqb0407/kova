"use client";

import { useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  CheckIcon,
  ClipboardListIcon,
  HandIcon,
  Loader2Icon,
  LockOpenIcon,
  SquarePenIcon,
  TargetIcon,
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
  setSessionMode,
  useSessionMode,
  type ApprovalLevel,
  type SessionMode,
} from "@/lib/pi-session-mode";

/**
 * 会话模式切换器（composer 区，"+" 号图标旁）——权限导向的五选项（对齐主流编码工具）：
 * - 变更前确认：改文件/跑命令前先问我（agent + ask）
 * - 自动编辑：自动编辑文件，命令仍需确认（agent + auto-edit）
 * - 计划模式：编辑前先出计划，批准后再实施（plan）
 * - 完全访问：全部自动执行，减少确认次数（agent + auto）
 * - 目标模式：协商目标契约与验收标准，批准后自主执行（goal）
 * 切换即发 set_mode（可随时切换，含运行中——与模型自主 EnterPlanMode 同路径）。
 */

type PickerOption = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  mode: SessionMode;
  approvalLevel?: ApprovalLevel;
  /** 高危选项：选中后以警告色提示（如完全访问） */
  warning?: boolean;
};

const OPTIONS: PickerOption[] = [
  {
    key: "ask",
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
  {
    key: "goal",
    label: "目标模式",
    description: "先定目标与验收标准，批准后自主执行。",
    icon: TargetIcon,
    mode: "goal",
  },
];

export const ModePicker: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!threadId) return null;

  const activeKey =
    snap.mode === "goal"
      ? "goal"
      : snap.mode === "plan"
        ? "plan"
        : snap.approvalLevel;
  const current = OPTIONS.find((o) => o.key === activeKey) ?? OPTIONS[0];
  const inPlanning = snap.planning !== "inactive";
  const CurrentIcon = current.icon;

  const pick = (o: PickerOption) => {
    setOpen(false);
    if (o.key === activeKey) return;
    setBusy(true);
    setSessionMode(threadId, o.mode, o.approvalLevel)
      .catch((err) => console.error("set_mode failed:", err))
      .finally(() => setBusy(false));
  };

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
              "hover:bg-muted inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-sm transition-colors disabled:opacity-50",
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
            <span>{current.label}</span>
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
                    o.warning && o.key === activeKey && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {o.label}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {o.description}
                </span>
              </div>
              {o.key === activeKey && (
                <CheckIcon className="ml-auto size-4 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
