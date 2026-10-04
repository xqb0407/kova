import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router as appRouter, useRouter } from "expo-router";
import { useAui, useAuiState } from "@assistant-ui/react-native";
import {
  BotIcon,
  BrainIcon,
  BugIcon,
  ChevronLeftIcon,
  ClipboardListIcon,
  CompassIcon,
  FileTextIcon,
  GaugeIcon,
  MessageCircleQuestionIcon,
  ShieldIcon,
  TargetIcon,
} from "lucide-react-native";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ToolCallRow } from "@/components/assistant-ui/elements/tool-row";
import {
  GlassView,
  glassControl,
  glassControlCommon,
  liquidGlassAvailable,
} from "@/components/ui/glass";

import { QuestionCard } from "@/components/ui/question-card";
import { ToolApprovalCard } from "@/components/ui/tool-approval-card";
import { QueueBar } from "@/components/ui/composer";
import { AgentPanelBar } from "@/components/ui/agent-panel-bar";
import { OptionSheet, type OptionItem } from "@/components/ui/option-sheet";
import { TypeCaret, TYPE_INTERVAL_MS } from "@/components/ui/type-caret";
import { dismissKeyboard, useKeyboardVisible } from "@/components/ui/dismiss-tap";
import { ENTER_MS, IOS_EASE, NATIVE, SPRING } from "@/components/ui/motion";
import { useThreadTitle } from "@/lib/pi/pi-thread-titles";
import { useTheme, withAlpha } from "@/components/ui/theme";
import {
  useCurrentAppMode,
  setThreadAppMode,
} from "@/lib/pi/pi-session-app-mode";
import {
  setSessionMode,
  useSessionMode,
  type ApprovalLevel,
  type SessionMode,
} from "@/lib/pi/pi-session-mode";
import {
  hydrateThreadModel,
  setThreadModel,
  useThreadModel,
} from "@/lib/pi/pi-session-model";
import {
  hydrateThreadThinking,
  setThreadThinking,
  useThreadThinking,
} from "@/lib/pi/pi-session-thinking";
import { fetchPlanningState } from "@/lib/pi/pi-session-mode";
import {
  ensureSessionSummary,
  piSessionIdForThread,
  subscribeSessionPrefs,
} from "@/lib/pi/pi-thread-adapter";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import { usePiHistory } from "@/lib/pi/pi-runtime";
import { setSessionsChangedSync } from "@/lib/pi/pi-sessions-sync";
import { refreshSessionPrefs } from "@/lib/pi/pi-thread-adapter";
import {
  THINKING_LEVEL_LABELS,
  THINKING_LEVELS,
} from "@/lib/settings/thinking-settings";
import type { AppMode } from "@/lib/pi/app-mode";

/**
 * 聊天页 = 官方 Thread 元素 + 自绘头部、空态与选择器。
 *
 * aboveComposer 槽是 vendored 时加的口子，放两类真正「浮在输入条之上」的东西：
 * - QueueBar：运行中发送的排队条（followUp/steer，可逐项取消）；
 * - ToolApprovalCard / QuestionCard：pi-interactions 台账版审批卡与提问卡
 *   （data-toolApproval / data-question chunk 进卡，键 = pi sessionId）。
 *
 * 模型 / 权限 / 思考这三个选择器不在这一槽里：它们走 components.ComposerToolbar
 * 合并进 composer 内部、紧挨「＋」按钮。工作模式分段走顶栏中间那格——没标题时
 * 显示分段，有标题就显示标题。头部是标准 iOS 导航栏：左边返回箭头。
 *
 * 头部与欢迎语都从**组件覆盖位**接进去（components.Welcome），不改动 vendored
 * 欢迎语：官方那个 ThreadWelcome 是居中一行 "How can I help you today?"。
 */

const MODES: readonly { value: AppMode; label: string }[] = [
  { value: "work", label: "Work" },
  { value: "code", label: "Code" },
  { value: "design", label: "Design" },
];

const GREETING_LINES = ["今天能帮你", "做些什么？"] as const;

/** 空态起步建议：点一下把话填进输入框，不直接发送。
 *  固定三列等宽，所以标签一律四个字——多一个就挤到下一行，版式立刻塌。 */
const STARTERS = [
  {
    icon: CompassIcon,
    label: "梳理项目",
    prompt: "帮我梳理一下这个项目的结构，从入口讲起。",
  },
  {
    icon: BugIcon,
    label: "排查问题",
    prompt: "扫一遍代码，找出还没做完或者写了一半的地方。",
  },
  {
    icon: FileTextIcon,
    label: "写份说明",
    prompt: "给我当前这个项目写一份 README。",
  },
] as const;

/** 起步建议的入场弹簧。退场复用同一条、只是倒着跑，两边的重量感才对得上 */
const STARTER_SPRING = { damping: 24, stiffness: 260, mass: 0.8 } as const;

/** 进场错开间隔 */
const STARTER_IN_STAGGER_MS = 70;

/** 退场错开间隔。比进场紧一截——收起不必再把落位的节奏铺一遍 */
const STARTER_OUT_STAGGER_MS = 40;

/** 一颗退场弹簧跑到不动要多久。错开加这个数之后，容器才可以卸载 */
const STARTER_SPRING_SETTLE_MS = 420;

/** 权限档：只回答「改之前问不问」。四项与桌面端 mode-picker 的 PERMISSION_OPTIONS 同源
 *  （此前移动端漏了 workspace-write 一档，等于把「项目内免确认、命令仍要问」这个
 *  最常用的档位藏起来了）。能力模式（问答/计划/目标）是另一个正交维度，见 MODES。 */
const PERMISSIONS: readonly {
  value: ApprovalLevel;
  label: string;
  detail: string;
}[] = [
  { value: "ask", label: "变更前确认", detail: "改文件前先问我" },
  { value: "workspace-write", label: "工作区内自动", detail: "项目内改文件免确认；命令仍要确认" },
  { value: "auto-edit", label: "自动编辑", detail: "自动编辑文件" },
  { value: "auto", label: "完全访问", detail: "减少确认次数" },
];

/** 会话能力模式：回答「能不能改、以什么形态干活」，与权限正交（桌面端
 *  CapabilityModeChip 的三项 + 默认档）。入口：这枚胶囊、composer 的
 *  「＋ → 命令」以及 `/ask /plan /goal`。
 *  注意与上方 MODES（工作模式 Work/Code/Design）不是一个维度，故另起名。 */
const SESSION_MODES: readonly {
  value: SessionMode;
  label: string;
  detail: string;
}[] = [
  { value: "agent", label: "默认", detail: "直接干活，按上面的权限档询问" },
  { value: "ask", label: "问答", detail: "只读工具，不碰你的项目" },
  { value: "plan", label: "计划模式", detail: "编辑前先出计划" },
  { value: "goal", label: "目标模式", detail: "给一个目标，我跨轮把它做完" },
];

const MODE_ICONS: Record<SessionMode, typeof BotIcon> = {
  agent: BotIcon,
  ask: MessageCircleQuestionIcon,
  plan: ClipboardListIcon,
  goal: TargetIcon,
};

/** 抽屉：合并后的「模型与思考」、权限、能力模式 */
type Picker = "model" | "permission" | "mode";

/** 选中块在分段轨道上的位置与宽度（measure 出来的像素） */
type SegmentSlot = { x: number; width: number };

export default function ChatScreen() {
  const router = useRouter();
  const s = useStyles();
  const { scheme } = useTheme();
  const glass = glassControl(scheme);
  const meta = useComposerMeta();
  const title = useChatTitle();
  // 分页窗（§6）：列表上沿的「加载更多」——引用只在 hasMore/loading 翻转时变，
  // 不会把 Thread 元素的 memo 打散。
  const history = usePiHistory();
  // 用户发过言（线程里有消息）后顶栏中间就交还给标题：mode 分段只在「还没开口
  // 的新对话」占位——一旦聊起来，切档请走胶囊，导航栏该给身份感而不是开关。
  const hasMessages = useAuiState((st) => st.thread.messages.length > 0);

  // Thread 元素 memo 在 bar 上：ChatScreen 因开抽屉/水合通知重渲时，bar 没变
  // 就不给 Thread 新元素，整棵消息树跳过这次父驱动的重渲（树自己该收的 store
  // 更新走 Thread 内部的 hook，不受影响）。转场刚落地那几帧的连击就是这么来的。
  const thread = useMemo(
    () => (
      <Thread
        history={history}
        components={{ Welcome, ComposerToolbar: meta.bar, ToolFallback: ToolCallRow }}
        aboveComposer={<AboveComposer />}
      />
    ),
    [meta.bar, history],
  );

  // 返回键：与首页头部图标组同一套双分支——iOS 26+ 装进系统玻璃圆钮
  // （isInteractive 按压带形变），其余平台用 glassControl 仿玻璃描边圆。
  const backAction = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="返回会话列表"
      hitSlop={12}
      onPress={() => router.replace("/")}
      style={({ pressed }) => [styles.backHit, pressed && { opacity: 0.55 }]}
    >
      <ChevronLeftIcon size={26} strokeWidth={2.2} color={s.foreground} />
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: s.background }]}>
      <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
        {/* iOS 导航栏：返回键只留一枚箭头居左；标题绝对居中在整行上——
            居中相对的是屏幕而不是「剩余空间」，左右按钮宽不宽都压不歪它。 */}
        <View style={styles.navBar}>
          {liquidGlassAvailable ? (
            <GlassView
              glassEffectStyle="regular"
              isInteractive
              colorScheme={scheme}
              style={styles.backShell}
            >
              {backAction}
            </GlassView>
          ) : (
            <View style={[styles.backShell, glassControlCommon, glass]}>
              {backAction}
            </View>
          )}
          {/* 中间那格：空的新对话给模式切换占位（这一格空着最显眼，正好放得下
              切换器）；一旦有消息就交还标题——没标题先显「新对话」占位，智能
              标题/改名到了再跟随刷新。绝对定位铺满整行来居中——跟着返回键的
              宽度排的话，返回键一宽，内容就整体偏左。 */}
          <View style={styles.navCenter}>
            {hasMessages || title ? (
              <Text numberOfLines={1} style={s.navTitleText}>
                {title || "新对话"}
              </Text>
            ) : (
              <ModeSegmented />
            )}
          </View>
        </View>

        {/* 这里**不能**再用 Pressable 把 Thread 包起来收键盘。Pressable 祖先会
            先成为 JS responder，纵向拖动时滚动容器（消息列表）抢不回来，整段
            消息就滑不动了。
            收键盘并不因此缺位——列表自己那两条就够了：keyboardShouldPersistTaps
            ="handled" 管点击（没被控件接住的空白 tap 由列表兜底收起键盘），
            keyboardDismissMode="interactive" 管拖动。外层那个包裹当初只是为了
            空态，而空态现在由 Welcome 自己收（它不在滚动容器里，见下）。 */}
        {thread}
      </SafeAreaView>

      {/* 抽屉挂在页面根上：absoluteFill 是相对定位，放进 footer 里就只剩输入条
          那么高一块，抽屉会被裁掉 */}
      {meta.sheet}
    </View>
  );
}

/** 顶栏标题：优先实时标题表（智能标题/改名即时生效），
 *  首次进会话还没有任何标题事件时回落列表快照。两边都空说明确实还没有标题，
 *  这时顶栏中间那格让给模式切换，所以这里直接返回空串而不是「新对话」。 */
function useChatTitle() {
  const threadId = useAuiState((st) => st.threads.mainThreadId);
  const items = useAuiState((st) => st.threads.threadItems);
  const live = useThreadTitle(threadId);
  const snapshot = items.find((item) => item.id === threadId)?.title;
  return (live ?? snapshot ?? "").trim();
}

/** 底部那一排选择器：合并后的「模型 · 思考」与「权限」两枚。
 *
 *  模型和思考本来是两颗胶囊，各占一百多宽，加上权限一共占了输入条下面整整
 *  一行——那一行里最该显眼的是输入框本身。两者又都是「这一轮怎么跑」的参数，
 *  合并成一颗，语义上也更顺。
 *  抽屉不再把思考混进模型列表：模型抽屉只列模型，每行尾一枚 more 按钮，
 *  点开叠一层二级抽屉选该模型的思考档位（档位按模型的 supportedThinkingLevels
 *  收窄）。Sheet 是 absoluteFill 覆盖层，二级收掉一级还在。
 *  工作模式分段已经挪到顶栏中间那格，新对话时顶栏没有标题可显示，正好由它占位。
 *
 *  返回 bar（交给 components.ComposerToolbar）与 sheet（挂在页面根），
 *  两者共用这份状态。 */
function useComposerMeta() {
  const threadId = useAuiState((st) => st.threads.mainThreadId);
  const { colors } = useTheme();
  const [open, setOpen] = useState<Picker | null>(null);

  const mode = useCurrentAppMode();
  const model = useThreadModel(threadId);
  const models = usePiModels();
  const thinking = useThreadThinking(threadId);
  const session = useSessionMode(threadId);

  // 切线程时水合三颗胶囊的当前值：胶囊读的是各自的本地 store，事实源在
  // sidecar（会话偏好列 + planning state）。不水合的话永远显示默认档——
  // 桌面端三个 picker 都挂了这组 effect，移动端此前漏抄。
  // §6 列表分页：深页会话不在已加载页的镜像里，先按需补单条摘要，到了再水合
  //（subscribeSessionPrefs 触发重跑；模型/思考/权限三处都吃这张表）。
  useEffect(() => {
    if (!threadId) return;
    const hydrate = () => {
      hydrateThreadModel(threadId);
      hydrateThreadThinking(threadId);
      void fetchPlanningState(threadId).catch(() => {});
    };
    ensureSessionSummary(piSessionIdForThread(threadId));
    const unsubscribe = subscribeSessionPrefs(hydrate);
    hydrate();
    return unsubscribe;
  }, [threadId]);

  // 跨端同步（会话屏侧）：桌面/网页端动了**当前会话**
  // - op=deleted：会话没了（转录也删了），退回列表，别停在一个死会话上；
  // - op=updated：改名、归档、换目录、改模式/权限/模型/思考——重拉偏好镜像再水合，
  //   胶囊与顶栏跟着变（这些 setter 在 sidecar 侧都会补发一帧，见 handlers）。
  // 挂在会话屏而不是列表屏：两边各自只在自己可见时管自己的事（列表屏见 index.tsx）。
  useEffect(() => {
    if (!threadId) return;
    const sessionId = piSessionIdForThread(threadId) ?? threadId;
    setSessionsChangedSync((batch) => {
      const frames = batch.frames;
      if (frames.some((f) => f.op === "deleted" && f.sessionId === sessionId)) {
        appRouter.replace("/");
        return;
      }
      if (frames.some((f) => !f.op || f.op === "updated" || f.sessionId === sessionId)) {
        void refreshSessionPrefs().then(() => {
          hydrateThreadModel(threadId);
          hydrateThreadThinking(threadId);
          void fetchPlanningState(threadId).catch(() => {});
        });
      }
    });
    return () => setSessionsChangedSync(null);
  }, [threadId]);

  const modelLabel = model?.modelId ?? "默认";

  // 模型行的 value 前缀（去掉前缀后才是真正的 provider/modelId）
  const MODEL_PREFIX = "model:";

  /** 二级思考抽屉的目标模型（null = 未开）：从模型行尾的 more 按钮进来 */
  const [thinkingFor, setThinkingFor] = useState<{
    provider: string;
    modelId: string;
    label: string;
  } | null>(null);

  // 与桌面端 model-picker 同一口径：只列已配凭据厂商的模型；
  // 被模型过滤隐藏的（enabled=false）也不出现
  const usableModels = useMemo(
    () => models.filter((m) => m.authed && m.enabled !== false),
    [models],
  );

  const modelItems: OptionItem[] = useMemo(
    () =>
      usableModels.map((m) => ({
        value: `${MODEL_PREFIX}${m.provider}/${m.id}`,
        label: m.name || m.id,
        detail: m.providerName,
        more: true,
      })),
    [usableModels],
  );
  const modeItems: OptionItem[] = useMemo(
    () =>
      SESSION_MODES.map((m) => ({ value: m.value, label: m.label, detail: m.detail })),
    [],
  );
  const permissionItems: OptionItem[] = useMemo(
    () => PERMISSIONS.map((p) => ({ value: p.value, label: p.label, detail: p.detail })),
    [],
  );

  // 二级抽屉的档位：目标模型报了 supportedThinkingLevels 就按它收窄
  // （空数组 = 明确不支持推理，只剩「关闭」），没报给全档兜底
  const thinkingItems: OptionItem[] = useMemo(() => {
    const target = thinkingFor
      ? usableModels.find(
          (m) => m.provider === thinkingFor.provider && m.id === thinkingFor.modelId,
        )
      : undefined;
    const supported = target?.supportedThinkingLevels;
    const levels = supported
      ? THINKING_LEVELS.filter((l) => l === "off" || supported.includes(l))
      : [...THINKING_LEVELS];
    return levels.map((level) => ({
      value: level,
      label: THINKING_LEVEL_LABELS[level],
    }));
  }, [thinkingFor, usableModels]);

// 三个选择器合并进 composer，紧挨「＋」按钮（见 components.ComposerToolbar）。
  // 横滑容器由 composer 提供，这里只给内容本身——所以外面不再套 metaWrap /
  // metaRow，间距由 shell 那侧的 gap 统一管。
  // bar 必须按真实依赖 memo：components 对象一路喂进 ThreadComponentsContext，
  // 值一变，消息树里每个 useContext 消费者（每条消息、每个工具行）全部重渲。
  // 进会话时模型/档位/权限几个 store 各自异步到货，不 memo 就是列表被连着重绘。
  const approvalLabel =
    PERMISSIONS.find((p) => p.value === session.approvalLevel)?.label ?? "变更前确认";
  const modeLabel =
    SESSION_MODES.find((m) => m.value === session.mode)?.label ?? "默认";
  const ModeIcon = MODE_ICONS[session.mode] ?? BotIcon;
  const bar = useMemo(
    () => (
      <View style={styles.pillRow}>
        {/* 模型与思考合并成一颗：值用「·」连起来，一眼能看完这一轮怎么跑 */}
        <MetaPill
          icon={<GaugeIcon size={14} strokeWidth={1.9} />}
          label="模型"
          value={`${modelLabel} · ${THINKING_LEVEL_LABELS[thinking]}`}
          onPress={() => {
            // 凭据/过滤可能在设置里改过，打开前刷一次目录
            refreshPiModels();
            setOpen("model");
          }}
        />
        <MetaPill
          icon={
            <ShieldIcon
              size={14}
              strokeWidth={1.9}
              // 完全访问 = 全部自动执行：与桌面端 mode-picker 同款警示色
              {...(session.approvalLevel === "auto" ? { color: colors.warning } : {})}
            />
          }
          label="权限"
          value={approvalLabel}
          {...(session.approvalLevel === "auto" ? { tone: "warning" as const } : {})}
          onPress={() => setOpen("permission")}
        />
        {/* 能力模式（问答/计划/目标）：默认档也显示——手机没有 Shift+Tab，胶囊是
            唯一的「现在是什么形态 / 怎么切」的一眼入口（桌面端只在能力档渲染） */}
        <MetaPill
          icon={<ModeIcon size={14} strokeWidth={1.9} />}
          label="模式"
          value={modeLabel}
          onPress={() => setOpen("mode")}
        />
      </View>
    ),
    [modelLabel, thinking, approvalLabel, modeLabel, ModeIcon, session.approvalLevel, colors.warning],
  );

  // 抽屉：模型一层（行尾 more）+ 思考二级叠在上面；权限是另一颗胶囊的一层。
  // 二级不关一级——Sheet 是 absoluteFill 覆盖层，直接叠，收掉二级还剩一级。
  const sheet = (
    <>
      {open === "model" ? (
        <OptionSheet
          title="模型"
          items={modelItems}
          value={model ? `${MODEL_PREFIX}${model.provider}/${model.modelId}` : undefined}
          onSelect={(value) => {
            const body = value.slice(MODEL_PREFIX.length);
            const [provider, ...rest] = body.split("/");
            if (!provider || rest.length === 0) return;
            void setThreadModel(threadId, { provider, modelId: rest.join("/") });
          }}
          onMore={(value) => {
            const body = value.slice(MODEL_PREFIX.length);
            const [provider, ...rest] = body.split("/");
            const modelId = rest.join("/");
            if (!provider || !modelId) return;
            const hit = usableModels.find(
              (m) => m.provider === provider && m.id === modelId,
            );
            setThinkingFor({
              provider,
              modelId,
              label: hit?.name || modelId,
            });
          }}
          onClose={() => {
            setOpen(null);
            setThinkingFor(null);
          }}
        />
      ) : null}
      {thinkingFor ? (
        <OptionSheet
          title={`思考 · ${thinkingFor.label}`}
          items={thinkingItems}
          // 勾只在该模型就是当前模型时有意义：档位是会话级，别的模型的
          // 当前档位无从知道，显示会话档位会误导
          value={
            model && model.provider === thinkingFor.provider && model.modelId === thinkingFor.modelId
              ? thinking
              : undefined
          }
          onSelect={(level) => {
            // 从非当前模型的 more 进来：先把这一轮切到该模型，再落档位
            if (
              !model ||
              model.provider !== thinkingFor.provider ||
              model.modelId !== thinkingFor.modelId
            ) {
              void setThreadModel(threadId, {
                provider: thinkingFor.provider,
                modelId: thinkingFor.modelId,
              });
            }
            void setThreadThinking(threadId, level as (typeof THINKING_LEVELS)[number]);
            setThinkingFor(null);
          }}
          onClose={() => setThinkingFor(null)}
        />
      ) : null}
      {open === "mode" ? (
        <OptionSheet
          title="模式"
          items={modeItems}
          value={session.mode}
          onSelect={(value) => {
            void setSessionMode(threadId, value as SessionMode);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open === "permission" ? (
        <OptionSheet
          title="权限"
          items={permissionItems}
          value={session.approvalLevel}
          onSelect={(value) => {
            // 审批级别只在 agent 模式下有意义，其余模式保持不动
            const next = session.mode === "ask" || session.mode === "plan" ? session.mode : "agent";
            void setSessionMode(threadId, next, value as ApprovalLevel);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );

  return { bar, sheet };
}

/** 工作模式分段控件：work / code / design，走会话定靶（set_app_mode 带 sessionId） */
function ModeSegmented() {
  const s = useStyles();
  const threadId = useAuiState((st) => st.threads.mainThreadId);
  const mode = useCurrentAppMode();
  // 三项的位置全部量出来存着：onLayout 只在布局**变化**时触发，而切换选中项
  // 并不改变任何一项的布局，所以不能指望它第二次触发。量完按下标取，
  // 切换时才拿得到新位置。
  const [slots, setSlots] = useState<Record<string, SegmentSlot>>({});
  const slide = useRef(new Animated.Value(1)).current;
  // 滑块渲染在**目标**落点上，再用一个 translateX 把它从上一格拉过去。
  // 这样切换时不用等布局回调，直接就能动。
  const prevSlot = useRef<SegmentSlot | null>(null);
  const [offset, setOffset] = useState(0);
  // 只在按下时压一下松手弹回来：不给按压反馈的话，分段控件看起来像坏了
  const press = useRef(new Animated.Value(0)).current;

  const onSelect = (value: AppMode) => {
    if (value === mode) return;
    void setThreadAppMode(threadId, value);
  };

  const measure = (value: AppMode) => (event: LayoutChangeEvent) => {
    const { width, x } = event.nativeEvent.layout;
    setSlots((prev) => {
      const hit = prev[value];
      if (hit && Math.abs(hit.x - x) < 0.5 && Math.abs(hit.width - width) < 0.5) {
        return prev;
      }
      return { ...prev, [value]: { x, width } };
    });
  };

  const slot = slots[mode];

  useEffect(() => {
    if (!slot) return;
    const prev = prevSlot.current;
    prevSlot.current = slot;
    setOffset(prev ? prev.x - slot.x : 0);
    slide.setValue(0);
    Animated.spring(slide, { toValue: 1, ...SPRING, useNativeDriver: NATIVE }).start();
    // offset 不进依赖：它就是这轮动画的起点，跟着 slot 走一轮就够
  }, [mode, slot, slide]);

  return (
    <View style={[styles.segment, { backgroundColor: s.segmentTrack }]}>
      {slot ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.segmentThumb,
            {
              backgroundColor: s.segmentActiveBg,
              width: slot.width,
              left: slot.x,
              transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) }],
            },
          ]}
        />
      ) : null}
      {MODES.map((item) => {
        const active = item.value === mode;
        return (
          // 缩放动画必须挂在 Animated 组件上：interpolate 的结果直接塞进
          // 普通 Pressable 的 style，web 端 processTransform 会当场抛错
          <Animated.View
            key={item.value}
            onLayout={measure(item.value)}
            style={{
              transform: [
                {
                  scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] }),
                },
              ],
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(item.value)}
              onPressIn={() =>
                Animated.spring(press, {
                  toValue: 1,
                  damping: 22,
                  stiffness: 400,
                  mass: 0.5,
                  useNativeDriver: Platform.OS !== "web",
                }).start()
              }
              onPressOut={() =>
                Animated.spring(press, {
                  toValue: 0,
                  damping: 16,
                  stiffness: 240,
                  mass: 0.7,
                  useNativeDriver: Platform.OS !== "web",
                }).start()
              }
              style={styles.segmentItem}
            >
              <Animated.Text
                style={[
                  s.segmentText,
                  {
                    color: active ? s.foreground : s.muted,
                    opacity: press.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }),
                  },
                ]}
              >
                {item.label}
              </Animated.Text>
            </Pressable>
          </Animated.View>
        );
      })}
    </View>
  );
}

function MetaPill({
  icon,
  label,
  value,
  tone,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** 高危档的警示色（如权限=完全访问）：图标与值都用警告色，与桌面端
   *  mode-picker 的高危档同款（那边是 amber-600/amber-400） */
  tone?: "warning";
  onPress: () => void;
}) {
  const s = useStyles();
  const { colors: themeColors } = useTheme();
  // 按下时缩一点而不是只变淡：iOS 上按钮的反馈是「被压下去」，
  // 光是 opacity 变化在快速连点时几乎看不见，手感就发木
  const press = useRef(new Animated.Value(0)).current;

  const to = (v: number, stiffness: number) =>
    Animated.spring(press, {
      toValue: v,
      damping: 20,
      stiffness,
      mass: 0.6,
      useNativeDriver: NATIVE,
    }).start();

  return (
    <Animated.View
      style={{
        transform: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] }) }],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}：${value}`}
        onPress={onPress}
        onPressIn={() => to(1, 400)}
        onPressOut={() => to(0, 260)}
        style={[
          styles.pill,
          { backgroundColor: s.pillBg, borderColor: s.pillBorder },
        ]}
      >
        <View style={{ opacity: 0.7 }}>{icon}</View>
        {/* 「模型」「权限」这两个词不画出来：图标已经说明是哪一项，值才是要读的
            信息，两个词占着宽度把值挤窄。label 仍留在 accessibilityLabel 里，
            读屏时还得说清楚这一颗是什么。 */}
        <Text
          numberOfLines={1}
          style={[
            s.pillValue,
            tone === "warning" && { color: themeColors.warning, fontWeight: "600" },
          ]}
        >
          {value}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** 空态欢迎语：逐字打出来的大字问句 + 一排起步建议。
 *
 *  三个细节必须在这里自己补：官方 ThreadWelcome 的 `px-4` 与 `mb-6` 写在那份
 *  默认组件**内部**，覆盖掉它之后这层 padding 一起没了；官方那条建议条读的是
 *  runtime 的 suggestions adapter，Pi 这边没有接，所以起步建议直接由本组件画；
 *  视口空态是 justify-center，欢迎语撑一个 flex:1 自己居中，底部那条 composer
 *  才会贴到屏幕下沿——否则整块（欢迎语 + 输入条）被一起顶到中间，下面空一大片。
 *
 *  收键盘也由这一层负责：空态没有消息列表可以挂 keyboardDismissMode，而外层
 *  又不能再套 Pressable（会掐死列表的滚动）。这里的 Pressable 是安全的——
 *  空态时欢迎语是视口的兄弟节点，不在任何滚动容器里面。 */
function Welcome() {
  const s = useStyles();
  const setText = useAui().composer.setText;
  const typed = useTypewriter(GREETING_LINES);
  const total = GREETING_LINES.join("").length;
  const typedCount = typed.join("").length;
  const typing = typedCount < total;

  // 建议条等问句打完之后再上：字还在动的时候下面已经有东西在动，读起来赶
  const startersIn = useEntrance(typing ? null : 260);
  // 键盘一弹就把建议条收掉：这一条输入框才是当下要用的，起步建议这时候
  // 只会占着空间把问句往上顶。收起是带动画的，不是硬切。
  const keyboardUp = useKeyboardVisible();
  const [gone, setGone] = useState(false);

  // 卸载要等最后一颗也收完。提前摘掉容器的话 opacity 归零的那 78 高空位
  // 留在原地，欢迎语还是被顶在上面，看着像卡片自己蒸发了一块地。
  useEffect(() => {
    if (!keyboardUp) {
      setGone(false);
      return;
    }
    const timer = setTimeout(
      () => setGone(true),
      STARTER_OUT_STAGGER_MS * (STARTERS.length - 1) + STARTER_SPRING_SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, [keyboardUp]);

  const firstLen = GREETING_LINES[0].length;
  const caretOnFirst = typedCount < firstLen;

  return (
    // 敲空态任意空白处收键盘。accessible/focusable 关掉：这层不是控件，
    // 别让它进无障碍树和焦点顺序
    <Pressable
      accessible={false}
      focusable={false}
      onPress={dismissKeyboard}
      style={s.welcome}
    >
      <View style={styles.greetLine}>
        <Text style={s.welcomeText}>{typed[0]}</Text>
        {caretOnFirst ? (
          <TypeCaret color={s.foreground} height={30} on={typing} />
        ) : null}
      </View>
      <View style={styles.greetLine}>
        <Text style={s.welcomeText}>{typed[1]}</Text>
        {!caretOnFirst ? (
          <TypeCaret color={s.foreground} height={30} on={typing} />
        ) : null}
      </View>

      {gone && keyboardUp ? null : (
        <Animated.View
          style={[
            s.starters,
            { opacity: startersIn.opacity, transform: [{ translateY: startersIn.y }] },
          ]}
        >
          {STARTERS.map((item, index) => (
            <StarterChip
              key={item.label}
              index={index}
              icon={item.icon}
              label={item.label}
              hidden={keyboardUp}
              onPress={() => setText(item.prompt)}
            />
          ))}
        </Animated.View>
      )}
    </Pressable>
  );
}

/** 一颗起步建议。
 *
 *  进场是 0 → 1，退场是同一条弹簧的 1 → 0，逐颗错开、方向相反：三颗是一颗一颗
 *  落位的，就该一颗一颗收回去。之前退场画在整行容器上（一次性淡掉 + 整行位移），
 * 容器自己一层位移、每颗又一层位移，两层 transform 叠着走，看起来像整块被抽走，
 * 跟落位时逐颗浮现的节奏对不上。退场交给每颗自己，才和进场是同一套运动。
 *
 *  `hidden` 只在这颗挂载那一刻读一次（存进 hiddenOnMount）：键盘先到、问句还没
 *  打完的时候，这一挂根本没有入场可倒放，直接就站在退场起点。存成 ref 而不是进
 *  useEffect 依赖，是因为后面 hidden 翻成 true 会重跑进场那个 effect，那时入场
 *  弹簧正在飞，中途 setValue 就踩到 Fabric 的 stopTracking 崩溃。 */
function StarterChip({
  index,
  hidden,
  icon: Icon,
  label,
  onPress,
}: {
  index: number;
  hidden: boolean;
  icon: typeof CompassIcon;
  label: string;
  onPress: () => void;
}) {
  const s = useStyles();
  const anim = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(hidden ? 0 : 1)).current;
  const press = useRef(new Animated.Value(0)).current;
  const hiddenOnMount = useRef(hidden).current;

  useEffect(() => {
    if (hiddenOnMount) {
      anim.setValue(1);
      return;
    }
    const timer = setTimeout(() => {
      Animated.spring(anim, {
        toValue: 1,
        ...STARTER_SPRING,
        useNativeDriver: NATIVE,
      }).start();
    }, index * STARTER_IN_STAGGER_MS);
    return () => clearTimeout(timer);
  }, [anim, index]);

  useEffect(() => {
    if (!hidden) return;
    // 倒着收：最右边那颗先走，一颗接一颗退回去
    const timer = setTimeout(() => {
      Animated.spring(exit, {
        toValue: 0,
        ...STARTER_SPRING,
        useNativeDriver: NATIVE,
      }).start();
    }, (STARTERS.length - 1 - index) * STARTER_OUT_STAGGER_MS);
    return () => clearTimeout(timer);
  }, [exit, hidden, index]);

  return (
    <Animated.View
      style={[
        // 动画这层也得 flex:1，不然它按内容收缩，flex:1 落在里面的 Pressable 上
        // 就失效——三列会挤在左边，右边空出一大块
        styles.starterSlot,
        {
          opacity: Animated.multiply(anim, exit),
          transform: [
            {
              translateY: Animated.add(
                anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
                exit.interpolate({ inputRange: [0, 1], outputRange: [0, 10] }),
              ),
            },
            { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] }) },
          ],
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        // 只填不发：把话递到输入框，让人自己看一眼再决定要不要改
        onPress={onPress}
        onPressIn={() =>
          Animated.spring(press, {
            toValue: 1,
            damping: 22,
            stiffness: 400,
            mass: 0.5,
            useNativeDriver: NATIVE,
          }).start()
        }
        onPressOut={() =>
          Animated.spring(press, {
            toValue: 0,
            damping: 15,
            stiffness: 240,
            mass: 0.7,
            useNativeDriver: NATIVE,
          }).start()
        }
        style={[
          styles.starter,
          { backgroundColor: s.starterBg, borderColor: s.starterBorder },
        ]}
      >
        {/* 图标在上、文字在下：三列并排时每列只有 114 宽，横排会把
            「图标 + 四个字」挤成 3:1 的长条，扁得不像个按钮。竖起来
            每颗接近方形，三列才立得住 */}
        <Icon size={19} strokeWidth={1.8} color={s.muted} />
        <Text numberOfLines={1} style={s.starterText}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** 逐字显示。等间隔的打字机：一次一格，不用 requestAnimationFrame，
 *  组件卸载时定时器自然被清掉。间隔取共享常量，跟配对页的品牌区同速。 */
function useTypewriter(lines: readonly string[]) {
  const total = lines.join("").length;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (count >= total) return;
    const timer = setTimeout(() => setCount((c) => c + 1), TYPE_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [count, total]);

  let rest = count;
  return lines.map((line) => {
    const take = Math.max(0, Math.min(line.length, rest));
    rest -= take;
    return line.slice(0, take);
  });
}

/** 入场：淡入 + 上移。delay 传 null 表示「先别动」，调用方换个条件再传回来。 */
function useEntrance(delay: number | null) {
  const anim = useRef(new Animated.Value(0)).current;
  const started = useRef(false);

  useEffect(() => {
    if (delay === null) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    const timer = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: ENTER_MS,
        easing: IOS_EASE,
        useNativeDriver: NATIVE,
      }).start();
    }, delay);
    return () => clearTimeout(timer);
  }, [anim, delay]);

  return {
    // 还没轮到的阶段直接给 0，不用 anim.setValue(0) —— 强行打断在飞的
    // 动画同样会踩到 Fabric 那条 stopTracking 崩溃
    opacity: delay === null ? 0 : anim,
    y: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
  };
}

/** composer 上方那一槽。模型/权限/思考已经搬进 composer 内部（ComposerToolbar），
 *  这里只剩真正「浮在输入条之上」的东西：面板药丸（计划 / 文件变更 / 终端 /
 *  引用 → 底部抽屉，桌面端右侧 agent-panel 的移动端对应物）、排队条、审批卡与
 *  提问卡（pi-interactions 台账版，键 = pi sessionId）。工具关联的旧
 *  hostUiRequests 旁路在移动端恒空，已移除。 */
function AboveComposer() {
  return (
    <View style={{ gap: 8 }}>
      <AgentPanelBar />
      <QueueBar />
      <ToolApprovalCard />
      <QuestionCard />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    height: 44,
  },
  // 绝对居中在整行上：不跟着返回键的宽度挤，长标题左右各让出 64 后居中截断
  navCenter: {
    position: "absolute",
    left: 64,
    right: 64,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  greetLine: { flexDirection: "row", alignItems: "flex-end" },
  // 返回键玻璃圆钮壳：40 直径正圆，与首页胶囊同一描边策略（描边只属于仿玻璃分支）
  backShell: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginLeft: 12,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  // 壳内命中层：铺满圆壳并居中箭头
  backHit: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    padding: 3,
    gap: 2,
  },
  segmentItem: {
    paddingHorizontal: 16,
    height: 30,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  // 选中块绝对定位在轨道上，随选中项滑过去
  segmentThumb: {
    position: "absolute",
    top: 3,
    bottom: 3,
    borderRadius: 999,
    shadowColor: "#0b1020",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  // 选择器那条横排。横滑容器在 composer 那侧，这里只是内容，所以只有方向和间距
  pillRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // 宽度靠根轴分配：flexBasis 0 + grow/shrink 1，iOS 与网页算法一致。
  // 写成 flex:1 也等价，但这里把三项摊开——这层一旦漏掉某个平台行为不同的
  // 简写，就又变成"网页对、手机塌"的那类问题
  starterSlot: { flexGrow: 1, flexShrink: 1, flexBasis: "0%", minWidth: 0 },
  starter: {
    // 不能再 flex:1：slot 在行容器里、它自己的高度来自内容，chip 再把主轴
    // basis 归零就互相等 0，整颗塌成 38 高的扁条，文字也被挤没了。
    // 高度交给 height 自己定，宽度吃满 slot（slot 是列容器，默认 stretch）。
    width: "100%",
    // 竖排：图标在上、文字在下。114 宽的一列横着摆「图标+四个字」会得到
    // 3:1 的长条，扁得像被人压过；竖过来接近方形，三列才立得住
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 78,
    paddingHorizontal: 6,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

function useStyles() {
  const { colors, fontWeight } = useTheme();
  return useMemo(
    () => ({
      background: colors.background,
      foreground: colors.foreground,
      muted: colors.mutedForeground,
      segmentTrack: withAlpha(colors.foreground, 0.06),
      // 滑块用纯底色而不是半透明叠加：叠在同色轨道上只会糊成一团，看不出选中
      segmentActiveBg: colors.background,
      segmentText: {
        color: colors.mutedForeground,
        fontSize: 14,
        fontWeight: fontWeight("600"),
      },
      segmentTextActive: { color: colors.foreground, fontWeight: fontWeight("700") },
      // 导航栏标题：iOS 的 17pt 半粗，压一点字距让长标题更耐挤
      navTitleText: {
        color: colors.foreground,
        fontSize: 17,
        fontWeight: fontWeight("600"),
        letterSpacing: -0.2,
        // 单行标题靠行高在 44 高的导航栏里垂直居中（绝对定位框已铺满整行）
        lineHeight: 44,
        // 占满居中框：不然它按内容收缩，长标题顶到边上也不换行、不截断
        width: "100%" as const,
        textAlign: "center" as const,
      },
      pillBg: withAlpha(colors.foreground, 0.04),
      pillBorder: withAlpha(colors.foreground, 0.12),
      // 只剩值一个文本了，宽度可以放宽一截：少了「模型 / 权限」两个词，
      // 省下的横向空间正好让「默认 · 关闭」这类长值不用截断
      pillValue: {
        color: colors.foreground,
        fontSize: 13,
        fontWeight: fontWeight("600"),
        maxWidth: 190,
      },
      // flex:1 + 自身居中：视口空态是 justify-center，不自己撑开的话
      // 欢迎语和 composer 会作为一整块被顶到屏幕中间，下面空一大片
      welcome: {
        flex: 1,
        justifyContent: "center" as const,
        paddingHorizontal: 16,
      },
      welcomeText: {
        color: colors.foreground,
        fontSize: 30,
        lineHeight: 42,
        fontWeight: fontWeight("500"),
        letterSpacing: -0.6,
        textAlign: "left" as const,
      },
      starters: {
        // 必须是 row：三颗建议并排一行，宽度就在这条根轴上分配。
        // 之前误写成 column + alignItems:stretch——网页端 stretch 照常生效、
        // 三颗各占满一行看着没毛病，但 iOS 的 Yoga 不对 flexBasis:0 的子节点
        // 做交叉轴 stretch，宽度会塌回内容宽，手机上就成了挤在左边的窄条。
        flexDirection: "row" as const,
        // 同一行里各颗等高，高度由 chip 自己的 height:78 定
        alignItems: "stretch" as const,
        gap: 8,
        marginTop: 22,
      },
      starterBg: withAlpha(colors.foreground, 0.04),
      starterBorder: withAlpha(colors.foreground, 0.12),
      starterText: {
        color: colors.foreground,
        fontSize: 14,
        fontWeight: fontWeight("500"),
        flexShrink: 1,
      },
    }),
    [colors, fontWeight],
  );
}