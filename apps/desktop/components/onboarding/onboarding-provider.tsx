"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FC,
  type ReactNode,
} from "react";

/**
 * 首次启动配置向导的开关状态：走没走过、当前展不展开。
 *
 * 挂在 page.tsx 里、同时罩住主界面和向导本身，所以设置页的「重新查看引导」
 * 与向导的「跳过」走同一个 context，不靠跨模块的可变状态通信。
 *
 * 为什么用 Provider 而不是模块级 store + useSyncExternalStore：HMR 会把模块
 * 求值成两份，一份的 setState 通知不到另一份的订阅者——表现就是「点了跳过没
 * 反应」，但刷新一下又好了。useState 随组件树走，HMR 替换不掉订阅关系。
 *
 * 完成标记仍只存 localStorage：引导是一锤子体验，重装应用重走一遍是合理的。
 * 首帧恒为 active=false（localStorage 还没读），读完再开——与 RemoteGate
 * 同样的「先 null 后实值」处理，代价是向导晚一帧淡入（overlay 本身 300ms
 * 淡入，读作刻意的开场）。
 */

const COMPLETED_KEY = "onboarding.completed.v1";

type Gate = {
  /** 向导当前是否展开 */
  active: boolean;
  /** 收起向导并记下完成标记（"完成" 与 "跳过" 共用） */
  finish: () => void;
  /** 清掉完成标记并展开（设置页「重新查看引导」） */
  reopen: () => void;
};

const OnboardingGateContext = createContext<Gate | null>(null);

export const OnboardingProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let completed = false;
    try {
      completed = window.localStorage.getItem(COMPLETED_KEY) === "1";
    } catch {
      // 隐私模式下 localStorage 可能抛错，视为没走过
    }
    setActive(!completed);
  }, []);

  const finish = useCallback(() => {
    try {
      window.localStorage.setItem(COMPLETED_KEY, "1");
    } catch {
      // 写不进去也不影响本次会话内不再弹出
    }
    setActive(false);
  }, []);

  const reopen = useCallback(() => {
    try {
      window.localStorage.removeItem(COMPLETED_KEY);
    } catch {
      // 同上
    }
    setActive(true);
  }, []);

  return (
    <OnboardingGateContext.Provider value={{ active, finish, reopen }}>
      {children}
    </OnboardingGateContext.Provider>
  );
};

/** 读向导开关；在 Provider 之外（理论上不该发生）退化为永不展开 */
export function useOnboardingGate(): Gate {
  return (
    useContext(OnboardingGateContext) ?? {
      active: false,
      finish: () => {},
      reopen: () => {},
    }
  );
}
