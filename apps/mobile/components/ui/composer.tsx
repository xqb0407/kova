import { useCallback, useMemo, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react-native";
// useComposerSend 不由 @assistant-ui/react-native 转出（它只转出原生化的
// primitive 组件），但 hook 本身是 DOM 无关的，直接从 core/react 取——
// ComposerPrimitive.Send 内部也是调它。
import { useComposerSend } from "@assistant-ui/core/react";
import * as Haptics from "expo-haptics";
import { fontWeight, radius, space, useTheme } from "./theme";
import { GlassSurface } from "./glass";
import { pickImageAttachment } from "@/lib/attachments/mobile-attachments";
import { usePiQueue, usePiRuntimeExtras } from "@/lib/pi/pi-runtime";

/**
 * 输入区。
 *
 * 发送按钮的双形态是这一屏的核心：空闲时发送，运行中变成停止。停止走
 * PiRuntimeExtras.cancel —— 注意这是**全局**中断，会连带打断桌面端正在跑的
 * 那一轮（Pi 的 abort 以 sessionId 为键，手机和桌面看到的是同一个 agent）。
 * 所以按钮旁必须写明，否则用户以为只是"停了手机这边的打字"。
 */
export function Composer() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [attachError, setAttachError] = useState<string | null>(null);
  const extras = usePiRuntimeExtras();
  const aui = useAui();

  const attach = useCallback(
    async (source: "library" | "camera") => {
      setAttachError(null);
      try {
        const attachment = await pickImageAttachment(source);
        if (!attachment) return;
        await aui.composer.addAttachment(attachment);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    },
    [aui],
  );


  return (
    <GlassSurface thickness="regular" level={66} radius={0} bordered={false} style={styles.wrap}>
      <ComposerAttachments />
      {attachError ? <Text style={styles.attachError}>{attachError}</Text> : null}
      <QueueBar />
      <View style={styles.row}>
        <Pressable
          onPress={() => void attach("library")}
          hitSlop={8}
          style={styles.iconButton}
          accessibilityLabel="添加图片"
        >
          <Text style={styles.iconGlyph}>＋</Text>
        </Pressable>
        <Pressable
          onPress={() => void attach("camera")}
          hitSlop={8}
          style={styles.iconButton}
          accessibilityLabel="拍照"
        >
          <Text style={styles.iconGlyph}>◉</Text>
        </Pressable>

        <ComposerPrimitive.Input
          placeholder="给助手发消息…"
          placeholderTextColor={colors.mutedForegroundFaint}
          style={styles.input}
          multiline
          submitMode="none"
          accessibilityLabel="消息输入框"
        />

        <SendOrStop />
      </View>
      {extras.compaction.active ? (
        <Text style={styles.notice}>上下文压缩中…</Text>
      ) : extras.retry.active ? (
        <Text style={styles.notice}>自动重试中（第 {extras.retry.attempt} 次）…</Text>
      ) : null}

    </GlassSurface>
  );
}

/** 附件缩略图行：点 × 移除。
 *  移除走 composer 的 attachment 作用域（aui.composer.attachment({index}).remove()）。 */
function ComposerAttachments() {
  const styles = useStyles();
  const attachments = useAuiState(({ thread }) => thread.composer.attachments);
  const aui = useAui();

  if (attachments.length === 0) return null;
  return (
    <View style={styles.attachments}>
      {attachments.map((attachment, index) => (
        <Pressable
          key={attachment.id}
          onPress={() => {
            void aui.composer.attachment({ index }).remove();
          }}
          style={styles.attachmentChip}
          accessibilityLabel={`移除附件 ${attachment.name}`}
        >
          <AttachmentThumb attachment={attachment} />
          <Text style={styles.attachmentRemove}>×</Text>
        </Pressable>
      ))}
    </View>
  );
}

function AttachmentThumb({
  attachment,
}: {
  attachment: { name: string; content?: readonly { type: string; image?: unknown }[] };
}) {
  const styles = useStyles();
  const uri = attachment.content?.find((c) => c.type === "image")?.image;
  if (typeof uri === "string") {
    return <Image source={{ uri }} style={styles.attachmentThumb} />;
  }
  return <Text style={styles.attachmentName}>{attachment.name}</Text>;
}

/**
 * 发送 / 停止。
 *
 * 运行时在跑的时候两个按钮同时在：发送（steer，并入本轮）与停止。Pi 支持
 * 队列，所以运行中 composer.canSend 仍可能为真，useComposerSend 的 disabled
 * 也不会把它按下去——发出去的那条会被引擎插进当前轮，而不是排在后面干等。
 *
 * 停止走 PiRuntimeExtras.cancel，注意这是**全局**中断：Pi 的 abort 以 sessionId
 * 为键，手机和桌面看到的是同一个 agent，所以会连带打断桌面端正在跑的那一轮。
 * 按钮的 accessibilityHint 必须写明，否则用户以为只是"停了手机这边的打字"。
 */
function SendOrStop() {
  const styles = useStyles();
  const { send, disabled: sendDisabled } = useComposerSend();
  const canCancel = useAuiState(({ thread }) => thread.composer.canCancel);
  const extras = usePiRuntimeExtras();

  return (
    <View style={styles.actions}>
      {canCancel ? (
        <>
          <Pressable
            disabled={sendDisabled}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              send();
            }}
            accessibilityLabel="并入本轮"
            accessibilityHint="不打断当前回合，插进正在跑的这一轮里"
            style={({ pressed }) => [
              styles.sendButton,
              sendDisabled && styles.sendButtonDisabled,
              pressed && styles.sendButtonPressed,
            ]}
          >
            <Text style={styles.sendGlyph}>↑</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              void extras.cancel();
            }}
            style={[styles.sendButton, styles.stopButton]}
            accessibilityLabel="停止生成"
            accessibilityHint="会同时停止桌面端正在跑的这一轮"
          >
            <View style={styles.stopGlyph} />
          </Pressable>
        </>
      ) : (
        <Pressable
          disabled={sendDisabled}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            send();
          }}
          style={({ pressed }) => [
            styles.sendButton,
            sendDisabled && styles.sendButtonDisabled,
            pressed && !sendDisabled && styles.sendButtonPressed,
          ]}
          accessibilityLabel="发送"
        >
          <Text style={styles.sendGlyph}>↑</Text>
        </Pressable>
      )}
    </View>
  );
}

/** 队列条：运行中发出的消息排在 sidecar 队列里，可逐条撤销 */
export function QueueBar() {
  const styles = useStyles();
  const { queue, cancel } = usePiQueue();
  const items = [...queue.steering, ...queue.followUp];
  if (items.length === 0) return null;

  return (
    <View style={styles.queue}>
      <Text style={styles.queueTitle}>排队中 {items.length} 条</Text>
      {items.map((item) => (
        <View key={item.id} style={styles.queueItem}>
          <Text style={styles.queueText} numberOfLines={1}>
            {item.content}
          </Text>
          <Pressable
            onPress={() => void cancel(item.id)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`撤销排队消息：${item.content}`}
          >
            <Text style={styles.queueCancel}>撤销</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function useStyles() {
  const t = useTheme();
  // 样式表跟着主题走：主题对象稳定，没切换就不该每次渲染重建一张
  return useMemo(() => {
    const { colors, radius, space, fontWeight, mono } = t;
    return StyleSheet.create({
      wrap: {
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingHorizontal: space(3),
        paddingTop: space(2),
        gap: space(2),
      },
      row: { flexDirection: "row", alignItems: "flex-end", gap: space(2) },
      iconButton: {
        width: 36,
        height: 36,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.muted,
      },
      iconGlyph: { color: colors.mutedForeground, fontSize: 18, lineHeight: 20 },
      input: {
        flex: 1,
        minHeight: 36,
        maxHeight: 132,
        backgroundColor: colors.background,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        paddingHorizontal: space(3.5),
        paddingTop: space(2),
        paddingBottom: space(2),
        color: colors.foreground,
        fontSize: 15,
        lineHeight: 21,
      },
      sendButton: {
        width: 36,
        height: 36,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.sidebarPrimary,
      },
      sendButtonPressed: { opacity: 0.75 },
      sendButtonDisabled: { opacity: 0.35 },
      actions: { flexDirection: "row", gap: space(1.5) },
      sendGlyph: { color: "#fff", fontSize: 17, fontWeight: fontWeight("700"), lineHeight: 20 },
      stopButton: { backgroundColor: colors.destructive },
      stopGlyph: { width: 13, height: 13, borderRadius: 2, backgroundColor: "#fff" },
      attachments: { flexDirection: "row", flexWrap: "wrap", gap: space(2) },
      attachmentChip: { position: "relative" },
      attachmentThumb: {
        width: 60,
        height: 60,
        borderRadius: radius.sm,
        backgroundColor: colors.muted,
      },
      attachmentName: { color: colors.mutedForeground, fontSize: 12, maxWidth: 120 },
      attachmentRemove: {
        position: "absolute",
        top: -6,
        right: -6,
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: colors.background,
        color: colors.foreground,
        textAlign: "center",
        lineHeight: 19,
        fontSize: 15,
        overflow: "hidden",
      },
      attachError: { color: colors.destructive, fontSize: 12 },
      queue: {
        backgroundColor: colors.muted,
        borderRadius: radius.sm,
        padding: space(2.5),
        gap: space(1),
      },
      queueTitle: {
        color: colors.mutedForeground,
        fontSize: 11.5,
        textTransform: "uppercase",
        letterSpacing: 0.6,
      },
      queueItem: { flexDirection: "row", alignItems: "center", gap: space(2) },
      queueText: { flex: 1, color: colors.foreground, fontSize: 13 },
      queueCancel: { color: colors.destructive, fontSize: 12 },
      notice: { color: colors.warning, fontSize: 12, textAlign: "center" },
    });
  }, [t]);
};
