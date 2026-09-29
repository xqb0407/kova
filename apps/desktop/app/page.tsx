import { AppRuntimeProvider } from "@/components/runtime/app-runtime-provider";
import { Base } from "@/components/agent-thread/base";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { OnboardingProvider } from "@/components/onboarding/onboarding-provider";

export default function Page() {
  return (
    <main className="h-dvh overflow-hidden">
      <AppRuntimeProvider>
        {/* 首次启动配置向导的开关 Provider 必须同时罩住主界面与向导：
            设置页的「重新查看引导」和向导的「跳过」通过它通信。 */}
        <OnboardingProvider>
          <Base />
          {/* 向导盖在主界面之上，完成标记存 localStorage，走完或跳过后自行
              卸载。必须挂在 AppRuntimeProvider 里面——它要经 piRequest 跟
              sidecar 说话（服务商清单、凭据、模型目录）。 */}
          <OnboardingFlow />
        </OnboardingProvider>
      </AppRuntimeProvider>
    </main>
  );
}
