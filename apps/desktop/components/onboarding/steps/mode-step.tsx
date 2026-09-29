"use client";

import { useEffect, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  setAppMode,
  useAppMode,
  useAppModeDegraded,
  type AppMode,
} from "@/lib/pi/app-mode";
import { refreshDesignThemes, useDesignThemes } from "@/lib/design-themes/design-themes";
import { useEnsureUiDesignPlugin } from "@/components/design-mode-gate";
import { useOnboarding } from "../onboarding-flow";
import { Notice, StepFooter, StepHeading } from "./step-parts";
import { BriefcaseIcon, CodeIcon, PaletteIcon } from "lucide-react";

/**
 * 工作模式（默认是「编码」）：全局三档，切了立刻作用于所有会话。
 * 写的是「设置 → 通用」同一份数据（set_app_mode → sidecar kv + 活动会话提示词热替换）。
 *
 * 选「设计」要走和顶栏切换器、设置页同款门禁：设计档依赖 UI 设计插件，没装就
 * 问用户装不装，通过了才切（useEnsureUiDesignPlugin）。门禁的弹窗要一并渲染出来，
 * 否则 ensure() 永远悬着。
 *
 * 内置设计主题是随产品打包的 zip，sidecar 首次用到时自动解压；这里只在用户真的
 * 选了「设计」之后才去拉清单——引导是线性流程，不该为了一个还没选的模式先发请求。
 * 解压失败要照实说，不能让用户以为主题齐了。
 */

const MODES: {
  value: AppMode;
  label: string;
  desc: string;
  icon: FC<{ className?: string }>;
}[] = [
  {
    value: "code",
    label: "编码",
    desc: "面向开发：完整工具与细节，Git 管理常驻",
    icon: CodeIcon,
  },
  {
    value: "work",
    label: "工作",
    desc: "面向日常办公：交付导向的回复风格",
    icon: BriefcaseIcon,
  },
  {
    value: "design",
    label: "设计",
    desc: "面向 UI 设计：设计稿与高保真原型优先",
    icon: PaletteIcon,
  },
];

const MODE_LABELS: Record<AppMode, string> = {
  code: "编码",
  work: "工作",
  design: "设计",
};

export const ModeStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const mode = useAppMode();
  const degraded = useAppModeDegraded();
  const { ensure, dialog } = useEnsureUiDesignPlugin();
  const themes = useDesignThemes();
  const [switching, setSwitching] = useState(false);

  const choose = async (value: AppMode) => {
    if (switching) return;
    // piRequest 在链路断开时可能**同步**抛（Tauri 的 invoke 尚未注入），.catch()
    // 根本挂不上，整个向导会被这一次点击带崩。这里兜住，失败就当没切。
    try {
      // 设计档前置门禁：插件没装/没启用时弹窗询问，通过才切
      if (value === "design") {
        setSwitching(true);
        const allowed = await ensure();
        setSwitching(false);
        if (!allowed) return;
      }
      await setAppMode(value);
    } catch {
      setSwitching(false);
      return;
    }
    patch("appMode", { done: true, summary: MODE_LABELS[value] });
    // 选了设计才去拉主题清单：引导是线性流程，不该为还没选的模式先发请求
    if (value === "design") void refreshDesignThemes();
  };

  // 选了设计档就把当前模式回报给完成清单（回到本页时以 store 为准）
  useEffect(() => {
    if (mode === "design") return; // 设计档在上面单独回报过
    patch("appMode", { done: true, summary: MODE_LABELS[mode] });
  }, [mode, patch]);

  return (
    <div className="flex flex-col">
      {dialog}
      <StepHeading
        title="平时主要拿它做什么"
        desc="全局开关，切了立刻生效于所有会话。之后在「设置 → 通用」里随时能改。"
      />

      {degraded && (
        <Notice>
          当前 sidecar 版本不支持工作模式，切换只影响界面，提示词不会跟随。
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              aria-pressed={active}
              disabled={switching}
              onClick={() => void choose(m.value)}
              className={cn(
                "hover:bg-muted/70 flex flex-col items-start gap-1.5 rounded-2xl border p-4 text-left transition-colors disabled:opacity-60",
                active ? "border-primary/40 bg-muted/60" : "border-transparent",
              )}
            >
              <m.icon className="text-muted-foreground size-4" />
              <span className="text-sm font-medium">{m.label}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">
                {m.desc}
              </span>
            </button>
          );
        })}
      </div>

      {mode === "design" && <ThemeStatus />}

      <StepFooter
        onBack={back}
        onSkip={() => {
          patch("appMode", { done: true, summary: null });
          next();
        }}
      >
        <Button onClick={next}>下一步</Button>
      </StepFooter>
    </div>
  );
};

/** 设计档下的内置主题状态：解压中 / 几套已就绪 / 解压失败照实说 */
const ThemeStatus: FC = () => {
  const { loading, builtinCount, packError } = useDesignThemes();
  if (packError) {
    return <Notice>内置设计主题解压失败：{packError}。到「设置 → 智能体 → 设计主题」可以手动重试。</Notice>;
  }
  if (loading) {
    return (
      <p className="text-muted-foreground text-xs">正在解压内置设计主题…</p>
    );
  }
  if (builtinCount > 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {"内置 "}
        {builtinCount}
        {" 套设计主题已就绪，在「设置 → 智能体 → 设计主题」里挑，或用输入框旁的主题胶囊按会话选。"}
      </p>
    );
  }
  return null;
};
