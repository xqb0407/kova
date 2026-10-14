import {
  ComposerAttachments,
  pickComposerImages,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import {
  groupedIconButtonHitSlop,
  iconButtonClassName,
  iconButtonHitSlop,
} from "@/components/assistant-ui/elements/icon-button";
import { File } from "@/components/assistant-ui/elements/file";
import { Image } from "@/components/assistant-ui/elements/image";
import { ImageDataUI } from "@/components/assistant-ui/elements/image-data";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import {
  ShimmerLabel,
  textButtonHitSlop,
  useAnnounce,
  useHydrated,
  webLiveRegion,
} from "@/components/assistant-ui/elements/surfaces";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback";
import { ComposerPlusMenu } from "@/components/ui/composer-plus-menu";
import { matchTrigger } from "@/components/ui/composer-commands";
import { TypingIndicator } from "@/components/assistant-ui/elements/typing-indicator";
import { GlassControl } from "@/components/ui/glass";
import { Icon } from "@/components/ui/icon";
import { Sheet } from "@/components/ui/sheet";
import { pickImageAttachment } from "@/lib/attachments/mobile-attachments";
import * as Haptics from "expo-haptics";
import {
  addComposerChip,
  nextComposerChipId,
  parseDirective,
  removeComposerChip,
  splitMessageDirectives,
  useComposerChips,
} from "@/lib/pi/composer-chips";
import {
  focusComposerInput,
  useRegisterComposerInput,
} from "@/lib/pi/composer-focus";
import { dismissKeyboard } from "@/components/ui/dismiss-tap";
import { usePiQueue } from "@/lib/pi/pi-runtime";
import {
  collectProcessTexts,
  getTurnTiming,
  noteTurnEnd,
  noteTurnStart,
  resolveTurnTimingWrite,
  restartTurnTiming,
  scopedTurnKey,
  useTurnDurationMs,
} from "@/lib/panels/turn-collapse";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type TextMessagePartComponent,
  type ThreadMessage,
  type ToolCallMessagePartComponent,
  type GroupByContext,
  groupPartByType,
  useAui,
  useAuiState,
} from "@assistant-ui/react-native";
import * as Clipboard from "expo-clipboard";
import {
  ArrowUpIcon,
  AudioLinesIcon,
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  MicIcon,
  PhoneIcon,
  RefreshCwIcon,
} from "lucide-react-native";
import {
  type ComponentRef,
  type ComponentType,
  createContext,
  type FC,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AccessibilityInfo,
  type FlatList,
  type FlatListProps,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  /** Pi 附加（vendored 改动）：整个 composer 的覆盖位——Pi 需要队列条、
   *  并入/停止双键与压缩重试提示，默认 Composer 不承载这些。 */
  Composer?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  /** Renders tool calls that carry a nested conversation and have no registered UI; without it they render like any other tool call. */
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
  /** Replaces the text input of both the new message composer and the edit composer; read `composer.type` to tell them apart. */
  ComposerInput?: ComponentType | undefined;
  /** Pi 附加（vendored 改动）：渲染在 composer 内部、「＋」按钮右边的一条横向内容
   *  （模型 / 权限 / 思考）。放进 shell 里而不是 aboveComposer，这排选择器就不再是
   *  浮在输入条上方、跟输入框分属两块的东西。宽度不够时它自己横滑。
   *
   *  这里存**节点**而不是组件：这排胶囊的状态（当前模型、抽屉开关）住在页面
   *  那一层，若改成组件就得在 composer 里重新取一遍，等于另起一份 state，
   *  点胶囊时抽屉永远开不起来。 */
  ComposerToolbar?: React.ReactNode;
  /** Overlays the message list, which keeps a gutter free along its left edge for it; it reads the list through `useThreadViewport`. Mounting or unmounting it remounts the list. */
  Rail?: ComponentType | undefined;
};

export type ThreadHistory = {
  /** Whether messages older than the loaded window exist. */
  readonly hasMore: boolean;
  /** Whether a page of older messages is on its way. */
  readonly isLoadingMore: boolean;
  /** Loads the next page of older messages above the window. */
  readonly loadMore: () => void;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  /** A windowed thread: the list asks for older messages when it reaches its start and shows the loading edge above them. */
  history?: ThreadHistory | undefined;
  /** Pi 附加（vendored 改动）：free-standing 提问卡等，渲染在 composer 上方 */
  aboveComposer?: React.ReactNode;
};

export type ThreadViewportSnapshot = {
  /** The ids of the messages on screen, in list order. */
  readonly visibleMessageIds: readonly string[];
  /**
   * Zero until the list is within one screenful of its end, then the share of
   * that stretch scrolled, so a reading line placed at this fraction of the
   * viewport can still reach the final turns.
   */
  readonly descent: number;
  /** The message list's height. */
  readonly height: number;
  /** The message list's offset from the top of the thread viewport, which grows while the history edge shows. */
  readonly top: number;
};

export type ThreadViewport = ThreadViewportSnapshot & {
  /** Scrolls the message list until the message starts at the top of the viewport. */
  readonly scrollToMessage: (id: string) => void;
};

type ThreadViewportStore = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ThreadViewportSnapshot;
  readonly scrollToMessage: (id: string) => void;
};

const EMPTY_COMPONENTS: ThreadComponents = {};
const EMPTY_IDS: readonly string[] = [];
const IDLE_VIEWPORT: ThreadViewportSnapshot = {
  visibleMessageIds: EMPTY_IDS,
  descent: 0,
  height: 0,
  top: 0,
};
const MESSAGE_VIEWABILITY = {
  minimumViewTime: 0,
  viewAreaCoveragePercentThreshold: 0,
};
type ViewabilityInfo = Parameters<
  NonNullable<FlatListProps<ThreadMessage>["onViewableItemsChanged"]>
>[0];
const SCROLL_RETRY_DELAY = 100;

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

const ThreadViewportContext = createContext<ThreadViewportStore>({
  subscribe: () => () => {},
  getSnapshot: () => IDLE_VIEWPORT,
  scrollToMessage: () => {},
});

const createViewportStore = () => {
  const listeners = new Set<() => void>();
  let snapshot = IDLE_VIEWPORT;

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    publish: (next: Partial<ThreadViewportSnapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
};

/** What the thread's message list shows right now, for an element that overlays it. */
export const useThreadViewport = (): ThreadViewport => {
  const { subscribe, getSnapshot, scrollToMessage } = useContext(
    ThreadViewportContext,
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => ({ ...snapshot, scrollToMessage }),
    [snapshot, scrollToMessage],
  );
};

const copyToClipboard = async (text: string) => {
  await Clipboard.setStringAsync(text);
};

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  history,
  aboveComposer,
}) => {
  const aui = useAui();
  const isEmpty = useAuiState(isNewChatView);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const insets = useSafeAreaInsets();
  const viewportRef = useRef<ComponentRef<typeof View>>(null);
  const [viewportTop, setViewportTop] = useState(0);
  const [store] = useState(createViewportStore);
  const listRef = useRef<FlatList<ThreadMessage>>(null);
  const metricsRef = useRef({
    contentHeight: 0,
    viewportHeight: 0,
    scrollY: 0,
  });
  const jumpRef = useRef<
    | {
        id: string;
        retried: boolean;
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    | undefined
  >(undefined);
  const { Rail } = components;

  useEffect(() => () => clearTimeout(jumpRef.current?.timer), []);

  const jumpTo = useCallback(
    (id: string) => {
      const index = aui.thread
        .getState()
        .messages.findIndex((message) => message.id === id);
      if (index === -1) return;
      listRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: 0,
      });
    },
    [aui],
  );

  const scrollToMessage = useCallback(
    (id: string) => {
      clearTimeout(jumpRef.current?.timer);
      jumpRef.current = { id, retried: false, timer: undefined };
      jumpTo(id);
    },
    [jumpTo],
  );

  // The list cannot scroll to a row it has not laid out yet: an instant jump
  // to the estimated offset gets it rendering near the row, and one retry,
  // resolved by id again so a changed list cannot send it to another turn,
  // lands on the row itself.
  const onScrollToIndexFailed = useCallback(
    ({
      index,
      averageItemLength,
    }: {
      index: number;
      averageItemLength: number;
    }) => {
      listRef.current?.scrollToOffset({
        offset: index * averageItemLength,
        animated: false,
      });
      const jump = jumpRef.current;
      if (!jump || jump.retried) return;
      jump.retried = true;
      jump.timer = setTimeout(() => jumpTo(jump.id), SCROLL_RETRY_DELAY);
    },
    [jumpTo],
  );

  const publishDescent = useCallback(() => {
    const { contentHeight, viewportHeight, scrollY } = metricsRef.current;
    const remaining = contentHeight - viewportHeight - scrollY;
    const descent =
      viewportHeight > 0
        ? Math.round(
            Math.min(
              1,
              Math.max(0, (viewportHeight - remaining) / viewportHeight),
            ) * 100,
          ) / 100
        : 0;
    if (descent !== store.getSnapshot().descent) store.publish({ descent });
  }, [store]);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: ViewabilityInfo) => {
      store.publish({
        visibleMessageIds: viewableItems.map((token) => token.item.id),
      });
    },
    [store],
  );

  const onListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      metricsRef.current = {
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        scrollY: contentOffset.y,
      };
      publishDescent();
    },
    [publishDescent],
  );

  const onListContentSizeChange = useCallback(
    (_width: number, height: number) => {
      metricsRef.current.contentHeight = height;
      publishDescent();
    },
    [publishDescent],
  );

  const onListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height, y } = event.nativeEvent.layout;
      metricsRef.current.viewportHeight = height;
      const snapshot = store.getSnapshot();
      if (height !== snapshot.height || y !== snapshot.top) {
        store.publish({ height, top: y });
      }
      publishDescent();
    },
    [publishDescent, store],
  );

  const viewport = useMemo(
    () => ({
      subscribe: store.subscribe,
      getSnapshot: store.getSnapshot,
      scrollToMessage,
    }),
    [store, scrollToMessage],
  );

  useEffect(() => {
    if (isRunning) {
      AccessibilityInfo.announceForAccessibility("Assistant is working");
    }
  }, [isRunning]);

  // KeyboardAvoidingView measures its frame against its parent, so a navigation
  // header above the thread would leave the composer covered by the header's
  // height; the viewport's window position supplies that offset, minus the
  // bottom inset the footer already pads.
  const measureViewport = () => {
    viewportRef.current?.measureInWindow((_x, y) => setViewportTop(y));
  };

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadViewportContext.Provider value={viewport}>
        <ThreadPrimitive.Root className="aui-root aui-thread-root bg-transparent flex-1">
          {/* 注册 data-image 渲染器（工具产出的图片随消息流内联展示，同桌面
              thread.tsx 挂载法；自身不占渲染位） */}
          <ImageDataUI />
          {/* 直播轮耗时打点（自身不占渲染位；历史轮由快照播种） */}
          <TurnTimingRecorder />
          <KeyboardAvoidingView
            className="flex-1"
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={viewportTop - insets.bottom}
          >
            <View
              ref={viewportRef}
              onLayout={measureViewport}
              className={cn(
                "aui-thread-viewport mx-auto w-full max-w-[44rem] flex-1",
                isEmpty && "justify-center",
              )}
            >
              <AuiIf condition={isNewChatView}>
                <WelcomeSlot />
              </AuiIf>
              <AuiIf condition={isHistoryLoadingView}>
                <ThreadHistorySkeleton />
              </AuiIf>
              <AuiIf condition={(s) => s.thread.messages.length > 0}>
                {history?.isLoadingMore && <HistoryEdge />}
                <ThreadPrimitive.MessagesFlatList
                  // Viewability props cannot change once a FlatList is mounted.
                  key={Rail ? "tracked" : "plain"}
                  ref={listRef}
                  className="aui-message-group flex-1"
                  contentContainerClassName={cn(
                    "gap-6 px-4 pt-4 pb-6",
                    Rail && "pl-10",
                  )}
                  showsVerticalScrollIndicator={false}
                  keyboardDismissMode="interactive"
                  keyboardShouldPersistTaps="handled"
                  // 消息列表分批渲染：一轮可能很长（工具行几十条），一次挂载
                  // 全部可见项会让进入会话/流式期间的帧掉得厉害
                  initialNumToRender={6}
                  maxToRenderPerBatch={6}
                  updateCellsBatchingPeriod={50}
                  windowSize={9}
                  removeClippedSubviews
                  {...(Rail
                    ? {
                        onContentSizeChange: onListContentSizeChange,
                        onLayout: onListLayout,
                        onScroll: onListScroll,
                        onScrollToIndexFailed,
                        onViewableItemsChanged,
                        viewabilityConfig: MESSAGE_VIEWABILITY,
                      }
                    : {})}
                  {...(history
                    ? {
                        history,
                      }
                    : {})}
                >
                  {() => <ThreadMessage />}
                </ThreadPrimitive.MessagesFlatList>
              </AuiIf>
              <View
                className="aui-thread-viewport-footer gap-4 px-4"
                style={{ paddingBottom: insets.bottom + 8 }}
              >
                {aboveComposer}
                {/* 建议条排在输入框**上方**：原本它挂在 footer 末尾，也就是压在
                    输入框下面，和「先想好点什么再写」的动线正好相反。移到
                    ComposerSlot 前，同时改成左对齐（见下）。 */}
                <AuiIf
                  condition={(s) => isNewChatView(s) && s.composer.isEmpty}
                >
                  <ThreadSuggestions />
                </AuiIf>
                <ComposerSlot />
              </View>
              {Rail && (
                <View
                  pointerEvents="box-none"
                  className="aui-thread-rail absolute inset-0"
                >
                  <Rail />
                </View>
              )}
            </View>
          </KeyboardAvoidingView>
        </ThreadPrimitive.Root>
      </ThreadViewportContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

const WelcomeSlot: FC = () => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  return <Welcome />;
};

const ComposerSlot: FC = () => {
  const { Composer: CustomComposer } = useContext(ThreadComponentsContext);
  return CustomComposer ? <CustomComposer /> : <Composer />;
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");
  const { AssistantMessage: CustomAssistantMessage } = useContext(
    ThreadComponentsContext,
  );

  if (isEditing) return <EditComposer />;
  if (isSpoken) return <SpokenMessage />;
  if (role === "user") return <UserMessage />;
  const Assistant = CustomAssistantMessage ?? AssistantMessage;
  return <Assistant />;
};

type VoiceRunPosition = "single" | "start" | "middle" | "end";

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === "voice";
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === "voice";
    if (before) return after ? "middle" : "end";
    return after ? "start" : "single";
  });
const SpokenText: TextMessagePartComponent = ({ text }) => (
  <Text className="aui-spoken-message-text text-foreground text-sm leading-relaxed">
    {text}
  </Text>
);

const SpokenMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type === "running",
  );
  const opensExchange = position === "start" || position === "single";

  return (
    <MessagePrimitive.Root
      className={cn(
        "aui-spoken-message bg-muted/40 mx-2 px-3 py-1.5",
        `aui-spoken-message-${position}`,
        position === "single" && "rounded-xl py-2",
        position === "start" && "rounded-t-xl pt-2",
        position === "middle" && "-mt-6",
        position === "end" && "-mt-6 rounded-b-xl pb-2",
      )}
    >
      {opensExchange && (
        <View className="aui-spoken-exchange-header mb-1.5 flex-row items-center gap-1.5">
          <Icon as={PhoneIcon} className="text-muted-foreground size-3" />
          <Text className="text-muted-foreground text-xs">
            Voice conversation
          </Text>
        </View>
      )}
      <View className="aui-spoken-message-content flex-row items-start gap-2">
        <View
          className="mt-1 shrink-0"
          accessible
          accessibilityLabel={role === "user" ? "You said" : "Assistant said"}
        >
          <Icon
            as={role === "user" ? MicIcon : AudioLinesIcon}
            className="text-muted-foreground size-3.5"
          />
        </View>
        <View className="min-w-0 flex-1 flex-row items-center">
          <View className="min-w-0 flex-1">
            <MessagePrimitive.Parts components={{ Text: SpokenText }} />
            {isSpeaking && (
              <TypingIndicator
                variant="bare"
                announce={false}
                className="aui-spoken-message-indicator ms-1"
                accessibilityLabel="Assistant is speaking"
              />
            )}
          </View>
          <SpokenActionBar />
        </View>
      </View>
    </MessagePrimitive.Root>
  );
};

const SpokenActionBar: FC = () => (
  <AuiIf
    condition={(s) =>
      !(s.message.role === "assistant" && s.message.status?.type === "running")
    }
  >
    <View className="aui-spoken-action-bar flex-row gap-1">
      <ActionBarPrimitive.Copy
        copyToClipboard={copyToClipboard}
        className={cn(iconButtonClassName, "size-6")}
        hitSlop={groupedIconButtonHitSlop}
        accessibilityLabel="Copy"
      >
        {({ isCopied }) => (
          <Icon
            as={isCopied ? CheckIcon : CopyIcon}
            className="text-muted-foreground size-3.5"
          />
        )}
      </ActionBarPrimitive.Copy>
    </View>
  </AuiIf>
);

// The edge sits above the list rather than inside it as a header: the list
// keeps its first visible row anchored, so a header inserted above that row
// would land outside the viewport instead of pushing into it.
const HistoryEdge: FC = () => {
  useAnnounce("Loading earlier messages");

  return (
    <View
      className="aui-thread-history-edge items-center pb-4"
      accessibilityLiveRegion={webLiveRegion}
    >
      <ShimmerLabel className="text-muted-foreground text-[13px]">
        Loading earlier messages
      </ShimmerLabel>
    </View>
  );
};

const ThreadHistorySkeleton: FC = () => (
  <View
    className="aui-thread-history-skeleton gap-6 px-4 pt-4 h-full"
    accessible
    accessibilityRole="progressbar"
    accessibilityLabel="Loading conversation"
  >
    <View className="bg-muted ml-auto h-9 w-2/5 rounded-xl" />
    <View className="gap-2">
      <View className="bg-muted h-4 w-11/12 rounded" />
      <View className="bg-muted h-4 w-4/5 rounded" />
      <View className="bg-muted h-4 w-3/5 rounded" />
    </View>
    <View className="bg-muted ml-auto h-9 w-1/3 rounded-xl" />
    <View className="gap-2">
      <View className="bg-muted h-4 w-10/12 rounded" />
      <View className="bg-muted h-4 w-2/3 rounded" />
    </View>
  </View>
);

const ThreadWelcome: FC = () => (
  <View className="aui-thread-welcome-root mb-6 items-center px-4">
    <Text className="aui-thread-welcome-message text-foreground text-center text-2xl font-medium tracking-tight">
      How can I help you today?
    </Text>
  </View>
);

const ThreadSuggestions: FC = () => (
  <View className="aui-thread-welcome-suggestions w-full flex-row flex-wrap items-center justify-start gap-2">
    <ThreadPrimitive.Suggestions>
      {() => <ThreadSuggestionItem />}
    </ThreadPrimitive.Suggestions>
  </View>
);

const ThreadSuggestionItem: FC = () => (
  <SuggestionPrimitive.Trigger
    send
    className="aui-thread-welcome-suggestion border-border/60 active:bg-muted flex-row items-center gap-1.5 rounded-full border px-3.5 py-1.5"
  >
    <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground text-sm" />
    <AuiIf condition={(s) => !!s.suggestion.label}>
      <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground text-sm" />
    </AuiIf>
  </SuggestionPrimitive.Trigger>
);

// The placeholder color is a class to prop mapping that reads the CSSOM, so it applies from the first render after hydration.
const DefaultComposerInput: FC = () => {
  const hydrated = useHydrated();
  const aui = useAui();
  // 键盘的换行键 = 发送（用户要求：换行键当发送用）。要点：
  // - submitBehavior="submit"：iOS 上回车不插换行，改为触发 onSubmitEditing
  //   （RN 0.76+ 用法；老写法 blurOnSubmit 会顺带收键盘，这里要保住焦点继续打字）
  // - returnKeyType="send"：键盘右下角那枚键的字样改成「发送」
  // - 运行中提交走排队（steer:false），与右侧 ↑ 同语义，不是默认的"并入本轮"
  const submit = useCallback(() => {
    const running = aui.thread.getState().isRunning;
    if (!aui.composer.getState().canSend) return;
    aui.composer.send(running ? { steer: false } : undefined);
  }, [aui]);
  // 登记输入实例：菜单关掉后要把焦点还回来（见 lib/pi/composer-focus）。
  // React 19 里 ref 是普通 prop，ComposerInput 把 props 展开到 TextInput 上，
  // 所以这里直接透传即可（写法与桌面端 cm-composer-input 的 composerViews 同规）。
  const inputRef = useRef<{ focus: () => void } | null>(null);
  useRegisterComposerInput(inputRef);

  return (
    <ComposerPrimitive.Input
      {...({ ref: inputRef } as object)}
      submitBehavior="submit"
      returnKeyType="send"
      onSubmitEditing={submit}
      placeholder="Send a message..."
      placeholderTextColorClassName={
        hydrated ? "accent-muted-foreground/60" : undefined
      }
      className="aui-composer-input text-foreground web:resize-none web:outline-none max-h-48 min-h-10 px-2.5 py-1 text-base leading-6"
      multiline
      // Android 的 TextView 会在字形上下多留一条基于字体度量的 font padding，
      // iOS 没有。多行输入框上这一条会把首行往下推、行盒也比 iOS 高，同一个
      // composer 两端的文字落点就对不上。关掉它即可，垂直对齐不再另设：多行
      // EditText 的默认 gravity 本来就是 TOP，与 iOS 的 UITextView 一致。
      // iOS / web 上传 undefined，现有表现不变。
      style={ANDROID_TEXT_INPUT_FIX}
      accessibilityLabel="Message input"
    />
  );
};

/** Android 输入框的字形修正；iOS / web 传 undefined，不改变现有表现 */
const ANDROID_TEXT_INPUT_FIX =
  Platform.OS === "android"
    ? ({ includeFontPadding: false } as const)
    : undefined;

const Composer: FC = () => {
  const { ComposerInput = DefaultComposerInput } = useContext(
    ThreadComponentsContext,
  );
  const aui = useAui();
  // 注意这里**不订阅草稿文本**：输入框那一整块是 iOS 的真玻璃（GlassControl /
  // UIGlassEffect），每敲一个字重渲一次这层玻璃，代价直接落在键盘与布局动画上
  // ——表现就是"打字卡""发完键盘收下去很慢"。触发词（@ / /）与芯片行各自下沉到
  // 下面的叶子里各自订阅，打字只重渲那几个小节点。
  const [plusOpen, setPlusOpen] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  // 选中技能/子智能体：挂进芯片台账（输入框保持干净），触发词从草稿里摘掉
  const insertDirective = useCallback(
    (directive: string, replaceFrom?: number) => {
      const text = aui.composer.getState().text;
      if (replaceFrom !== undefined && replaceFrom <= text.length) {
        aui.composer.setText(text.slice(0, replaceFrom).replace(/[ \t]+$/, ""));
      }
      const parsed = parseDirective(directive);
      if (parsed) {
        addComposerChip({
          id: nextComposerChipId(),
          kind: parsed.kind,
          name: parsed.name,
          directive,
        });
      }
    },
    [aui],
  );

  const pickImage = useCallback(
    (source: "library" | "camera") => {
      // 失败要说话：相册拉不起来/压缩失败若静默，用户看到的就是"点了没反应"
      setAttachError(null);
      const fail = (err: unknown) =>
        setAttachError(err instanceof Error ? err.message : String(err));
      if (source === "library") {
        void pickComposerImages(aui).catch(fail);
        return;
      }
      void (async () => {
        try {
          const attachment = await pickImageAttachment("camera");
          if (attachment) await aui.composer.addAttachment(attachment);
        } catch (err) {
          fail(err);
        }
      })();
    },
    [aui],
  );

  return (
    <ComposerPrimitive.Root className="aui-composer-root w-full">
      {/* 输入框这一整块壳走 GlassControl：iOS 26 上是真 UIGlassEffect，其余平台
          回退成半透填充 + 白描边 + 投影。之前是 className 拼的 bg-card/55，
          那只是「一块半透明白」，不是会折射的玻璃。
          不给 isInteractive：里面是 TextInput，按压形变会和文本光标选中打架
          （和首页搜索条同一个理由）。
          尺寸换算：gap-2 / p-2 → 8，rounded-3xl → 24（见 global.css 的 @theme）。 */}
      <GlassControl radius={24} style={composerShell}>
        <ComposerAttachments />
        <ComposerChips />
        {attachError ? (
          <Text className="aui-composer-attach-error text-destructive px-1 pt-1 text-[12.5px]">
            {attachError}
          </Text>
        ) : null}
        <ComposerInput />
        <ComposerAction
          onPlus={() => {
            dismissKeyboard();
            setPlusOpen(true);
          }}
        />
      </GlassControl>
      {/* 菜单宿主：Modal 承载（贴屏幕底，不跟键盘避让一起被顶跑）；
          它自己订阅草稿文本——见 ComposerMenus 的注释 */}
      <ComposerMenus
        plusOpen={plusOpen}
        onClosePlus={() => setPlusOpen(false)}
        onInsertDirective={insertDirective}
        onPickImage={pickImage}
      />
    </ComposerPrimitive.Root>
  );
};

/**
 * ＋ 菜单与 @ / 触发菜单的宿主。**单独订阅 composer 文本**：触发词只在草稿末尾，
 * 但这个订阅挂在叶子上，打字时重渲的只是这一个 null 渲染的小组件，不会带上输入框
 * 那层玻璃（见 Composer 里不订阅草稿的注释）。
 */
const ComposerMenus: FC<{
  plusOpen: boolean;
  onClosePlus: () => void;
  onInsertDirective: (directive: string, replaceFrom?: number) => void;
  onPickImage: (source: "library" | "camera") => void;
}> = ({ plusOpen, onClosePlus, onInsertDirective, onPickImage }) => {
  const aui = useAui();
  const draft = useAuiState((s) => s.composer.text);
  // 用户刚关掉的那份草稿不再弹触发菜单（关掉后草稿原样还在，否则立刻又弹）
  const [dismissedTrigger, setDismissedTrigger] = useState<string | null>(null);

  const trigger = useMemo(() => {
    if (plusOpen) return null;
    const match = matchTrigger(draft);
    if (!match) return null;
    if (dismissedTrigger !== null && dismissedTrigger === draft) return null;
    return match;
  }, [draft, plusOpen, dismissedTrigger]);

  // 触发菜单（@ / ）出现的那一下收键盘：菜单贴屏幕底，键盘弹着会把它顶跑
  const triggerOpen = trigger !== null;
  useEffect(() => {
    if (triggerOpen) dismissKeyboard();
  }, [triggerOpen]);

  // 关菜单：把当前草稿记为「已忽略」，并把焦点还给输入框继续打字
  const closeMenu = useCallback(() => {
    if (plusOpen) onClosePlus();
    else setDismissedTrigger(aui.composer.getState().text);
    focusComposerInput();
  }, [aui, onClosePlus, plusOpen]);

  if (!plusOpen && !trigger) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={closeMenu}>
      {plusOpen ? (
        <ComposerPlusMenu
          onClose={closeMenu}
          onInsertDirective={onInsertDirective}
          onPickImage={onPickImage}
        />
      ) : trigger ? (
        <ComposerPlusMenu
          initialPage={trigger.kind === "mention" ? "subagents" : "commands"}
          query={trigger.query}
          triggerIndex={trigger.index}
          onClose={closeMenu}
          onInsertDirective={onInsertDirective}
          onPickImage={onPickImage}
        />
      ) : null}
    </Modal>
  );
};

/**
 * 指令芯片行：技能/子智能体挂在上面的台账里（lib/pi/composer-chips），输入框
 * 只留用户自己打的字——序列化指令 `:skill[...]{name=...}` 在发送那一刻才拼进
 * 正文。视觉对齐 web/桌面端的输入框内联胶囊：图标 + 名称 + ×。
 */
const ComposerChips: FC = () => {
  const chips = useComposerChips();
  if (chips.length === 0) return null;
  return (
    <View className="aui-composer-chips flex-row flex-wrap gap-2 px-1 pt-1">
      {chips.map((chip) => (
        <View
          key={chip.id}
          className="border-border bg-foreground/5 flex-row items-center gap-1.5 rounded-full border py-1 pr-2 pl-2.5"
        >
          <Icon
            as={chip.kind === "agent" ? BotIcon : BookOpenIcon}
            className="text-muted-foreground size-3.5"
          />
          <Text className="text-foreground text-[12.5px]" numberOfLines={1}>
            {chip.name}
          </Text>
          <Pressable
            onPress={() => removeComposerChip(chip.id)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`移除 ${chip.kind === "agent" ? "子智能体" : "技能"} ${chip.name}`}
          >
            <Text className="text-muted-foreground text-[13px] leading-4">×</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
};

const composerShell = { gap: 8, padding: 8 } as const;

const ComposerAction: FC<{ onPlus: () => void }> = ({ onPlus }) => {
  const aui = useAui();
  const { ComposerToolbar } = useContext(ThreadComponentsContext);
  // 「停止」要连队列一起清（见该按钮的注释）：排队文本回填输入框，不丢输入
  const { clear: clearQueue } = usePiQueue();

  // Pi 附加（发送后收键盘）：不劫持 Send 的 onPress——ComposerSend 把内部
  // onPress 排在 props 展开之前，外部传 onPress 会顶掉发送本身。统一信号改看
  // 「线程里多了用户消息」：↑ 按钮、键盘 Enter、运行中排队发送三条路径全覆盖。
  // selector 取计数而不是数组：流式期间用户消息数不变，本组件不跟着每帧重渲。
  //
  // 但**只靠这个信号会慢半拍**：从点按到乐观消息投影成、React 重渲、effect 跑
  // 起来之间隔着一整轮发送链路（大转录时肉眼可见「卡一下键盘才收」）。所以
  // ↑ 按钮再走一条捷径：onPressIn（按下瞬间，先于内部 onPress）就收键盘——
  // ComposerSend / ComposerCancel 不设 onPressIn，从 props 散下来不会顶掉谁。
  // 下面是兜底：Enter 提交、排队发送等非按钮路径仍然由计数信号收。
  const userMessageCount = useAuiState((s) =>
    s.thread.messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0),
  );
  const prevUserCount = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount > prevUserCount.current) dismissKeyboard();
    prevUserCount.current = userMessageCount;
  }, [userMessageCount]);

  return (
    <View className="aui-composer-action-wrapper flex-row items-center gap-1.5">
      {/* 「＋」是菜单入口（照片/拍照/技能/子智能体/命令），不再是直接相册 */}
      <Pressable
        onPress={onPlus}
        hitSlop={iconButtonHitSlop}
        className="aui-composer-plus active:bg-muted size-7 items-center justify-center rounded-full"
        accessibilityRole="button"
        accessibilityLabel="添加内容：照片、技能、子智能体、命令"
      >
        <Icon as={PlusIcon} className="text-muted-foreground size-4" />
      </Pressable>
      {/* 槽位占位很关键：没有它这一行就只有「＋」和发送键两枚按钮，gap
          会把它们挤到中间去，而不是各自贴边 */}
      {ComposerToolbar ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="aui-composer-toolbar flex-1"
          contentContainerStyle={{ alignItems: "center", gap: 6 }}
        >
          {ComposerToolbar}
        </ScrollView>
      ) : (
        <View className="flex-1" />
      )}
      <View className="flex-row items-center gap-1.5">
        {/* 右侧一个槽位，按钮随状态换形（用户原话：「把暂停按钮改成发送按钮
            就进队列」——同一个位置换形态，不是并排多长一个键）：
              - 发送准备中 → ■ 取消发送
              - 运行中 + 草稿有内容 → ↑ 进发送队列（长按 = 并入本轮 steer）
              - 运行中 + 草稿为空 → ■ 停止生成
              - 空闲 → ↑ 发送 */}
        <AuiIf condition={(s) => s.composer.submission !== undefined}>
          <ComposerPrimitive.Cancel
            className="aui-composer-cancel bg-primary active:bg-primary/90 size-7 items-center justify-center rounded-full"
            hitSlop={iconButtonHitSlop}
            accessibilityLabel="Cancel sending"
            onPressIn={dismissKeyboard}
          >
            <View className="aui-composer-cancel-icon bg-primary-foreground size-3 rounded-[2px]" />
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.submission === undefined &&
            s.thread.isRunning &&
            s.thread.voice === undefined &&
            s.composer.text.trim().length > 0
          }
        >
          <Pressable
            className="aui-composer-send aui-composer-send-running bg-primary active:bg-primary/90 size-7 items-center justify-center rounded-full"
            hitSlop={iconButtonHitSlop}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityHint="当前回合结束后自动执行；长按并入本轮"
            onPressIn={dismissKeyboard}
            onPress={() => aui.composer.send({ steer: false })}
            onLongPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              aui.composer.send({ steer: true });
            }}
          >
            <Icon
              as={ArrowUpIcon}
              className="aui-composer-send-icon text-primary-foreground size-4"
            />
          </Pressable>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.submission === undefined &&
            s.thread.isRunning &&
            s.thread.voice === undefined &&
            s.composer.text.trim().length === 0
          }
        >
          {/* 「停止」= 停当前轮 + **清空队列** + 排队内容回填输入框（2026-10-04）。
              不用 ComposerPrimitive.Cancel 是因为它只中止当前轮：队列里排着的条目
              会在收尾后由串行链自动接管，用户看到的是"我点了暂停，结果同一条又被
              发了一遍"（sidecar 的 autoDrain 恒开，见 prompt-queue.ts 头注）。
              这里显式把两件事一起做，且不丢用户的输入——排队文本回填到输入框
              （这一分支只在草稿为空时出现，setText 不会覆盖正在打的字）。 */}
          <Pressable
            className="aui-composer-cancel bg-primary active:bg-primary/90 size-7 items-center justify-center rounded-full"
            hitSlop={iconButtonHitSlop}
            accessibilityRole="button"
            accessibilityLabel="停止生成并清空队列"
            accessibilityHint="当前轮与排队消息都会停止，排队内容回到输入框"
            onPressIn={dismissKeyboard}
            onPress={() => {
              aui.composer.cancel();
              void (async () => {
                try {
                  const cleared = await clearQueue();
                  const restored = [...cleared.steering, ...cleared.followUp]
                    .map((text) => text.trim())
                    .filter(Boolean)
                    .join("\n");
                  if (restored) aui.composer.setText(restored);
                } catch {
                  // 队列清理失败不影响"停止"本身：当前轮已中止，队列条目由
                  // 后续 queue_update/快照自愈呈现
                }
              })();
            }}
          >
            <View className="aui-composer-cancel-icon bg-primary-foreground size-3 rounded-[2px]" />
          </Pressable>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.submission === undefined && !s.thread.isRunning
          }
        >
          <ComposerPrimitive.Send
            className="aui-composer-send bg-primary active:bg-primary/90 size-7 items-center justify-center rounded-full disabled:opacity-50"
            hitSlop={iconButtonHitSlop}
            accessibilityLabel="Send message"
            onPressIn={dismissKeyboard}
          >
            <Icon
              as={ArrowUpIcon}
              className="aui-composer-send-icon text-primary-foreground size-4"
            />
          </ComposerPrimitive.Send>
        </AuiIf>
      </View>
    </View>
  );
};

const MessageError: FC = () => (
  <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 dark:bg-destructive/5 mt-2 rounded-md border p-3">
    <ErrorPrimitive.Message
      className="aui-message-error-message text-destructive text-sm"
      numberOfLines={2}
    />
  </ErrorPrimitive.Root>
);

/**
 * 用户消息正文：指令芯片（技能/子智能体）渲染成胶囊，正文只留人话。
 * 落盘的转录里正文带序列化指令（芯片「发送那一刻才拼进 wire」的必然结果），
 * 桌面端是输入框内的内联 chip；RN 的 Text 排不了内联胶囊，退成气泡内上方
 * 一行胶囊——但绝不能把 `:skill[doc]{name=skill:doc}` 原样显示给用户。
 */
const UserText: TextMessagePartComponent = ({ text }) => {
  const { chips, text: body } = useMemo(
    () => splitMessageDirectives(text),
    [text],
  );
  if (chips.length === 0) {
    return (
      <Text className="aui-user-message-text text-primary text-base leading-6">
        {text}
      </Text>
    );
  }
  return (
    <View className="aui-user-message-directives">
      <View className="mb-2 flex-row flex-wrap gap-1.5">
        {chips.map((chip, index) => (
          <View
            key={`${chip.type}-${chip.label}-${index}`}
            className="flex-row items-center gap-1 self-start rounded-md bg-blue-100 px-1.5 py-1 dark:bg-blue-900/50"
            accessibilityLabel={`${chip.type === "agent" ? "子智能体" : chip.type === "skill" ? "技能" : chip.type}：${chip.label}`}
          >
            <Icon
              as={chip.type === "agent" ? BotIcon : BookOpenIcon}
              className="size-3.5 text-blue-700 dark:text-blue-300"
            />
            <Text className="text-[13px] leading-none font-medium text-blue-700 dark:text-blue-300">
              {chip.label}
            </Text>
          </View>
        ))}
      </View>
      {body ? (
        <Text className="aui-user-message-text text-primary text-base leading-6">
          {body}
        </Text>
      ) : null}
    </View>
  );
};

const AssistantIndicator: FC = () => {
  const isRunning = useAuiState((s) => s.message.status?.type === "running");
  if (!isRunning) return null;

  return (
    <TypingIndicator
      variant="bare"
      announce={false}
      className="aui-assistant-message-indicator py-2"
      accessibilityLabel="Assistant is working"
    />
  );
};

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

type ThreadGroupKey =
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool"
  | "group-task";

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: GroupByContext,
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === "tool-call" &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

/* ------------------------------ 轮次折叠 ------------------------------ */

/**
 * 一轮过程/正文的归属（对齐桌面 turn-summary 的 process / answer 两面）：
 * 正文面 = 文字、图片与错误占位，折叠后仍可见；其余（思考、工具行、压缩
 * 分隔线等 data）都算过程，折叠时收进摘要行。file 归过程面（与桌面
 * onAnswerSide 同规）——Pi 的工具产出图片走 data-image，file 是旁支。
 */
const isProcessPart = (part: { type: string; name?: string }): boolean => {
  if (part.type === "text" || part.type === "image") return false;
  if (part.type === "data")
    return part.name !== "image" && part.name !== "errorAttribution";
  return true;
};

/** selector 结果编码成字符串：useAuiState 返回新对象每次都会被判为"变了"，
 *  字符串相等即不重渲（轮次信息一变就是整轮重渲，值得省）。 */
const TURN_FIELD_SEP = "\u0001";

type TurnView = {
  /** 轮锚 = 轮首 user 消息的投影 id（与耗时台账 `pi-msg:${seq}` 键同源） */
  key: string;
  /** 本条消息紧跟轮首 user 行（运行中的进度行只挂这里） */
  isFirst: boolean;
  /** 本轮还在跑：轮内有 running 消息，或末轮且线程级 running（见选择器） */
  running: boolean;
  /** 本轮含过程 part（纯聊天轮不值得留一个点开空白的开关） */
  hasProcess: boolean;
  /** 本条消息是本轮第一条带过程 part 的消息（摘要行与过程 pop 挂这里） */
  host: boolean;
  /** 本条消息含正文 part（折叠后这条消息是否有东西可露） */
  hasAnswer: boolean;
  /** 本轮工具调用数（pop 副标题） */
  toolCount: number;
  /** 本轮过程块数（reasoning + tool-call，与桌面 collapsedCount 同口径）：
   *  耗时台账缺数时摘要行退回「N 条较早消息」 */
  collapsedCount: number;
};

const EMPTY_TURN_VIEW: TurnView = {
  key: "",
  isFirst: false,
  running: false,
  hasProcess: false,
  host: false,
  hasAnswer: false,
  toolCount: 0,
  collapsedCount: 0,
};

const parseTurnView = (encoded: string): TurnView => {
  if (!encoded) return EMPTY_TURN_VIEW;
  const [key = "", first, running, hasProcess, host, hasAnswer, toolCount, collapsedCount] =
    encoded.split(TURN_FIELD_SEP);
  return {
    key,
    isFirst: first === "1",
    running: running === "1",
    hasProcess: hasProcess === "1",
    host: host === "1",
    hasAnswer: hasAnswer === "1",
    toolCount: Number.parseInt(toolCount ?? "0", 10) || 0,
    collapsedCount: Number.parseInt(collapsedCount ?? "0", 10) || 0,
  };
};

const turnViewSelector = (s: AssistantState): string => {
  const messages = s.thread.messages;
  const index = s.message.index;
  if (index === undefined || index < 0 || index >= messages.length) return "";
  let start = -1;
  for (let i = index; i >= 0; i--) {
    if (messages[i].role === "user") {
      start = i;
      break;
    }
  }
  // 开场（首条 user 之前）的 assistant 内容没有轮锚，不参与折叠
  if (start === -1) return "";
  let end = messages.length;
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i].role === "user") {
      end = i;
      break;
    }
  }
  let running = false;
  let hasProcess = false;
  let host = -1;
  let toolCount = 0;
  // 过程块口径对齐桌面 packTurnSummary：reasoning + tool-call，text/data 不计
  let collapsedCount = 0;
  for (let i = start + 1; i < end; i++) {
    const message = messages[i];
    if (!running && message.status?.type === "running") running = true;
    const parts = message.content as readonly { type: string; name?: string }[];
    const hasProcessHere = parts.some(isProcessPart);
    if (hasProcessHere) {
      hasProcess = true;
      if (host === -1) host = i;
    }
    for (const part of parts) {
      if (part.type === "tool-call") {
        toolCount += 1;
        collapsedCount += 1;
      } else if (part.type === "reasoning") {
        collapsedCount += 1;
      }
    }
  }
  // 末轮空窗：user 行刚落、assistant 消息还没挂上 running 的那一瞬逐消息
  // 扫描看不到"在跑"，靠线程级运行态兜底（同桌面 TurnSlot 的注释）
  if (!running && end === messages.length && s.thread.isRunning) running = true;
  const current = messages[index];
  const hasAnswer = (current.content as readonly { type: string; name?: string }[])
    .some((part) => !isProcessPart(part));
  return [
    String(messages[start].id ?? ""),
    index === start + 1 ? "1" : "0",
    running ? "1" : "0",
    hasProcess ? "1" : "0",
    index === host ? "1" : "0",
    hasAnswer ? "1" : "0",
    String(toolCount),
    String(collapsedCount),
  ].join(TURN_FIELD_SEP);
};

/** 中文时长（对齐桌面 formatDuration / Codex 的「已工作 4 分 8 秒」） */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
};

/**
 * 一行工作摘要（对齐桌面 TurnWorkSummary）：运行中是「工作中 + 秒表」的纯
 * 进度行；结束后是「已工作 X」，点开从底部弹出本轮过程（桌面端是就地展开，
 * 手机屏装不下摊开的过程，改走底部 pop，正文面始终留在消息流里）。
 */
const TurnSummaryRow: FC<{
  scopedKey: string;
  running: boolean;
  hasProcess: boolean;
  toolCount: number;
  collapsedCount: number;
}> = ({ scopedKey, running, hasProcess, toolCount, collapsedCount }) => {
  const [open, setOpen] = useState(false);
  const durationMs = useTurnDurationMs(scopedKey, null, running);
  // 运行中的秒表：每秒 tick 一次，从台账里的开始时刻算起
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const startedAt = getTurnTiming(scopedKey)?.start;
  const elapsedMs =
    running && startedAt !== undefined ? Date.now() - startedAt : undefined;
  // 文案优先级对齐桌面 TurnWorkSummary：耗时算不出（台账缺数/亚秒轮）时
  // 退回「N 条较早消息」，连过程块都没有才是「本轮过程」
  const label = running
    ? elapsedMs !== undefined && elapsedMs >= 1000
      ? `工作中 ${formatDuration(elapsedMs)}`
      : "工作中"
    : durationMs !== undefined
      ? `已工作 ${formatDuration(durationMs)}`
      : collapsedCount > 0
        ? `${collapsedCount} 条较早消息`
        : "本轮过程";
  const subtitle = [
    running ? label : durationMs !== undefined ? `已工作 ${formatDuration(durationMs)}` : null,
    toolCount > 0 ? `${toolCount} 个工具` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // 运行中：纯进度行不可点——过程正整条实时渲染，没有收起的语义
  if (running) {
    return (
      <View className="border-border/60 mt-3 border-b pb-3">
        <View className="flex-row items-center gap-1.5 py-0.5">
          <ShimmerLabel className="text-muted-foreground text-[13px]" active>
            {label}
          </ShimmerLabel>
        </View>
      </View>
    );
  }
  // 已结束但本轮没有过程（纯聊天轮）：整行撤掉，不留一个点开空白的开关
  if (!hasProcess) return null;

  return (
    <View className="border-border/60 mt-3 border-b pb-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`查看本轮过程，${subtitle}`}
        hitSlop={textButtonHitSlop}
        onPress={() => setOpen(true)}
        className="flex-row items-center gap-1.5 py-0.5"
      >
        <Text className="text-muted-foreground text-[13px]">{label}</Text>
        {/* 上指箭头 = 从底部弹出一层（同计划药丸的入口语义） */}
        <Icon
          as={ChevronRightIcon}
          className="text-muted-foreground size-3.5 shrink-0"
        />
      </Pressable>
      {open ? (
        <TurnProcessSheet subtitle={subtitle} onClose={() => setOpen(false)} />
      ) : null}
    </View>
  );
};

/**
 * 本轮过程的底部 pop：一层抽屉装完整过程（思考、工具行、其余 data）。
 * 用 Modal 承载——摘要行长在消息条目里，抽屉必须脱离条目的坐标空间才能
 * 铺满整屏；进出场动画由 Sheet 自己跑，关到底才回调 onClose 卸载。
 */
const TurnProcessSheet: FC<{ subtitle: string; onClose: () => void }> = ({
  subtitle,
  onClose,
}) => {
  const { height } = useWindowDimensions();
  const maxH = Math.round(height * 0.88);

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Sheet
        onClose={onClose}
        travel={maxH + 120}
        showClose
        closeLabel="关闭本轮过程"
        sheetStyle={{ maxHeight: maxH }}
      >
        <View className="flex-row items-baseline justify-between pb-2.5 pl-5">
          <Text className="text-muted-foreground text-[13px] font-semibold">
            本轮过程
          </Text>
          {subtitle ? (
            <Text
              numberOfLines={1}
              className="text-muted-foreground max-w-[60%] pr-14 text-[12px] opacity-70"
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        <ScrollView
          // flexShrink：抽屉是 maxHeight 约束而非定高，不收缩的话长过程会顶出
          // 面板边界（RN 的 flexShrink 默认 0）
          style={{ flexShrink: 1 }}
          contentContainerClassName="px-5 pb-6"
          showsVerticalScrollIndicator={false}
        >
          {/* 过程面：与正文面同一份 part 树，只按归属过滤 */}
          <AssistantMessageContent variant="process" />
        </ScrollView>
      </Sheet>
    </Modal>
  );
};

/**
 * 消息内容（可按面过滤）：
 * - variant "process"：只渲染过程 part（思考、工具行、其余 data，以及更早步骤的
 *   过程叙述）
 * - variant "answer"：只渲染正文 part（最后一次动手之后的文字、图片、错误占位）
 * - 不传：全部渲染（流式中的轮与开场内容）
 */
const AssistantMessageContent: FC<{ variant?: "process" | "answer" }> = ({
  variant,
}) => {
  const { ToolFallback: CustomToolFallback, TaskGroup: TaskGroupComponent } =
    useContext(ThreadComponentsContext);
  const ToolFallbackComponent = CustomToolFallback ?? ToolFallback;
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;
  const onlyProcess = variant === "process";
  const onlyAnswer = variant === "answer";
  // 折叠面切分（整条渲染时不过滤）：投影把一轮合并成一条消息，正文里夹着每一步
  // 的叙述——更早的叙述归过程面，正文面只留最后一次动手之后的回答
  const msgParts = useAuiState((s) => s.message.parts);
  const processTexts = useMemo(
    () => (variant === undefined ? null : collectProcessTexts(msgParts)),
    [variant, msgParts],
  );

  return (
    <MessagePrimitive.GroupedParts groupBy={groupBy}>
      {({ part, children }) => {
        const dataName =
          part.type === "data" ? (part as { name?: string }).name : undefined;
        const onAnswerSide =
          part.type === "text" ||
          part.type === "image" ||
          dataName === "image" ||
          dataName === "errorAttribution";
        // 过程叙述（更早步骤里的正文）：归过程面
        const foldedText =
          processTexts !== null && part.type === "text" && processTexts.has(part);
        if (onlyProcess && onAnswerSide && !foldedText) return <></>;
        if (onlyAnswer && (!onAnswerSide || foldedText)) return <></>;
        switch (part.type) {
          case "group-chainOfThought":
          case "group-tool":
            return children;
          case "group-task":
            return TaskGroupComponent ? (
              <TaskGroupComponent group={part} />
            ) : null;
          case "group-reasoning": {
            const streaming = part.status.type === "running";
            return (
              <ReasoningRoot streaming={streaming}>
                <ReasoningTrigger active={streaming} />
                <ReasoningContent>
                  <ReasoningText>{children}</ReasoningText>
                </ReasoningContent>
              </ReasoningRoot>
            );
          }
          case "text":
            return <MarkdownText {...part} />;
          case "image":
            return <Image {...part} />;
          case "file":
            return <File {...part} />;
          case "reasoning":
            return <Reasoning {...part} />;
          case "tool-call":
            return part.toolUI ?? <ToolFallbackComponent {...part} />;
          case "data":
            return part.dataRendererUI;
          case "indicator":
            return <AssistantIndicator />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
};

/**
 * 消息壳（轮次折叠接线，对齐桌面 TurnSlot 的拆面渲染）：
 * - 正在跑的轮：整条实时渲染（正文与工具的交错不重排），顶上纯进度行
 * - 已结束的轮：摘要行 + 正文面常驻；过程面收进底部 pop（桌面端是就地展开，
 *   手机上摊开的过程会把消息流顶飞，所以改从底部弹一层看）
 *
 * 移动端的投影把一轮的 assistant 段 + 工具结果并成一条消息，所以拆面在
 * 消息内部做（桌面是轮中/轮末两条消息拆）。摘要行与 pop 挂在「本轮第一条
 * 带过程的消息」上（turn.host，正常一轮只有这一条）。
 *
 * 拆面的完备性（2026-10-04 接线复核）：正文面 = text / image / data-image /
 * data-errorAttribution，其余一律算过程（isProcessPart 与之互补，见两处定义）。
 * 所以每个 part 必落一侧：正文面在**每条**消息上都渲染（不只在 host 上——扩展
 * 消息会把一轮切成多条，正文落在旁支消息时不能丢，这是此前"已结束轮次答案
 * 正文不渲染"的一个来源）；过程面只进 pop，pop 开关挂在含过程的那条消息上，
 * 有过程必有开关。开场（首条 user 之前）无轮锚，整条平铺不折叠。
 */
const AssistantMessage: FC = () => {
  const turn = parseTurnView(useAuiState(turnViewSelector));
  // 台账键要带线程前缀（scopedTurnKey，与 TurnTimingRecorder / 历史播种同规）
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const running = turn.key !== "" && turn.running;
  const folded = turn.key !== "" && !turn.running;
  // 摘要行/进度行：运行中的轮挂轮首消息（进度行），结束的轮挂含过程的那条
  const summaryHost = running ? turn.isFirst : folded && turn.host;

  return (
    <MessagePrimitive.Root className="aui-assistant-message-root">
      <View className="aui-assistant-message-content px-2">
        {summaryHost ? (
          <TurnSummaryRow
            scopedKey={scopedTurnKey(threadId, turn.key)}
            running={running}
            hasProcess={turn.hasProcess}
            toolCount={turn.toolCount}
            collapsedCount={turn.collapsedCount}
          />
        ) : null}
        {/* 运行中与开场整条平铺；结束的轮只留正文面，过程进底部 pop */}
        <AssistantMessageContent {...(folded ? { variant: "answer" as const } : {})} />
        <MessageError />
      </View>
      <View className="aui-assistant-message-footer ms-2 min-h-7.5 flex-row items-center pt-1.5">
        <BranchPicker />
        <AssistantActionBar />
      </View>
    </MessagePrimitive.Root>
  );
};

/**
 * 直播耗时打点（对齐桌面 TurnTimingRecorder）：末轮出现时记开始、不再"进行
 * 中"时补记结束。自行记结束是因为框架的流式计时在取消/中断路径不 finalize
 * （manual stop 后 metadata.timing 缺失），历史轮的两端由
 * PiClientBase.seedHistoryTurnTimings 从转录行时间戳播种。
 */
export const TurnTimingRecorder: FC = () => {
  // 打包成原始值：末轮键 + 是否"还在进行"
  const lastTurnInfo = useAuiState((s) => {
    const messages = s.thread.messages;
    let start = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        start = i;
        break;
      }
    }
    if (start === -1) return "";
    let running = false;
    for (let i = start + 1; i < messages.length; i++) {
      if (messages[i].status?.type === "running") {
        running = true;
        break;
      }
    }
    if (!running && s.thread.isRunning) running = true;
    return `${String(messages[start].id ?? "")}${TURN_FIELD_SEP}${running ? "1" : "0"}`;
  });
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const prevKeyRef = useRef("");
  useEffect(() => {
    const [key, live] = lastTurnInfo.split(TURN_FIELD_SEP);
    if (!key) return;
    const scoped = scopedTurnKey(threadId, key);
    // 换轮了：上一轮若还在进行中就被换下（steer / 排队项插入），给它补记结束
    if (prevKeyRef.current && prevKeyRef.current !== key) {
      noteTurnEnd(scopedTurnKey(threadId, prevKeyRef.current), Date.now());
    }
    prevKeyRef.current = key;
    const current = getTurnTiming(scoped);
    const action = resolveTurnTimingWrite(current, live === "1");
    // 历史播种的条目（live !== true）在轮内是权威：乐观 id 落盘换成
    // `pi-msg:${seq}` 时同一轮会以新键再出现，播种条目已带两端（start = user
    // 行时间戳、end = 本轮最新行时间戳），不能因"两端齐了"就 restart——
    // 那会把开始时刻重置成此刻，收尾后的时长直接毁掉
    if (action === "restart" && current?.live !== true) return;
    if (action === "restart") restartTurnTiming(scoped, Date.now());
    else if (action === "start") noteTurnStart(scoped, Date.now());
    else noteTurnEnd(scoped, Date.now());
  }, [lastTurnInfo, threadId]);
  return null;
};

const AssistantActionBar: FC = () => (
  <AuiIf
    condition={(s) =>
      !(s.message.role === "assistant" && s.message.status?.type === "running")
    }
  >
    <View className="aui-assistant-action-bar-root -ms-1 flex-row gap-1">
      <ActionBarPrimitive.Copy
        copyToClipboard={copyToClipboard}
        className={iconButtonClassName}
        hitSlop={groupedIconButtonHitSlop}
        accessibilityLabel="Copy"
      >
        {({ isCopied }) => (
          <Icon
            as={isCopied ? CheckIcon : CopyIcon}
            className="text-muted-foreground size-4"
          />
        )}
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload
        className={iconButtonClassName}
        hitSlop={groupedIconButtonHitSlop}
        accessibilityLabel="Refresh"
      >
        <Icon as={RefreshCwIcon} className="text-muted-foreground size-4" />
      </ActionBarPrimitive.Reload>
    </View>
  </AuiIf>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="aui-user-message-root items-end gap-y-2 px-2">
    <UserMessageAttachments />
    <View className="aui-user-message-content bg-muted max-w-[85%] rounded-xl px-4 py-2">
       <MessagePrimitive.Parts components={{ Text: UserText, Image, File }} />
    </View>
    <View className="aui-user-message-footer -me-1 flex-row items-center justify-end">
      <BranchPicker />
      <UserActionBar />
    </View>
  </MessagePrimitive.Root>
);

const UserActionBar: FC = () => (
  <AuiIf condition={(s) => !s.thread.isRunning}>
    {/* <ActionBarPrimitive.Edit
      className={cn(iconButtonClassName, "aui-user-action-edit")}
      hitSlop={groupedIconButtonHitSlop}
      accessibilityLabel="Edit"
    >
      <Icon as={PencilIcon} className="text-muted-foreground size-4" />
    </ActionBarPrimitive.Edit> */}
    <ActionBarPrimitive.Copy
        copyToClipboard={copyToClipboard}
        className={iconButtonClassName}
        hitSlop={groupedIconButtonHitSlop}
        accessibilityLabel="Copy"
      >
        {({ isCopied }) => (
          <Icon
            as={isCopied ? CheckIcon : CopyIcon}
            className="text-muted-foreground size-4"
          />
        )}
      </ActionBarPrimitive.Copy>
  </AuiIf>
);

const DefaultEditComposerInput: FC = () => (
  <ComposerPrimitive.Input
    className="aui-edit-composer-input text-foreground web:resize-none web:outline-none min-h-14 px-4 pt-3 pb-1 text-base"
    multiline
    autoFocus
  />
);

const EditComposer: FC = () => {
  const { ComposerInput = DefaultEditComposerInput } = useContext(
    ThreadComponentsContext,
  );

  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 bg-card ms-auto w-full max-w-[85%] rounded-3xl border">
        <ComposerInput />
        <View className="aui-edit-composer-footer mx-2.5 mb-2.5 flex-row items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel className="active:bg-accent h-8 justify-center rounded-full px-3.5">
            <Text className="text-foreground text-sm font-medium">Cancel</Text>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send className="bg-primary active:bg-primary/90 h-8 justify-center rounded-full px-3.5">
            <Text className="text-primary-foreground text-sm font-medium">
              Update
            </Text>
          </ComposerPrimitive.Send>
        </View>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<ViewProps> = ({ className, ...rest }) => {
  const branchCount = useAuiState((s) => s.message.branchCount);
  if (branchCount <= 1) return null;

  return (
    <View
      className={cn(
        "aui-branch-picker-root -ms-2 me-2 flex-row items-center",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous
        className={cn(iconButtonClassName, "disabled:opacity-35")}
        hitSlop={groupedIconButtonHitSlop}
        accessibilityLabel="Previous"
      >
        <Icon as={ChevronLeftIcon} className="text-muted-foreground size-4" />
      </BranchPickerPrimitive.Previous>
      <Text className="aui-branch-picker-state text-muted-foreground text-xs font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </Text>
      <BranchPickerPrimitive.Next
        className={cn(iconButtonClassName, "disabled:opacity-35")}
        hitSlop={groupedIconButtonHitSlop}
        accessibilityLabel="Next"
      >
        <Icon as={ChevronRightIcon} className="text-muted-foreground size-4" />
      </BranchPickerPrimitive.Next>
    </View>
  );
};
