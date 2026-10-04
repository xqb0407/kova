import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react-native";
import { useThreadListItemDelete } from "@assistant-ui/core/react";
import { SquarePenIcon } from "lucide-react-native";
import type { FC } from "react";
import { Alert, Text, View } from "react-native";
import * as Haptics from "expo-haptics";

export const ThreadList: FC = () => (
  <ThreadListPrimitive.Root className="aui-thread-list-root flex-1">
    <ThreadListNew />
    <Text className="aui-thread-list-heading text-muted-foreground px-5 pt-3 pb-1.5 text-xs font-medium">
      Recent
    </Text>
    <ThreadListPrimitive.Items
      renderItem={() => <ThreadListItem />}
      className="aui-thread-list-items flex-1"
      contentContainerClassName="pb-2"
      showsVerticalScrollIndicator={false}
    />
  </ThreadListPrimitive.Root>
);

const ThreadListNew: FC = () => {
  const isActive = useAuiState(
    (s) => s.threads.newThreadId === s.threads.mainThreadId,
  );

  return (
    <ThreadListPrimitive.New
      className={cn(
        "aui-thread-list-new active:bg-muted mx-2 mb-1 h-10 flex-row items-center gap-2.5 rounded-lg px-3",
        isActive && "bg-muted",
      )}
    >
      <Icon as={SquarePenIcon} className="text-foreground size-[18px]" />
      <Text className="text-foreground text-[15px] font-medium">New chat</Text>
    </ThreadListPrimitive.New>
  );
};

/**
 * Pi 附加（vendored 改动）：删除必须二次确认——delete_thread 会删掉桌面端
 * 的 .jsonl 转录，长按弹 Alert，确认后走 core 的 useThreadListItemDelete。
 * 官方 ThreadListItemPrimitive.Delete 的 onPress 固定直删、无法拦截。
 */
const ThreadListItem: FC = () => {
  const isActive = useAuiState(
    (s) => s.threads.mainThreadId === s.threadListItem.id,
  );
  const isRunning = useAuiState((s) =>
    s.threads.threadItems.some(
      (item) => item.id === s.threadListItem.id && item.isRunning,
    ),
  );
  const { delete: deleteThread } = useThreadListItemDelete();

  const confirmDelete = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      "删除这个对话？",
      "转录文件会一并删除，无法恢复。桌面端的这个对话也会消失。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            void deleteThread();
          },
        },
      ],
    );
  };

  return (
    <ThreadListItemPrimitive.Root>
      <ThreadListItemPrimitive.Trigger
        className={cn(
          "aui-thread-list-item active:bg-muted mx-2 min-h-[44px] justify-center rounded-lg px-3",
          isActive && "bg-muted",
        )}
        onLongPress={confirmDelete}
        accessibilityHint="长按可删除"
      >
        <View className="flex-1 flex-row items-center justify-between gap-2">
          <Text
            numberOfLines={1}
            className={cn(
              "aui-thread-list-item-title text-foreground flex-1 text-[15px]",
              isActive && "font-semibold",
            )}
          >
            <ThreadListItemPrimitive.Title fallback="未命名对话" />
          </Text>
          {isRunning ? (
            <View className="h-2 w-2 rounded-full bg-primary" />
          ) : null}
        </View>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
};
