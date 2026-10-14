import { createContext, useContext } from "react";

/**
 * 引导向导的导航与结果收集 context。
 *
 * 单独成文件是为了拆掉「flow ↔ steps」的 require 循环：steps 要用
 * useOnboarding()，flow 又要渲染 steps，两边互相 import 在 Metro 下会报
 * 循环依赖警告（真机偶发 undefined 导出）。桌面端同款结构也有这个问题，
 * 这里从源头断开：context 谁都能引，引它不再牵出 flow。
 */

/** 单个分区交回来的配置结果：配没配，以及完成清单上显示的那句话 */
export type OnboardingSectionResult = {
  done: boolean;
  summary: string | null;
};

/** 按分区 id 归档（onboarding-sections 里的 id），加分区不用改这个类型 */
export type OnboardingResults = Record<string, OnboardingSectionResult>;

export const EMPTY_RESULTS: OnboardingResults = {};

export type OnboardingContextValue = {
  step: number;
  results: OnboardingResults;
  /** 分区交回结果：patch(分区 id, { done, summary }) */
  patch: (id: string, next: Partial<OnboardingSectionResult>) => void;
  next: () => void;
  back: () => void;
  /** 走完：收起向导并记下完成标记 */
  finish: () => void;
};

export const OnboardingContext = createContext<OnboardingContextValue | null>(null);

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
