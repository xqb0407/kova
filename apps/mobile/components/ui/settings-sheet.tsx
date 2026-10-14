import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { ChevronRightIcon } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { useAuiState } from "@assistant-ui/react-native";
import { useTheme, withAlpha } from "./theme";
import { Sheet } from "./sheet";
import { useRemoteConfig } from "./remote-config";
import {
  getPiChannel,
  type PiChannel,
  type PiChannelStatus,
} from "@/lib/pi/pi-channel";
import {
  setThemeMode,
  useThemeMode,
  type ThemeMode,
} from "@/lib/settings/appearance-settings";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useOnboardingGate } from "@/components/onboarding/onboarding-gate";

const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

/** JS 堆读数（Hermes：performance.memory 经 NativePerformance.getSimpleMemoryInfo；
 *  web/Chrome 也有；拿不到就返回 null，行显示「—」） */
function readJsHeap(): { used: number; total: number } | null {
  const memory = (
    globalThis.performance as unknown as
      | { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }
      | undefined
  )?.memory;
  const used = memory?.usedJSHeapSize;
  if (typeof used !== "number") return null;
  return { used, total: memory?.totalJSHeapSize ?? used };
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/** 应用版本（app.json 的 expo.version；拿不到就退回 package 版本占位） */
const appVersion = (): string => Constants.expoConfig?.version ?? "0.1.0";

const runtimeName = (): string =>
  (globalThis as { HermesInternal?: unknown }).HermesInternal ? "Hermes" : "JSC";

/** 平台串：web 下 Platform.Version 是 0.0.0（无意义），不带 */
const platformLabel = (): string =>
  Platform.OS === "web"
    ? "web"
    : `${Platform.OS} ${String(Platform.Version)}`;

/** 凭据脱敏：只露尾 4 位，够对号不入库 */
const maskToken = (token: string): string =>
  token.length > 4 ? `…${token.slice(-4)}` : "已配对";

/**
 * 设置底部抽屉。
 *
 * 外壳（暗罩、面板升起、抓手条 + 右上角关闭、下拉手势）统一由 Sheet 提供，
 * 这里只摆配置内容。面板占屏高 80%，露出的那一截就是「抽屉」的直观来源。
 *
 * 配置项只放手机端**真的能改**的东西：外观开关、重走引导、重新配对；外加一节
 * 「调试」——连接/版本/JS 堆读数与诊断信息复制，出问题时手机自己能取证。
 * 模型目录、凭据、MCP 这些在远程网关侧是 REMOTE_DENIED_TYPES，手机上只能读不能写，
 * 所以不做假入口。默认思考档位不在这里改：改档位走会话里的「模型 · 思考」胶囊
 * （桌面端的会话级/全局默认定靶在桌面设置里）。
 */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const { colors, radius, space, fontWeight } = useTheme();
  const { height } = useWindowDimensions();
  const { config, unpair } = useRemoteConfig();
  const workspace = useWorkspace();
  const themeMode = useThemeMode();
  const onboarding = useOnboardingGate();

  const sheetHeight = Math.round(height * 0.8);

  return (
    <Sheet
      onClose={onClose}
      travel={sheetHeight}
      showClose
      closeLabel="关闭设置"
      sheetStyle={{ height: sheetHeight }}
    >
      <ScrollView
        contentContainerStyle={{ padding: space(5), paddingTop: space(2), gap: space(6) }}
        showsVerticalScrollIndicator={false}
      >
        <Text
          style={{
            color: colors.foreground,
            fontSize: 22,
            fontWeight: fontWeight("700"),
            letterSpacing: -0.4,
          }}
        >
          设置
        </Text>

        {/* 外观：与引导页「挑个顺眼的样子」同一份偏好，改完即时生效 */}
        <View style={{ gap: space(2.5) }}>
          <SectionLabel>外观</SectionLabel>
          <View style={styles.chips}>
            {THEME_MODES.map((option) => (
              <Chip
                key={option.value}
                label={option.label}
                active={option.value === themeMode}
                onPress={() => setThemeMode(option.value)}
              />
            ))}
          </View>
        </View>

        {/* 只读信息：手机端改不了，也不该做成看起来能点的样子 */}
        <View style={{ gap: space(2.5) }}>
          <SectionLabel>连接</SectionLabel>
          <View
            style={[
              styles.card,
              { borderRadius: radius.xl, borderColor: colors.border },
            ]}
          >
            <InfoRow label="桌面端地址" value={config.url} mono />
            <View style={[styles.hairline, { backgroundColor: colors.border }]} />
            <InfoRow
              label="工作目录"
              value={workspace ?? "跟随桌面端设置"}
              mono={Boolean(workspace)}
            />
          </View>
        </View>

        <DebugSection config={config} />

        {/* 重走引导：与桌面端设置页「重新查看新手引导」同位。收起抽屉再展开
            浮层，不然引导页被抽屉压一半很难看。 */}
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            onboarding.reopen();
            onClose();
          }}
          style={({ pressed }) => [
            styles.unpair,
            {
              borderRadius: radius.xl,
              borderColor: colors.border,
              backgroundColor: withAlpha(colors.foreground, 0.03),
            },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text
            style={{
              color: colors.foreground,
              fontSize: 15,
              fontWeight: fontWeight("600"),
            }}
          >
            重新查看引导
          </Text>
          <ChevronRightIcon size={16} strokeWidth={2} color={colors.mutedForeground} />
        </Pressable>

        {/* 不可逆动作单独一档，红色 */}
        <Pressable
          accessibilityRole="button"
          onPress={unpair}
          style={({ pressed }) => [
            styles.unpair,
            {
              borderRadius: radius.xl,
              borderColor: withAlpha(colors.destructive, 0.35),
              backgroundColor: withAlpha(colors.destructive, 0.06),
            },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text
            style={{
              color: colors.destructive,
              fontSize: 15,
              fontWeight: fontWeight("600"),
            }}
          >
            重新配对
          </Text>
          <ChevronRightIcon size={16} strokeWidth={2} color={colors.destructive} />
        </Pressable>
      </ScrollView>
    </Sheet>
  );
}

/**
 * 调试信息（出问题时手机自己取证）：版本/平台、网关与凭据（脱敏）、连接状态、
 * JS 堆实时读数（1s 一拍，抽屉关掉即停）+ 复制诊断信息 / 立即重连两个动作。
 * 都与事实源直连：通道状态取模块级通道表，堆读数取 performance.memory，不新增状态层。
 */
function DebugSection({ config }: { config: { url: string; token: string } }) {
  const { colors, radius, space, fontWeight } = useTheme();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const workspace = useWorkspace();

  const [status, setStatus] = useState<PiChannelStatus | null>(null);
  const [channel, setChannel] = useState<PiChannel | null>(null);
  const [heap, setHeap] = useState(() => readJsHeap());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let ch: PiChannel;
    try {
      ch = getPiChannel();
    } catch {
      return; // 通道未就绪（未配对）：状态行显示「未连接」即可
    }
    setChannel(ch);
    return ch.onStatusChange?.(setStatus);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setHeap(readJsHeap()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 演示模式（mock:）没有真网关：状态行如实写「演示模式」，不去显示一个假的连接态
  const mock = config.url.startsWith("mock:");
  const connected = status?.connected === true;
  const statusText = mock
    ? "演示模式（未连桌面端）"
    : channel === null
      ? "未连接"
      : connected
        ? "已连接"
        : status?.error
          ? `未连接（${status.error}）`
          : "连接中…";

  const diagnostics = [
    `扣瓦移动端 ${appVersion()} · ${platformLabel()} · ${runtimeName()}`,
    `网关 ${config.url}`,
    `凭据 ${maskToken(config.token)}`,
    `连接 ${statusText}`,
    heap ? `JS 堆 ${formatBytes(heap.used)} / ${formatBytes(heap.total)}` : "JS 堆 —",
    `工作目录 ${workspace ?? "跟随桌面端设置"}`,
    `当前会话 ${threadId ?? "-"}`,
  ].join("\n");

  return (
    <View style={{ gap: space(2.5) }}>
      <SectionLabel>调试</SectionLabel>
      <View
        style={[
          styles.card,
          { borderRadius: radius.xl, borderColor: colors.border },
        ]}
      >
        <InfoRow
          label="版本"
          value={`${appVersion()} · ${platformLabel()} · ${runtimeName()}`}
        />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <InfoRow
          label="凭据"
          value={mock ? "演示模式" : maskToken(config.token)}
          mono={!mock}
        />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <InfoRow label="连接状态" value={statusText} />
        <View style={[styles.hairline, { backgroundColor: colors.border }]} />
        <InfoRow
          label="JS 堆（每秒刷新）"
          value={heap ? `${formatBytes(heap.used)} / ${formatBytes(heap.total)}` : "本端拿不到"}
          mono
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="复制诊断信息"
        onPress={() => {
          void Clipboard.setStringAsync(diagnostics).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
        style={({ pressed }) => [
          styles.unpair,
          {
            borderRadius: radius.xl,
            borderColor: colors.border,
            backgroundColor: withAlpha(colors.foreground, 0.03),
          },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text
          style={{ color: colors.foreground, fontSize: 15, fontWeight: fontWeight("600") }}
        >
          {copied ? "已复制" : "复制诊断信息"}
        </Text>
        <ChevronRightIcon size={16} strokeWidth={2} color={colors.mutedForeground} />
      </Pressable>

      {channel?.reconnectNow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="立即重连网关"
          onPress={() => channel.reconnectNow?.()}
          style={({ pressed }) => [
            styles.unpair,
            {
              borderRadius: radius.xl,
              borderColor: colors.border,
              backgroundColor: withAlpha(colors.foreground, 0.03),
            },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text
            style={{ color: colors.foreground, fontSize: 15, fontWeight: fontWeight("600") }}
          >
            立即重连网关
          </Text>
          <ChevronRightIcon size={16} strokeWidth={2} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}


function SectionLabel({ children }: { children: ReactNode }) {
  const { colors, space, fontWeight } = useTheme();
  return (
    <Text
      style={{
        color: colors.mutedForeground,
        fontSize: 12.5,
        fontWeight: fontWeight("600"),
        letterSpacing: 0.4,
        marginBottom: space(0.5),
      }}
    >
      {children}
    </Text>
  );
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { colors, radius, fontWeight } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderRadius: radius.md,
          borderColor: active ? "transparent" : withAlpha(colors.foreground, 0.12),
          backgroundColor: active ? colors.primary : withAlpha(colors.foreground, 0.04),
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text
        style={{
          color: active ? colors.primaryForeground : colors.foreground,
          fontSize: 13.5,
          fontWeight: fontWeight(active ? "600" : "500"),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { colors, space, fontWeight, mono: monoFamily } = useTheme();
  return (
    <View style={{ paddingHorizontal: space(3.5), paddingVertical: space(3), gap: 3 }}>
      <Text
        style={{ color: colors.mutedForeground, fontSize: 12.5, fontWeight: fontWeight("500") }}
      >
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          color: colors.foreground,
          fontSize: 14,
          fontFamily: mono ? (monoFamily ?? undefined) : undefined,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  hairline: { height: StyleSheet.hairlineWidth, marginLeft: 14 },
  unpair: {
    height: 50,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
