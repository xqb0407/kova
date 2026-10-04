import { installConnectivityLogGate } from "@/lib/pi/connectivity-noise";
import "../global.css";

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useCSSVariable, useUniwind } from "uniwind";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  clearRemoteConfig,
  loadRemoteConfig,
  type RemoteConfig,
} from "@/lib/mobile/secure-store";
import { hydrateStorage } from "@/lib/mobile/storage";
import { RuntimeProvider } from "@/components/ui/runtime-provider";
import { ConnectScreen } from "@/components/ui/connect-screen";
import { NotifyHost } from "@/components/ui/notify-host";
import { RemoteConfigProvider } from "@/components/ui/remote-config";
import { useHydrated } from "@/components/assistant-ui/elements/surfaces";
import { ThemeProvider as UiThemeProvider } from "@/components/ui/theme";
import { OnboardingProvider } from "@/components/onboarding/onboarding-gate";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { IntroSplash } from "@/components/ui/intro-splash";

/**
 * Pi 手机端入口：
 * - 未配对 → 配对屏（或「先逛逛」演示模式，mock 通道）；
 * - 已配对 → RuntimeProvider（Ws/Mock 双通道，认证失效退回配对屏）
 *   + Stack：`/` 首页（会话列表）/ `/chat` 聊天页。
 *
 * 导航栏一律自己画（headerShown: false）：配对屏、首页、聊天页三套头部形态
 * 各不相同（标题+图标组 / 搜索覆盖整行 / 返回+标题），系统 header 给不了。
 *
 * 启动序列：原生闪屏（app.json，autoHide=false）→ 首帧提交后 hideAsync，
 * 露出的是同色同位的 IntroSplash → 字标一拍 → 淡出进应用。IntroSplash 挂在
 * 包裹树最外层，loading / 配对屏 / 首页三条分支都盖得住，交接不闪白。
 */

function AppShell() {
  // 主题与变量来自 CSSOM，水合后的首次渲染才会生效
  const hydrated = useHydrated();
  const { theme } = useUniwind();
  const variables = useCSSVariable([
    "--color-background",
    "--color-foreground",
    "--color-border",
  ]);
  const [background, foreground, border] = hydrated ? variables : [];

  const base = hydrated && theme === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      background: String(background ?? base.colors.background),
      card: String(background ?? base.colors.background),
      text: String(foreground ?? base.colors.text),
      border: String(border ?? base.colors.border),
      primary: String(foreground ?? base.colors.text),
    },
  };

  return (
    <ThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: String(background ?? base.colors.background) },
          animation: "slide_from_right",
        }}
      >
        {/* 冻结失焦页：进聊天页后会话列表不再重渲/跑定时器，返回时反向同样
            （react-native-screens 4 原生支持，无需额外原生依赖） */}
        <Stack.Screen name="index" options={{ freezeOnBlur: true }} />
        <Stack.Screen name="chat" options={{ freezeOnBlur: true }} />
      </Stack>
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
    </ThemeProvider>
  );
}

// 连接类 console 噪声闸门：早于任何请求装配（RN 开发构建会把
// console.error/warn 弹成 LogBox 底部条，见 lib/pi/connectivity-noise）
installConnectivityLogGate();

export default function RootLayout() {
  const [config, setConfig] = useState<RemoteConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // 先水合 syncStorage（AsyncStorage → 内存 Map），再读凭据、再挂运行时。
    // 顺序不能反：app-mode / pi-resume-storage / pinned-threads 都在模块加载或
    // 首次读取时同步取播种值，hydrate 没跑完就是空 Map——表现为断链时工作模式
    // 回落到默认档、在飞流登记丢失、置顶会话清空（storage.ts 文件头的不变式）。
    void hydrateStorage()
      .catch(() => {
        /* 水合失败只丢本地播种，不能因此卡在启动页出不去 */
      })
      .then(() => loadRemoteConfig())
      .then((loaded) => {
        if (cancelled) return;
        // web 调试口：/?demo=1 直进演示模式（不落盘），供无头渲染与验收
        if (
          !loaded &&
          Platform.OS === "web" &&
          window.location.search.includes("demo=1")
        ) {
          setConfig({ url: "mock://local", token: "mock-demo-token" });
          return;
        }
        setConfig(loaded);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onFatal = useCallback((reason: string) => {
    console.warn("[remote] 需要重新配对：", reason);
    void clearRemoteConfig().finally(() => setConfig(null));
  }, []);

  const [introDone, setIntroDone] = useState(false);
  const onIntroDone = useCallback(() => setIntroDone(true), []);

  // 原生闪屏 autoHide=false（app.json）：交还时机由这里定——effect 在首帧
  // 提交后执行，此刻 IntroSplash 已铺满全屏且与闪屏同色同位，hideAsync
  // 淡出读作一次交接而不是闪屏。旧构建（autoHide 还开着）这里是无害的 no-op。
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);

  // 引导浮层与配对屏/首页并列渲染（OnboardingFlow 自己绝对铺满、不展开时
  // 返回 null）：首启盖住配对屏，走完露出配对屏；已配对时从设置「重新查看
  // 引导」再展开，盖住首页。
  return (
    <UiThemeProvider>
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          {loading ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator />
            </View>
          ) : !config ? (
            <OnboardingProvider>
              <ConnectScreen
                onConnected={setConfig}
                onDemo={() =>
                  setConfig({ url: "mock://local", token: "mock-demo-token" })
                }
              />
              <OnboardingFlow />
            </OnboardingProvider>
          ) : (
            <OnboardingProvider>
              <RuntimeProvider config={config} onFatal={onFatal}>
                <RemoteConfigProvider
                  value={{ config, unpair: () => void clearRemoteConfig().then(() => setConfig(null)) }}
                >
                  <AppShell />
                </RemoteConfigProvider>
                <NotifyHost />
              </RuntimeProvider>
              <OnboardingFlow />
            </OnboardingProvider>
          )}
          {!introDone && <IntroSplash onDone={onIntroDone} />}
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </UiThemeProvider>
  );
}