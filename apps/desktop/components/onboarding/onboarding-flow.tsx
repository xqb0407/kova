"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { useOnboardingGate } from "./onboarding-provider";
import { ONBOARDING_SECTIONS } from "./onboarding-sections";
import { WelcomeStep } from "./steps/welcome-step";
import { DoneStep } from "./steps/done-step";

/**
 * 首次启动的配置向导：欢迎页 → 配模型 → 选工作目录 → 调外观 → 完成页。
 *
 * 全屏浮层盖在主界面之上，桌面端顶栏留出拖拽区（data-tauri-drag-region），
 * 否则无边框窗口里用户抓不到窗口拖走。步骤间的结果存在 context 里，
 * 完成页据此做「你已配置好什么」的回顾。
 *
 * 每一步都可跳过：跳过记完成标记、不写任何配置，下次启动不再弹。
 */

/** 单个分区交回来的配置结果：配没配，以及完成清单上显示的那句话 */
export type OnboardingSectionResult = {
  done: boolean;
  summary: string | null;
};

/** 按分区 id 归档（OnboardingSections 里的 id），加分区不用改这个类型 */
export type OnboardingResults = Record<string, OnboardingSectionResult>;

const EMPTY_RESULTS: OnboardingResults = {};

type OnboardingContextValue = {
  step: number;
  results: OnboardingResults;
  /** 分区交回结果：patch(分区 id, { done, summary }) */
  patch: (id: string, next: Partial<OnboardingSectionResult>) => void;
  next: () => void;
  back: () => void;
  /** 走完：收起向导并记下完成标记 */
  finish: () => void;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/** 步骤组件通过它拿到导航与已收集的配置；外壳之外使用返回空实现（不渲染） */
export function useOnboarding(): OnboardingContextValue {
  return (
    useContext(OnboardingContext) ?? {
      step: 0,
      results: EMPTY_RESULTS,
      patch: () => {},
      next: () => {},
      back: () => {},
      finish: () => {},
    }
  );
}

/** 参与进度计数的分区数（欢迎页与完成页不计入） */
const COUNTED_STEPS = ONBOARDING_SECTIONS.length;
/** 完成页在 step 上的位置：0 欢迎页，1..N 分区，N+1 完成页 */
const DONE_STEP = COUNTED_STEPS + 1;

export const OnboardingFlow: FC = () => {
  const { active, finish } = useOnboardingGate();
  const [step, setStep] = useState(0);
  const [results, setResults] = useState<OnboardingResults>(EMPTY_RESULTS);

  const patch = useCallback(
    (id: string, next: Partial<OnboardingSectionResult>) => {
      setResults((prev) => {
        const base = prev[id] ?? { done: false, summary: null };
        return { ...prev, [id]: { ...base, ...next } };
      });
    },
    [],
  );

  // 设置里「重新查看新手引导」是重走一遍，不是接着上次那一步继续：每次浮层重新
  // 打开都回到第 0 步。首帧 active 由 false 翻到 true 也会走到这里，setStep(0)
  // 幂等，不影响首次引导。
  useEffect(() => {
    if (active) setStep(0);
  }, [active]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      step,
      results,
      patch,
      next: () => setStep((s) => Math.min(s + 1, DONE_STEP)),
      back: () => setStep((s) => Math.max(s - 1, 0)),
      finish,
    }),
    [step, results, patch, finish],
  );

  // 未展开时不渲染任何东西。展开时机由 Provider 在读完 localStorage 后决定，
  // overlay 淡入衔接，不会露出底下的应用。
  if (!active) return null;

  const desktop = isTauri();
  const isWelcome = step === 0;
  const isDone = step === DONE_STEP;
  // 0 是欢迎页，1..N 是分区，N+1 是完成页
  const Current = isWelcome
    ? WelcomeStep
    : isDone
      ? DoneStep
      : (ONBOARDING_SECTIONS[step - 1]?.Component ?? WelcomeStep);
  // 进度：分区页显示第 n/N 步
  const counted = Math.min(Math.max(step, 1), COUNTED_STEPS);

  return (
    <OnboardingContext.Provider value={value}>
      <div className="animate-in fade-in fixed inset-0 z-[60] flex flex-col bg-background duration-300">
        {/* 顶栏拖拽区：欢迎页留空（内容居中），其余步骤右侧放「跳过」。
            deep 会把整棵子树的 mousedown 劫持成窗口拖动，按钮必须显式标
            "false" 退出，否则桌面端点不动（与 agent-panel/tab-bar 同款处理）。 */}
        <div
          data-tauri-drag-region={desktop ? "deep" : undefined}
          className="flex h-11 shrink-0 items-center justify-end gap-2 px-4"
        >
          {isWelcome ? null : (
            <>
              <span className="text-muted-foreground mr-1 text-xs tabular-nums">
                {isDone ? "完成" : `第 ${counted} 步，共 ${COUNTED_STEPS} 步`}
              </span>
              {!isDone && (
                <Button
                  data-tauri-drag-region="false"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={finish}
                >
                  跳过
                </Button>
              )}
            </>
          )}
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-10">
          {/* 欢迎页是双栏版面，要比后面的单栏步骤宽 */}
          <div className={cn("w-full", isWelcome ? "max-w-3xl" : "max-w-xl")}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                <Current />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* 进度条：仅中间步骤 */}
        {!isWelcome && !isDone && (
          <div className="flex shrink-0 justify-center gap-1.5 pb-8">
            {Array.from({ length: COUNTED_STEPS }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1 rounded-full transition-all duration-300",
                  i === counted - 1 ? "bg-primary w-6" : "bg-muted w-3",
                )}
              />
            ))}
          </div>
        )}
      </div>
    </OnboardingContext.Provider>
  );
};
