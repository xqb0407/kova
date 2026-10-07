"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { BriefcaseIcon, CodeIcon, PaletteIcon, type LucideIcon } from "lucide-react";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  hydrateThreadAppMode,
  setThreadAppMode,
  useThreadAppMode,
} from "@/lib/pi/pi-session-app-mode";
import { setAppMode, type AppMode } from "@/lib/pi/app-mode";
import { useEnsureUiDesignPlugin } from "@/components/design-mode-gate";

/**
 * 会话工作模式切换器（新对话欢迎页，问候语上方）。
 *
 * 会话级开关（与模型/思考档位选择器同语义）：切换只作用于本会话——定靶写
 * sessions.app_mode 偏好列，本会话保持自己的档；别的会话不受牵连。从未在本会话
 * 切过档（含新对话）则跟随「设置 → 通用」的全局默认档，那一档仍由设置页维护。
 * 影响面：提示词附加段、git UI 显隐、工具行形态；与 composer 旁的权限模式
 * 切换器（mode-picker，agent/plan）是正交的两个维度。
 *
 * 形态：用 custom-ui/segmented（与「插件市场 / 已安装插件」同一个组件、同一套
 * 主色滑块），只是取 size="lg"——它是欢迎页的主操作，跟问候语同处一屏，设置页
 * 那档 h-7/text-xs 会被压得看不见。三档一屏看全、一点即切；说明退到 title 里
 * （分段器没地方铺描述）。设计档有插件前置门禁：ui-design 插件未装/禁用时先
 * 弹窗引导，通过才切档。
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
  const [busy, setBusy] = useState(false);
  const { ensure, dialog } = useEnsureUiDesignPlugin();

  // 切线程时水合该会话记住的档位（无记忆则回落全局默认档）
  useEffect(() => {
    if (!threadId) return;
    hydrateThreadAppMode(threadId);
  }, [threadId]);

  const pick = (value: AppMode) => {
    if (value === appMode) return;
    setBusy(true);
    void (async () => {
      try {
        // 设计档前置门禁：ui-design 插件未装/禁用时弹窗引导，通过才切档
        if (value === "design" && !(await ensure())) return;
        if (threadId) {
          await setThreadAppMode(threadId, value);
        } else {
          // 无主线程上下文（理论不可达）：退化为纯全局默认档变更
          await setAppMode(value);
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
      {/* 与「插件市场 / 已安装插件」同一个分段器（custom-ui/segmented，主色滑块 +
          500ms EASE_OUT）。size="lg" 是它在欢迎页当主操作的尺寸；图标交给选项的
          icon 传，尺寸由这里的 size-4 决定 */}
      <Segmented
        size="lg"
        value={appMode}
        onChange={pick}
        disabled={busy}
        options={OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          icon: <o.icon className="size-4 shrink-0" />,
          // 分段器里铺不下描述，退到原生 tooltip 里
          title: o.description,
        }))}
      />
    </>
  );
};
