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
  {
    value: "design",
    labelKey: "onboarding.appMode.design",
    descKey: "onboarding.appMode.designDesc",
    icon: PaletteIcon,
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
  const { ensure, dialog } = useEnsureUiDesignPlugin();
  const themes = useDesignThemes();
  const [switching, setSwitching] = useState(false);

  const choose = async (value: AppMode) => {
    if (switching) return;
    // piRequest 在链路断开时可能**同步**抛（桌面壳的 invoke 尚未注入），.catch()
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
    patch("appMode", { done: true, summary: t(MODE_LABEL_KEYS[value]) });
    // 选了设计才去拉主题清单：引导是线性流程，不该为还没选的模式先发请求
    if (value === "design") void refreshDesignThemes();
  };

  // 完成清单以 store 当前值为准持续回报。不要对「设计」早退：当前已是设计档
  // （重新查看引导 / 播种值水合）时早退会让完成页显示成「未配置」或旧档位。
  useEffect(() => {
    patch("appMode", { done: true, summary: t(MODE_LABEL_KEYS[mode]) });
  }, [mode, patch, t]);

  return (
    <div className="flex flex-col">
      {dialog}
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

      {mode === "design" && <ThemeStatus />}

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

/** 设计档下的内置主题状态：解压中 / 几套已就绪 / 解压失败照实说 */
const ThemeStatus: FC = () => {
  const t = useT();
  const { loading, builtinCount, packError } = useDesignThemes();
  if (packError) {
    return (
      <Notice>
        {t("onboarding.appMode.themePackError", { error: packError })}
      </Notice>
    );
  }
  if (loading) {
    return <p className="text-muted-foreground text-xs">{t("onboarding.appMode.themeExtracting")}</p>;
  }
  if (builtinCount > 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("onboarding.appMode.themeReady", { count: builtinCount })}
      </p>
    );
  }
  return null;
};
