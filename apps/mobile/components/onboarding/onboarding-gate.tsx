import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { syncStorage } from "@/lib/mobile/storage";

/**
 * 首次启动引导的开关状态：走没走过、当前展不展开。与桌面端
 * components/onboarding/onboarding-provider.tsx 同构。
 *
 * 差异只在存储：桌面端直接读 window.localStorage，移动端走 syncStorage 垫片
 * （键带 `pi.` 前缀才会被 hydrateStorage 捞回内存）。Provider 挂载时
 * hydrate 已经跑完（_layout 的 loading 门保证），这里同步读播种值是安全的。
 *
 * 与桌面端一样用 useState 而不是模块级 store：HMR 会把模块求值成两份，
 * 「点了没反应但刷新就好」的老坑不值得重踩。
 */

const COMPLETED_KEY = "pi.onboarding.completed.v1";

type Gate = {
  /** 引导当前是否展开 */
  active: boolean;
  /** 收起引导并记下完成标记（「开始使用」与「跳过」共用） */
  finish: () => void;
  /** 清掉完成标记并展开（设置里「重新查看引导」） */
  reopen: () => void;
};

const OnboardingGateContext = createContext<Gate | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    setActive(syncStorage.getItem(COMPLETED_KEY) !== "1");
  }, []);

  const finish = useCallback(() => {
    syncStorage.setItem(COMPLETED_KEY, "1");
    setActive(false);
  }, []);

  const reopen = useCallback(() => {
    syncStorage.removeItem(COMPLETED_KEY);
    setActive(true);
  }, []);

  return (
    <OnboardingGateContext.Provider value={{ active, finish, reopen }}>
      {children}
    </OnboardingGateContext.Provider>
  );
}

/** 读引导开关；在 Provider 之外退化为永不展开 */
export function useOnboardingGate(): Gate {
  return (
    useContext(OnboardingGateContext) ?? {
      active: false,
      finish: () => {},
      reopen: () => {},
    }
  );
}
