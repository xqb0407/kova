"use client";

import { useState, type FC } from "react";
import {
  BriefcaseIcon,
  CheckIcon,
  CodeIcon,
  Loader2Icon,
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
import { setAppMode, useAppMode, type AppMode } from "@/lib/app-mode";

/**
 * 全局工作模式切换器（会话顶栏，「更多」按钮左侧；设置 → 通用里同一事实源）。
 * 应用级开关：切换立即影响所有会话——提示词附加段、git UI 显隐、工具行形态；
 * 与 composer 旁的权限模式切换器（mode-picker，agent/plan）是正交的两个维度。
 * 形态对齐 mode-picker：胶囊按钮 + 两选项下拉（图标/说明/当前勾选）。
 */

type ModeOption = {
  value: AppMode;
  label: string;
  description: string;
  icon: LucideIcon;
};

const OPTIONS: ModeOption[] = [
  {
    value: "code",
    label: "编码",
    description: "面向开发：完整工具与细节（Git、可展开的工具输出）。",
    icon: CodeIcon,
  },
  {
    value: "work",
    label: "工作",
    description: "面向日常办公：交付导向，隐藏 Git，工具步骤收敛为摘要。",
    icon: BriefcaseIcon,
  },
];

export const AppModeSwitch: FC = () => {
  const appMode = useAppMode();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = OPTIONS.find((o) => o.value === appMode) ?? OPTIONS[0];
  const CurrentIcon = current.icon;

  const pick = (o: ModeOption) => {
    setOpen(false);
    if (o.value === appMode) return;
    setBusy(true);
    setAppMode(o.value)
      .catch((err) => console.error("set_app_mode failed:", err))
      .finally(() => setBusy(false));
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-header-app-mode"
            aria-label="工作模式"
            disabled={busy}
            title={current.description}
            className={cn(
              "hover:bg-muted text-muted-foreground hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm transition-colors disabled:opacity-50",
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
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {OPTIONS.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => pick(o)}
              className="gap-2.5 py-2"
            >
              <o.icon className="text-muted-foreground size-4 shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{o.label}</span>
                <span className="text-muted-foreground text-xs">
                  {o.description}
                </span>
              </div>
              {o.value === appMode && (
                <CheckIcon className="ml-auto size-4 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
