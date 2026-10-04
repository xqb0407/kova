import "../global.css";

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
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

/**
 * Pi 手机端入口：
 * - 未配对 → 配对屏（或「先逛逛」演示模式，mock 通道）；
 * - 已配对 → RuntimeProvider（Ws/Mock 双通道，认证失效退回配对屏）
 *   + Stack：`/` 首页（会话列表）/ `/chat` 聊天页。
 *
 * 导航栏一律自己画（headerShown: false）：配对屏、首页、聊天页三套头部形态
 * 各不相同（标题+图标组 / 搜索覆盖整行 / 返回+标题），系统 header 给不了。
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
      />
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
    </ThemeProvider>
  );
}

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

  if (loading) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      </SafeAreaProvider>
    );
  }

  if (!config) {
    return (
      <UiThemeProvider>
        <SafeAreaProvider>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <ConnectScreen
              onConnected={setConfig}
              onDemo={() =>
                setConfig({ url: "mock://local", token: "mock-demo-token" })
              }
            />
          </GestureHandlerRootView>
        </SafeAreaProvider>
      </UiThemeProvider>
    );
  }

  return (
    <UiThemeProvider>
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <RuntimeProvider config={config} onFatal={onFatal}>
            <RemoteConfigProvider
              value={{ config, unpair: () => void clearRemoteConfig().then(() => setConfig(null)) }}
            >
              <AppShell />
            </RemoteConfigProvider>
            <NotifyHost />
          </RuntimeProvider>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </UiThemeProvider>
  );
}