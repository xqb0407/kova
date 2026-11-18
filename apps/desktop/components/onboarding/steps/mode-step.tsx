"use client";

import { useEffect, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  setAppMode,
  useAppMode,
  useAppModeDegraded,
  type AppMode,
} from "@/lib/pi/app-mode";
import { useOnboarding } from "../onboarding-flow";
import { Notice, StepFooter, StepHeading } from "./step-parts";
import { BriefcaseIcon, CodeIcon } from "lucide-react";

/**
 * 工作模式（默认是「编码」）：全局两档（编码 / 办公），切了立刻作用于所有会话。
 * 写的是「设置 → 通用」同一份数据（set_app_mode → sidecar kv + 活动会话提示词热替换）。
 *
 * 文案只存词典 key（MODES/MODE_LABEL_KEYS），渲染时经 t 解析——完成清单的
 * summary 也在渲染点拿当前语言的档位名，切语言后回顾清单跟着换。
 */

const MODES: {
  value: AppMode;
  labelKey: string;
  descKey: string;
  icon: FC<{ className?: string }>;
}[] = [
  {
    value: "code",
    labelKey: "onboarding.appMode.code",
    descKey: "onboarding.appMode.codeDesc",
    icon: CodeIcon,
  },
  {
    value: "work",
    labelKey: "onboarding.appMode.work",
    descKey: "onboarding.appMode.workDesc",
    icon: BriefcaseIcon,
  },
];

const MODE_LABEL_KEYS: Record<AppMode, string> = {
  code: "onboarding.appMode.code",
  work: "onboarding.appMode.work",
  design: "onboarding.appMode.design",
};

export const ModeStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const t = useT();
  const mode = useAppMode();
  const degraded = useAppModeDegraded();
  const [switching, setSwitching] = useState(false);

  const choose = async (value: AppMode) => {
    if (switching) return;
    // piRequest 在链路断开时可能**同步**抛（桌面壳的 invoke 尚未注入），.catch()
    // 根本挂不上，整个向导会被这一次点击带崩。这里兜住，失败就当没切。
    try {
      await setAppMode(value);
    } catch {
      setSwitching(false);
      return;
    }
    patch("appMode", { done: true, summary: t(MODE_LABEL_KEYS[value]) });
  };

  // 完成清单以 store 当前值为准持续回报。不要对当前档早退：重新查看引导 /
  // 播种值水合时早退会让完成页显示成「未配置」或旧档位。
  useEffect(() => {
    patch("appMode", { done: true, summary: t(MODE_LABEL_KEYS[mode]) });
  }, [mode, patch, t]);

  return (
    <div className="flex flex-col">
      <StepHeading
        title={t("onboarding.appMode.title")}
        desc={t("onboarding.appMode.desc")}
      />

      {degraded && <Notice>{t("onboarding.appMode.noticeDegraded")}</Notice>}

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
              <span className="text-sm font-medium">{t(m.labelKey)}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">
                {t(m.descKey)}
              </span>
            </button>
          );
        })}
      </div>

      <StepFooter
        onBack={back}
        onSkip={() => {
          patch("appMode", { done: true, summary: null });
          next();
        }}
      >
        <Button onClick={next}>{t("common.action.next")}</Button>
      </StepFooter>
    </div>
  );
};
