import { AppRuntimeProvider } from "@/components/runtime/app-runtime-provider";
import { Base } from "@/components/agent-thread/base";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";

export default function Page() {
  return (
    <main className="h-dvh overflow-hidden">
      <AppRuntimeProvider>
        {/* 首次启动配置向导的开关 Provider 必须同时罩住主界面与向导：
            设置页的「重新查看引导」和向导的「跳过」通过它通信。 */}
        <OnboardingProvider>
          {/* Base 本体就调 useAui/useAuiState（assistant-ui store 桥接），
              base.tsx 内部的「主区」边界罩不到它自己的 hook 渲染——运行时层
              一崩就穿透到整页 error.tsx（用户看到全屏崩溃页）。这里兜底：
              崩了只塌主区并可重试（运行时还活着，sidecar 在跑的任务不受
              影响，重试重挂后照常续上），不再整页白屏。
              向导单独一层：它崩不该把聊天界面一起换成崩溃页。 */}
          <ErrorBoundary label="主界面">
            <Base />
          </ErrorBoundary>
          {/* 向导盖在主界面之上，完成标记存 localStorage，走完或跳过后自行
              卸载。必须挂在 AppRuntimeProvider 里面——它要经 piRequest 跟
              sidecar 说话（服务商清单、凭据、模型目录）。 */}
          <ErrorBoundary label="引导向导">
            <OnboardingFlow />
          </ErrorBoundary>
        </OnboardingProvider>
      </AppRuntimeProvider>
    </main>
  );
}
