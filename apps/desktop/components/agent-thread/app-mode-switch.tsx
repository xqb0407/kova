"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  BriefcaseIcon,
  CheckIcon,
  CodeIcon,
  Loader2Icon,
  PaletteIcon,
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
  hydrateThreadAppMode,
  setThreadAppMode,
  useThreadAppMode,
} from "@/lib/pi/pi-session-app-mode";
import { setAppMode, type AppMode } from "@/lib/pi/app-mode";
import { useEnsureUiDesignPlugin } from "@/components/design-mode-gate";

/**
 * 会话工作模式切换器（会话顶栏，「更多」按钮左侧）。
 * 会话级开关（与模型/思考档位选择器同语义）：切换只作用于本会话——定靶写
 * sessions.app_mode 偏好列，本会话保持自己的档；别的会话不受牵连。从未在本会话
 * 切过档（含新对话）则跟随「设置 → 通用」的全局默认档，那一档仍由设置页维护。
 * 影响面：提示词附加段、git UI 显隐、工具行形态；与 composer 旁的权限模式
 * 切换器（mode-picker，agent/plan）是正交的两个维度。
 * 形态对齐 mode-picker：胶囊按钮 + 选项下拉（图标/说明/当前勾选）。
 * 设计档有插件前置门禁：ui-design 插件未装/禁用时先弹窗引导，通过才切档。
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
  {
    value: "design",
    label: "设计",
    description: "面向 UI 设计：设计稿与高保真原型优先，隐藏 Git（需 UI 设计插件）。",
    icon: PaletteIcon,
  },
];

export const AppModeSwitch: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const appMode = useThreadAppMode(threadId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { ensure, dialog } = useEnsureUiDesignPlugin();

  // 切线程时水合该会话记住的档位（无记忆则回落全局默认档）
  useEffect(() => {
    if (!threadId) return;
    hydrateThreadAppMode(threadId);
  }, [threadId]);

  const current = OPTIONS.find((o) => o.value === appMode) ?? OPTIONS[0];
  const CurrentIcon = current.icon;

  const pick = (o: ModeOption) => {
    setOpen(false);
    if (o.value === appMode) return;
    setBusy(true);
    void (async () => {
      try {
        // 设计档前置门禁：ui-design 插件未装/禁用时弹窗引导，通过才切档
        if (o.value === "design" && !(await ensure())) return;
        if (threadId) {
          await setThreadAppMode(threadId, o.value);
        } else {
          // 无主线程上下文（理论不可达）：退化为纯全局默认档变更
          await setAppMode(o.value);
        }
      } catch (err) {
        console.error("set_app_mode failed:", err);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      {dialog}
      <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-header-app-mode"
            aria-label="工作模式"
            disabled={busy}
            title={`本会话工作模式：${current.description}`}
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
    </>
  );
};
