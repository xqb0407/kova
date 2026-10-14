import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  CameraView,
  scanFromURLAsync,
  useCameraPermissions,
} from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import * as Haptics from "expo-haptics";
import {
  CameraOffIcon,
  ImageUpIcon,
  Server,
  SettingsIcon,
} from "lucide-react-native";
import { ActionButton } from "./action-button";
import { ErrorNote } from "./error-note";
import { FieldLabel } from "./field-label";
import { LinkButton } from "./link-button";
import { AppBackground } from "./glass";
import { TypeCaret, TYPE_INTERVAL_MS } from "./type-caret";
import { fontWeight, radius, space, useTheme, withAlpha } from "./theme";
import { pairWithHost } from "@/lib/mobile/pair";
import { decodePairPayload } from "@/lib/mobile/pair-payload";
import { saveRemoteConfig, type RemoteConfig } from "@/lib/mobile/secure-store";

/**
 * 配对屏。从上到下：
 *   品牌三行（打字机 / 交给扣瓦 / 服务地址）→ ws 地址与配对码输入 → 连接 →
 *   分割线 → 扫码配对。
 * 两条连接路径：
 *   1. 手输 —— 桌面「设置 → 远程访问」里的 host + 6 位码；
 *   2. 扫码 —— 桌面二维码默认是「扫码直达链接」`http://<ip>:8787/#h=<base64url>`
 *      （无局域网预览地址时降级为裸 JSON），扫到即自动填表，解析形态见 pair-payload.ts。
 *
 * 网关是明文 ws://，配对码一次有效但换来的 token 是长效的，拿到它等于拿到
 * 那台机器的完整对话权限。这句提醒落在页脚，不占首屏。
 */

/** 打字机循环的短句。想加词就往数组里塞——顺序即轮播顺序。 */
const PHRASES = ["写代码", "写文档", "查资料", "读仓库"];

/**
 * 从相册选一张二维码图并识别。不需要相机权限（走的是系统相册选择器 +
 * expo-camera 的图片识别），是「相机权限被拒 / 懒得开相机」时的正路。
 * 注意不压缩：二维码对画质敏感，缩过头就扫不出来。
 */
export async function pickQrFromLibrary(): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error("需要相册权限才能选图");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 1,
    allowsMultipleSelection: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const hits = await scanFromURLAsync(asset.uri, ["qr"]);
  return hits[0]?.data ?? null;
}

/** 零宽空格：给空文本占位，保证行高恒定 */
const ZWSP = "\u200B";

export function ConnectScreen({
  onConnected,
  onDemo,
}: {
  onConnected: (config: RemoteConfig) => void;
  /** 演示模式入口：Mock 通道直进聊天，不触碰真实网关 */
  onDemo: () => void;
}) {
  const styles = useStyles();
  const { colors, radius } = useTheme();
  const [host, setHost] = useState("");
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, () => ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [pickingQr, setPickingQr] = useState(false);
  const [hostFocused, setHostFocused] = useState(false);
  const code = digits.join("");

  const applyPayload = (raw: string): boolean => {
    const payload = decodePairPayload(raw);
    if (!payload) return false;
    setHost(payload.host);
    setDigits(payload.code.padEnd(6, " ").trim().split(""));
    setScanned(true);
    return true;
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await pairWithHost(host, code);
      await saveRemoteConfig(config);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onConnected(config);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 相册选码：识别成功走与扫码同一条路；识别不出按用户视角报错 */
  const pickQr = () => {
    setError(null);
    setPickingQr(true);
    void pickQrFromLibrary()
      .then((raw) => {
        if (raw === null) return; // 用户取消
        if (!applyPayload(raw)) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          setError("这张图里没有识别到配对二维码");
        }
      })
      .catch((err) => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPickingQr(false));
  };

  if (scanning) {
    return (
      <CameraScanner
        onCancel={() => setScanning(false)}
        onScanned={(raw) => {
          setScanning(false);
          if (!applyPayload(raw)) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            setError("这不是配对二维码，请对准桌面端的「远程访问」窗口");
          }
        }}
      />
    );
  }

  return (
    // 与其余页面同一层磨砂底（AppBackground 默认 base）：色晕 + 薄纱在安卓上
    // 也立得住，输入件的描边有底色可对比，不再压在死白上。
    <AppBackground>
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            {/* 品牌区与表单作为一整块在剩余空间里居中。品牌区单独顶在页首、
                表单再单独居中，中间会空出一整块断层，看着像漏排版。 */}
            <View style={styles.main}>
              <Hero />
              <View style={styles.group}>
                <FieldLabel>桌面端地址 / 配对码</FieldLabel>
                <View
                  style={[
                    styles.inputShell,
                    hostFocused && styles.inputShellFocused,
                  ]}
                >
                  <Server size={18} strokeWidth={1.8} color={colors.mutedForegroundFaint} />
                  <TextInput
                    value={host}
                    onFocus={() => setHostFocused(true)}
                    onBlur={() => setHostFocused(false)}
                    onChangeText={(text) => {
                      // 粘贴二维码原文 / 扫码直达链接 / pikova:// deep link 都按载荷解
                      // （形态见 pair-payload.ts）；解不出才当普通地址继续手输
                      if (text.length > 24 && applyPayload(text)) return;
                      setHost(text);
                    }}
                    placeholder="ws://192.168.1.5:8787"
                    placeholderTextColor={colors.mutedForegroundFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    keyboardType="url"
                    style={styles.input}
                  />
                </View>
              </View>

              <View style={styles.group}>
                {/* <FieldLabel>配对码</FieldLabel> */}
                <CodeBoxes value={digits} onChange={setDigits} />
              </View>

              {scanned ? (
                <View style={styles.scannedNote}>
                  <Text style={styles.scannedText}>
                    已识别扫码内容，确认地址后点连接。
                  </Text>
                </View>
              ) : null}

              {error ? <ErrorNote>{error}</ErrorNote> : null}

              <ActionButton
                label="连接"
                onPress={() => void submit()}
                busy={busy}
                disabled={host.trim().length === 0 || code.length !== 6}
                style={[styles.primary, { borderRadius: 999 }]}
              />
            </View>

            {/* 次要入口与安全提示压在页面底部，和 iOS 的分组列表页脚一致。 */}
            <View style={styles.footer}>
              <View style={styles.divider} />
              <View style={styles.altRow}>
                <LinkButton label="扫码配对" onPress={() => setScanning(true)} />
                <LinkButton
                  label={pickingQr ? "识别中…" : "相册选码"}
                  onPress={pickQr}
                />
                {/* 演示模式：不连桌面端，用脚本化数据进聊天——验收 UI 用，
                    不落任何凭据（url 是 mock: scheme，安全存储里只存这对占位值）。 */}
                <LinkButton label="先逛逛" onPress={onDemo} />
              </View>
              <Text style={styles.footnote}>
                网关走明文 ws://，只在可信局域网（或自建隧道）内配对。配对后本机会长期保存凭据。
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AppBackground>
  );
}

/**
 * 六格配对码。跟短信验证码一个路子：单格只吃一位数字，输完自动跳下一格，
 * 退格在空格里往回跳。整串粘贴 / 系统自动填充会一次灌进多格，从当前格往下铺。
 */
function CodeBoxes({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const styles = useStyles();
  const { radius } = useTheme();
  const inputs = useRef<Array<TextInput | null>>([]);
  const [focused, setFocused] = useState(-1);
  // 焦点不能在 onChangeText 里同步调用：那一刻新值还没提交，格子的 value 仍是旧的，
  // 跳过去以后紧接着敲的下一个键会打在还没更新的格子上。挂到 value 变化后再跳。
  const pending = useRef<number | null>(null);

  useEffect(() => {
    const i = pending.current;
    if (i === null) return;
    pending.current = null;
    inputs.current[i]?.focus();
  }, [value]);

  /** 从 from 格起把 raw 里的数字依次铺进去，焦点落在最后一格之后 */
  const spread = (from: number, raw: string) => {
    const chars = raw.replace(/\D/g, "");
    if (chars.length === 0) return from;
    const next = value.map((d, i) => {
      const slot = i - from;
      return slot >= 0 && slot < chars.length ? (chars[slot] ?? "") : d;
    });
    onChange(next);
    return Math.min(from + chars.length, 5);
  };

  return (
    <View style={styles.codeRow}>
      {value.map((digit, i) => (
        <View
          key={i}
          style={[
            styles.codeCell,
            digit !== "" && styles.codeCellFilled,
            focused === i && styles.codeCellFocused,
          ]}
        >
          <TextInput
            ref={(node) => {
              inputs.current[i] = node;
            }}
            value={digit}
            onFocus={() => setFocused(i)}
            onBlur={() => setFocused((f) => (f === i ? -1 : f))}
            onChangeText={(text) => {
              if (text === "") {
                onChange(value.map((d, j) => (j === i ? "" : d)));
                return;
              }
              pending.current = spread(i, text);
            }}
            onKeyPress={(e) => {
              // 当前格已经是空的还按退格：回上一格并把它清掉，不然退不动
              if (e.nativeEvent.key === "Backspace" && value[i] === "" && i > 0) {
                onChange(value.map((d, j) => (j === i - 1 ? "" : d)));
                pending.current = i - 1;
              }
            }}
            placeholder=" "
            placeholderTextColor="transparent"
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={1}
            selectTextOnFocus
            style={styles.codeBox}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * 品牌两行：
 *   1. 打字机——循环打出 PHRASES 里的短句，打完停一拍再逐字擦掉；
 *   2. 固定文案「交给扣瓦」，压在打字机下面拼成一句完整的话。
 */
function Hero() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const [erasing, setErasing] = useState(false);

  const phrase = PHRASES[index % PHRASES.length] ?? "";

  useEffect(() => {
    const finished = erasing ? text.length === 0 : text === phrase;
    // 打完/擦完都要停一下再换挡，否则节奏是「哒哒哒哒」连成一串。
    // 出字间隔用共享常量，聊天页空态是同一个数，跨页面切换才不像两套东西
    const delay = finished ? (erasing ? 320 : 1500) : erasing ? 55 : TYPE_INTERVAL_MS;

    const timer = setTimeout(() => {
      if (finished) {
        setErasing(!erasing);
        if (erasing) setIndex((i) => (i + 1) % PHRASES.length);
        return;
      }
      setText(phrase.slice(0, text.length + (erasing ? -1 : 1)));
    }, delay);

    return () => clearTimeout(timer);
  }, [text, erasing, phrase]);

  return (
    <View style={styles.hero}>
      <View style={styles.heroLine}>
        {/* 空串在 web 上会塌成 0 高：整块品牌区随打字机每轮矮一截，下面所有
            内容跟着上移，肉眼就是持续抖动。零宽空格占住这一行。 */}
        <Text style={styles.heroType} numberOfLines={1}>
          {text || ZWSP}
        </Text>
        <TypeCaret color={colors.mutedForeground} height={24} />
      </View>
      <Text style={styles.heroBrand}>交给扣瓦</Text>
    </View>
  );
}

function CameraScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (raw: string) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // 相册选码：相机权限被拒时的正路（相册不需要相机权限）
  const [albumError, setAlbumError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const pickFromAlbum = () => {
    setAlbumError(null);
    setPicking(true);
    void pickQrFromLibrary()
      .then((raw) => {
        if (raw === null) return;
        onScanned(raw);
      })
      .catch((err) => {
        setAlbumError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPicking(false));
  };

  if (!permission) {
    return (
      <AppBackground>
        <SafeAreaView style={styles.safe}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        </SafeAreaView>
      </AppBackground>
    );
  }

  // 权限页：两种状态分开对待——
  //   还没问过（canAskAgain）→ 主按钮当场再请求一次；
  //   已被拒（设置里关掉）→ 再请求也不会弹，主按钮改为跳系统设置。
  // 相册选码不需要相机权限，作为并列入口常驻。
  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain !== false;
    return (
      // 背景与配对页同一层（AppBackground 色晕 + 薄纱）：权限页是同一流程的
      // 一部分，不该突然切到一块死白底
      <AppBackground>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <View style={[styles.center, styles.permCenter]}>
          <View style={[styles.permIcon, { backgroundColor: withAlpha(colors.foreground, 0.06) }]}>
            <CameraOffIcon size={30} strokeWidth={1.6} color={colors.mutedForeground} />
          </View>
          <View style={styles.permCopy}>
            <Text style={styles.title}>需要相机权限</Text>
            <Text style={styles.subtitle}>
              扫码配对要短暂使用摄像头识别桌面端窗口里的二维码。
              摄像头画面只在本机用于识别，不会拍摄或上传任何内容。
            </Text>
          </View>
            {albumError ? <ErrorNote>{albumError}</ErrorNote> : null}
            <View style={styles.permActions}>
              {canAskAgain ? (
                <ActionButton
                  label="开启相机权限"
                  onPress={() => void requestPermission()}
                />
              ) : (
                <ActionButton
                  label="去系统设置开启"
                  onPress={() => void Linking.openSettings()}
                />
              )}
              <ActionButton
                label={picking ? "识别中…" : "从相册选二维码"}
                variant="ghost"
                onPress={pickFromAlbum}
              />
              <ActionButton label="返回" variant="ghost" onPress={onCancel} />
            </View>
          </View>
        </SafeAreaView>
      </AppBackground>
    );
  }

  return (
    <View style={styles.flex}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onScanned(data);
        }}
      />
      <SafeAreaView style={styles.scannerOverlay} edges={["top", "bottom"]}>
        <View style={styles.scannerTopRow}>
          <Pressable onPress={onCancel} hitSlop={12} style={styles.scannerClose}>
            <Text style={styles.scannerCloseText}>取消</Text>
          </Pressable>
          <Pressable
            onPress={pickFromAlbum}
            hitSlop={12}
            style={styles.scannerClose}
            accessibilityRole="button"
            accessibilityLabel="从相册选择二维码图片"
          >
            <Text style={styles.scannerCloseText}>相册</Text>
          </Pressable>
        </View>
        {albumError ? (
          <View style={styles.scannerErrorBox}>
            <Text style={styles.scannerErrorText}>{albumError}</Text>
          </View>
        ) : null}
        <View style={styles.scannerHint}>
          <Text style={styles.scannerHintText}>
            对准桌面端「远程访问」窗口里的二维码
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

/** 玻璃件的「抬离纸面」：iOS 用 shadow 三件套。Android 不给 elevation——
 *  elevation 叠半透明背景时，系统会把背景按不透明轮廓重新合成，6% 的淡底
 *  直接变成一坨实心灰（输入框/验证码格整块发灰就是这个）。安卓的体积感由
 *  1px 描边 + 淡底自己承担。 */
const glassLift = {
  shadowColor: "#0b1020",
  shadowOpacity: 0.1,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
} as const;

function useStyles() {
  const t = useTheme();
  // 样式表跟着主题走：主题对象稳定，没切换就不该每次渲染重建一张
  return useMemo(() => {
    const { colors, radius, space, fontWeight, mono } = t;
    return StyleSheet.create({
      glassLift,
      flex: { flex: 1 },
      safe: { flex: 1 },
      center: {
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space(3),
        padding: space(6),
      },
      scroll: { padding: space(5), paddingBottom: space(6), gap: space(3), flexGrow: 1 },

      hero: { gap: space(1) },
      heroLine: { flexDirection: "row", alignItems: "center" },
      heroType: {
        color: colors.foreground,
        fontSize: 38,
        // 行高钉死：打字机行与「交给扣瓦」字号不同，不统一的话 heroLine 的
        // 高度会跟着内容和光标的高度变
        lineHeight: 42,
        fontWeight: fontWeight("700"),
        letterSpacing: -0.5,
      },
      heroBrand: {
        color: colors.mutedForeground,
        fontSize: 38,
        lineHeight: 42,
        fontWeight: fontWeight("700"),
        letterSpacing: -0.5,
      },
      group: { gap: space(1.5) },
      main: { flex: 1, justifyContent: "center", gap: space(5) },
      // 输入件：底是前景色的极淡一层，描边走 1px 淡前景线（跨平台都读得出；
      // 白描边方案只在 iOS 的投影语境里成立）。宽度钉死 1，聚焦只换色不跳格。
      inputShell: {
        flexDirection: "row",
        alignItems: "center",
        gap: space(2.5),
        height: 52,
        paddingHorizontal: space(3.5),
        backgroundColor: withAlpha(colors.foreground, 0.06),
        borderWidth: 1,
        borderColor: withAlpha(colors.foreground, 0.1),
        borderRadius: radius.pill,
        ...glassLift,
      },
      // 聚焦描边用中灰而不是 colors.ring：makeTheme 把 ring 直接映射成了强调色，
      // 浅色下就是近黑，1.5px 的黑框比浏览器默认那圈还压眼。
      inputShellFocused: {
        borderColor: withAlpha(colors.foreground, 0.22),
      },
      input: {
        flex: 1,
        minWidth: 0,
        color: colors.foreground,
        fontSize: 16,
        fontFamily: mono,
        padding: 0,
      },
      codeRow: { flexDirection: "row", gap: space(1.5) },
      // 玻璃格：与地址框同一套——淡前景底 + 1px 淡前景描边 + 投影托体积。
      codeCell: {
        flex: 1,
        // 和地址框同高 52，两个字段在视觉上是一条线
        height: 52,
        justifyContent: "center",
        backgroundColor: withAlpha(colors.foreground, 0.06),
        borderWidth: 1,
        borderColor: withAlpha(colors.foreground, 0.1),
        borderRadius: radius.pill,
        ...glassLift,
      },
      codeCellFilled: {
        backgroundColor: withAlpha(colors.foreground, 0.12),
        borderColor: withAlpha(colors.foreground, 0.16),
      },
      codeCellFocused: {
        borderColor: withAlpha(colors.foreground, 0.22),
        backgroundColor: withAlpha(colors.foreground, 0.1),
      },
      codeBox: {
        flex: 1,
        // web 上 TextInput 渲染成 <input>，自带 180px 左右的固有宽度；
        // 不给 minWidth:0，flex:1 会被这个固有宽度顶掉，六个格子直接撑爆一行。
        minWidth: 0,
        textAlign: "center",
        color: colors.foreground,
        fontSize: 22,
        fontWeight: fontWeight("600"),
        fontVariant: ["tabular-nums"],
        padding: 0,
      },
      scannedNote: {
        backgroundColor: "#4ade8018",
        borderRadius: radius.sm,
        padding: space(2.5),
      },
      scannedText: { color: colors.success, fontSize: 13 },

      primary: { minHeight: 50, borderRadius: radius.lg },

      footer: { paddingTop: space(4) },
      altRow: { flexDirection: "row", alignItems: "center", gap: space(6) },
      divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: withAlpha(colors.foreground, 0.12),
        marginBottom: space(3),
      },
      footnote: {
        color: colors.mutedForegroundFaint,
        fontSize: 11.5,
        lineHeight: 17,
        marginTop: space(3),
      },

      title: { color: colors.foreground, fontSize: 24, fontWeight: fontWeight("700") },
      subtitle: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
      scannerOverlay: {
        flex: 1,
        justifyContent: "space-between",
        padding: space(5),
      },
      permCenter: { gap: space(4), maxWidth: 320, alignSelf: "center" },
      permIcon: {
        width: 72,
        height: 72,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
      },
      permCopy: { gap: space(1.5), alignItems: "center" },
      permCopyTitle: { alignItems: "center" },
      permActions: { gap: space(2), alignSelf: "stretch" },
      scannerTopRow: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      },
      scannerErrorBox: {
        backgroundColor: "#000000aa",
        borderRadius: radius.md,
        padding: space(2.5),
        marginTop: space(3),
        alignSelf: "center",
      },
      scannerErrorText: { color: "#ffb4b4", fontSize: 13 },
      scannerClose: { alignSelf: "flex-start" },
      scannerCloseText: { color: "#fff", fontSize: 16, fontWeight: fontWeight("600") },
      scannerHint: {
        backgroundColor: "#000000aa",
        borderRadius: radius.md,
        padding: space(3),
      },
      scannerHintText: { color: "#fff", fontSize: 14, textAlign: "center" },
    });
  }, [t]);
}