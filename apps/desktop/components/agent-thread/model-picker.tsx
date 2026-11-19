"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuFilter,
  DropdownMenuItem,
  DropdownMenuList,
  DropdownMenuSearchInput,
  DropdownMenuSeparator,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineSlider } from "@/components/custom-ui/range-slider-inline";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import { HoverScrollText } from "@/components/ui/hover-scroll-text";
import { cn } from "@/lib/utils";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import { modelCapabilityBadges } from "@/lib/pi/pi-model-groups";
import { hydrateThreadModel, setThreadModel } from "@/lib/pi/pi-session-model";
import { useModelGate } from "@/lib/pi/pi-model-gate";
import { useSendLock } from "@/lib/pi/pi-send-lock";
import { setSelectedModel } from "@/lib/model/model-settings";
import {
  hydrateThreadThinking,
  setThreadThinking,
  useThreadThinking,
} from "@/lib/pi/pi-session-thinking";
import {
  setThinkingLevel,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  type ThinkingLevel,
} from "@/lib/settings/thinking-settings";
import {
  THINKING_DEPTH_LABELS,
  thinkingCometLevel,
  thinkingDepthZone,
} from "@/lib/model/thinking-depth";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";

/**
 * 对话页模型选择器（两级，交互对齐 ZCode 的合并选择菜单）：
 *
 * - 主面板 =「当前服务头 + 模型列表 + 思考深度」。服务头是独立菜单触发器
 *   （不是外层菜单项，不占 ↑/↓ 序列），模型行带能力徽标（视觉等，见
 *   modelCapabilityBadges），点击即定靶该模型。
 * - 服务菜单 = 服务列表（图标 + 名称 + 模型数徽标 + 当前服务勾选）+「管理模型」
 *   入口（跳设置 → 模型）。点服务只切换主面板浏览的服务、不关闭主菜单；
 *   悬浮服务头同样展开（openOnHover）。
 * - 搜索（服务头下方）：只在当前浏览服务的模型里过滤（模型名 / id 命中，
 *   空白分词全部命中）。服务头保持可见——它标出搜索范围，切服务后同一搜索词
 *   直接在新分组里继续过滤。键盘交互交给 Base UI 的可搜索菜单（打开即聚焦
 *   搜索框、↑/↓ 挪高亮、回车选中）。
 * - 思考深度并入面板底部（原先 composer 里独立的 ThinkingPicker 入口移除，
 *   与 ZCode 的合并菜单一致）：档位按当前模型的 supportedThinkingLevels
 *   收窄，不支持推理的模型只剩「关闭」，滑杆禁用。
 *
 * 选择仍经定靶 set_model 只落当前会话；思考档位同款走 pi-session-thinking。
 * 发送锁（useSendLock）：消息发送完成前禁止切换模型/档位，见 pi-send-lock；
 * 但菜单本身仍可打开浏览/搜索——被锁的是选项与滑杆，不是触发器。
 *
 * showEffort：是否渲染面板底部的思考深度区。默认 true（所有能力档都显示）；
 * 留给确实要收窄底栏的调用方按需关闭（原先问答档隐藏，已按「档位与模式
 * 正交」的结论放开——隐藏入口只会让用户以为不能调）。
 */
export const PiModelPicker: FC<{ showEffort?: boolean }> = ({
  showEffort = true,
}) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const modelLocked = useSendLock();
  const allModels = usePiModels();
  const gate = useModelGate();
  const thinkingLevel = useThreadThinking(threadId);

  const [open, setOpen] = useState(false);
  /** 搜索词：由 DropdownMenuFilter 控制；关闭面板时 Base UI 会回调清空 */
  const [query, setQuery] = useState("");
  /** 子菜单里点选后浏览的服务（null = 跟随当前选中模型的服务） */
  const [browseKey, setBrowseKey] = useState<string | null>(null);
  const [providerSubOpen, setProviderSubOpen] = useState(false);
  /** 滑杆拖动中的草稿档位：拖动只更新草稿，停 150ms 才真正下发（见
   *  handleEffortChange），避免途经的每个档位都写一次 sidecar */
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  /** 触发器值滚动过渡：系统开了「减少动效」时直接切换，不播动画 */
  const reducedMotion = useReducedMotion();

  // 切线程时水合该会话记住的模型与档位（无记忆时：新对话 → 最近使用 → 默认；
  // 已建会话只回落默认，见 pi-session-model）
  useEffect(() => {
    if (!threadId) return;
    hydrateThreadModel(threadId);
    hydrateThreadThinking(threadId);
  }, [threadId]);

  // 只查配置过的：无凭据的服务整体隐藏；被模型过滤隐藏的（enabled=false）也不出现
  const models = useMemo(
    () => allModels.filter((m) => m.authed && m.enabled !== false),
    [allModels],
  );

  // 按服务名分组（同名服务合并，与设置页分组的既有口径一致）
  const groups = useMemo(() => {
    const byTitle = new Map<string, ProviderGroup>();
    for (const m of models) {
      const title = m.providerName || m.provider;
      const group = byTitle.get(title);
      if (group) group.models.push(m);
      else byTitle.set(title, { key: title, title, providerId: m.provider, models: [m] });
    }
    return [...byTitle.values()];
  }, [models]);

  const selectedModel = useMemo(
    () =>
      gate.selected
        ? models.find(
            (m) =>
              m.provider === gate.selected!.provider &&
              m.id === gate.selected!.modelId,
          )
        : undefined,
    [models, gate.selected],
  );
  const selectedGroup = useMemo(
    () =>
      selectedModel
        ? groups.find((g) =>
            g.models.some(
              (m) => m.provider === selectedModel.provider && m.id === selectedModel.id,
            ),
          )
        : undefined,
    [groups, selectedModel],
  );
  const activeGroup =
    (browseKey ? groups.find((g) => g.key === browseKey) : undefined) ??
    selectedGroup ??
    groups[0];

  /** 搜索只在当前浏览服务内过滤；服务头不参与匹配，搜索中始终可切换。
   *  useMemo 按服务分组缓存：输入每个字符只重算当前分组的模型，不碰其他服务 */
  const searchNeedle = query.trim();
  const filteredModels = useMemo(() => {
    const models = activeGroup?.models ?? [];
    if (searchNeedle === "") return models;
    return models.filter((m) =>
      matchModelQuery(modelSearchLabel(m), searchNeedle),
    );
  }, [activeGroup, searchNeedle]);
  const noMatches = searchNeedle !== "" && filteredModels.length === 0;

  const selectedLabel = selectedModel
    ? selectedModel.name || selectedModel.id
    : gate.selected
      ? `${gate.selected.provider}/${gate.selected.modelId}`
      : undefined;

  /**
   * 触发器显示值快照：菜单打开期间冻结，关闭时才切到最新值并播放滚动动画。
   * 选择发生在菜单开着的时候——动画若在那一刻播，正好被菜单盖住看不见；
   * 冻结到关闭瞬间再滚（ZCode 的触发器过渡同样挂在关闭时机）。
   */
  const currentShown = useMemo(
    () => ({
      key: `${gate.selected?.provider ?? ""}/${gate.selected?.modelId ?? ""}:${
        showEffort ? thinkingLevel : ""
      }`,
      provider: gate.selected?.provider,
      modelId: gate.selected?.modelId,
      providerName: selectedModel?.providerName,
      label: selectedLabel,
      levelLabel:
        showEffort && thinkingLevel !== "off"
          ? THINKING_LEVEL_LABELS[thinkingLevel]
          : null,
    }),
    [
      gate.selected?.provider,
      gate.selected?.modelId,
      selectedModel?.providerName,
      selectedLabel,
      showEffort,
      thinkingLevel,
    ],
  );
  const [shown, setShown] = useState(currentShown);
  /** 退出中的旧值：keyed 新值进入动画播放期间，旧值以绝对定位克隆同步上滑淡出，
   *  形成完整的「滚动」而非「闪一下」。都用 CSS 动画（合成器），无 JS 逐帧 */
  const [leaving, setLeaving] = useState<typeof currentShown | null>(null);
  const leaveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (open) return;
    if (currentShown.key === shown.key) {
      // 选择没变、只是展示值变了：模型目录是异步到的——挂载首帧 models 还空着，
      // 触发器只能回落到 `provider/modelId`（custom-xxx/... 那种裸 id），目录到货
      // 后才有真实模型名。这不是一次选择变更，不能落在下面的 keyed 更新里（key
      // 不变就永远不刷新，裸 id 会一直冻在触发器上）；原地换快照、不播滚动动画。
      if (
        currentShown.label !== shown.label ||
        currentShown.providerName !== shown.providerName
      ) {
        setShown(currentShown);
      }
      return;
    }
    setLeaving(shown);
    setShown(currentShown);
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      setLeaving(null);
      leaveTimer.current = null;
    }, 170);
  }, [open, currentShown, shown]);
  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
      if (effortCommitTimer.current !== null) {
        window.clearTimeout(effortCommitTimer.current);
      }
    },
    [],
  );

  // 档位按当前模型的可用集收窄（undefined = 目录未加载/未知 → 全档；
  // 空数组 = 明确不支持推理 → 只剩 off）
  const levels = useMemo<ThinkingLevel[]>(() => {
    const supported = selectedModel?.supportedThinkingLevels;
    return THINKING_LEVELS.filter(
      (v) => v === "off" || !supported || supported.includes(v),
    );
  }, [selectedModel]);
  const levelIndex = Math.max(0, levels.indexOf(thinkingLevel));
  const shownIndex = draftIndex ?? levelIndex;
  const shownLevel = levels[shownIndex] ?? "off";
  const depthZone = thinkingDepthZone(shownLevel);
  // 彗星从第二档开始出现，随档位升高流星条数/渐变强度递增；关闭档没有
  const cometLevel = thinkingCometLevel(shownIndex, levels.length);
  const sliderDisabled = modelLocked || levels.length < 2;

  const selectModel = (m: PiModelSummary) => {
    // 发送锁期间只读：菜单可浏览，但定靶 set_model 会即时改写进行中/排队中
    // 消息的应答模型，与发送时刻的选择相违（见 pi-send-lock）
    if (modelLocked) return;
    const model = { provider: m.provider, modelId: m.id };
    if (
      gate.selected?.provider === model.provider &&
      gate.selected.modelId === model.modelId
    ) {
      return;
    }
    if (threadId) {
      void setThreadModel(threadId, model);
    } else {
      // 无主线程上下文（理论不可达）：退化为纯全局选择
      void setSelectedModel(model);
    }
  };

  const commitLevel = (level: ThinkingLevel) => {
    setDraftIndex(null);
    if (modelLocked || level === thinkingLevel) return;
    if (threadId) {
      void setThreadThinking(threadId, level);
    } else {
      // 无主线程上下文（理论不可达）：退化为纯默认档位变更
      void setThinkingLevel(level);
    }
  };

  /** InlineSlider 拖动节流：每次变化只更新本地草稿，停 150ms 才真正下发
   *  set_thinking——拖动途经的每个档位不逐个写 sidecar（面板读数走草稿即时跟手） */
  const effortCommitTimer = useRef<number | null>(null);
  const handleEffortChange = (index: number) => {
    const rounded = Math.round(index);
    setDraftIndex(rounded);
    if (effortCommitTimer.current !== null) {
      window.clearTimeout(effortCommitTimer.current);
    }
    effortCommitTimer.current = window.setTimeout(() => {
      effortCommitTimer.current = null;
      commitLevel(levels[rounded] ?? "off");
    }, 150);
  };

  const openModelSettings = () => {
    // 与设计主题选择器同款：设置页监听该事件跳转分区（base.tsx 收敛校验）
    window.dispatchEvent(
      new CustomEvent("kova:open-settings-section", { detail: "models" }),
    );
  };

  return (
    <ModelMenuFilter
      enabled={models.length > 0}
      value={query}
      onValueChange={setQuery}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            // 每次打开回到「当前选中模型的服务」、清空搜索，并刷新目录
            setBrowseKey(null);
            setProviderSubOpen(false);
            setDraftIndex(null);
            setQuery("");
            refreshPiModels();
          }
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              // inline-flex items-center 不能少：原生 button 缺省是行内格式上下文，
              // 图标/文字按基线排会撑高按钮盒、文字贴到边缘（旧选择器由
              // ModelSelector.Trigger 的 size 变体自带这套布局，换成原生按钮后要显式给）
              className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 max-w-60 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors [&>span]:min-w-0 [&>svg]:size-3.5 @max-2xl:px-2"
              title={
                modelLocked
                  ? "回复进行中：可查看模型，本轮与排队消息完成后才能切换"
                  : selectedLabel
              }
            >
              {shown.provider && (
                <ProviderIcon
                  provider={shown.provider}
                  modelId={shown.modelId}
                  providerName={shown.providerName}
                />
              )}
              {/* 值滚动过渡：显示值在菜单关闭时才切换（见 currentShown 注释）。
                  整行高度（h-5 = 20px）的纯位移滚动（motion/react）：新值自下
                  滑入、旧值以绝对定位克隆向上滑出，两条动画同速同缓动 → 任意
                  中间帧首尾相接，零重叠零间隙。不做淡入淡出（半透明交叠会显重影）。
                  motion 动画写内联样式、结束值保留，旧克隆到点由定时器移除时不会
                  弹回原位（CSS animate-out 的 fill-mode:none 会在动画结束后回弹，
                  那正是 150~170ms 之间重影的来源）。motion-reduce 直接切换。 */}
              <span className="relative flex h-5 min-w-0 items-center overflow-hidden">
                <motion.span
                  key={shown.key}
                  className="flex min-w-0 items-center gap-1.5"
                  initial={{ y: reducedMotion ? 0 : 20 }}
                  animate={{ y: 0 }}
                  transition={{
                    duration: reducedMotion ? 0 : 0.15,
                    ease: [0.4, 0, 0.2, 1],
                  }}
                >
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      shown.label && "@max-2xl:hidden",
                    )}
                  >
                    {shown.label ?? (
                      <span className="text-muted-foreground">请选择模型</span>
                    )}
                  </span>
                  {/* 触发器合并显示当前思考档位（与面板底部同源）；关闭态不挂字，
                      档位名收进面板可见。问答档不显示（那里没有该决策） */}
                  {shown.levelLabel && (
                    <span className="text-muted-foreground/80 shrink-0 text-sm @max-2xl:hidden">
                      {shown.levelLabel}
                    </span>
                  )}
                </motion.span>
                {!reducedMotion && leaving && leaving.key !== shown.key && (
                  <motion.span
                    key={`leave-${leaving.key}`}
                    aria-hidden
                    className="pointer-events-none absolute inset-0 flex min-w-0 items-center gap-1.5"
                    initial={{ y: 0 }}
                    animate={{ y: reducedMotion ? 0 : -20 }}
                    transition={{
                      duration: reducedMotion ? 0 : 0.15,
                      ease: [0.4, 0, 0.2, 1],
                    }}
                  >
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        leaving.label && "@max-2xl:hidden",
                      )}
                    >
                      {leaving.label}
                    </span>
                    {leaving.levelLabel && (
                      <span className="shrink-0 text-sm @max-2xl:hidden">
                        {leaving.levelLabel}
                      </span>
                    )}
                  </motion.span>
                )}
              </span>
              <ChevronDownIcon className="text-muted-foreground shrink-0 opacity-70" />
            </button>
          }
        />
        {/* 最外层描边：全局默认 ring-border/30 在浅色/Windows 缩放下只剩 2.85%
            透明度，几乎看不见；这里用满强度 border token，只影响弹层外缘 */}
        <DropdownMenuContent align="end" className="w-80 p-1.5 ring-border">
          {models.length === 0 ? (
            <>
              <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                没有可用模型，请先在设置 → 模型里添加服务
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openModelSettings}>
                管理模型
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {/* 发送锁提示：菜单可打开浏览，但本轮/排队消息完成前不能切换，
                  选项与滑杆一起禁用（不是触发器禁用） */}
              {modelLocked ? (
                <>
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    回复进行中，本轮与排队消息完成后可切换
                  </div>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              {/* 模型区标题：不再用逐行/逐段 border 分隔，模型列表与思考深度之间
                  只留一条分节线 */}
              <div className="text-foreground px-2 pt-1.5 pb-1 text-sm font-semibold">
                模型
              </div>
              {/* 服务头：独立菜单而不是 Menu 子项——子项会进外层菜单的方向键
                  序列，搜索框按 ↓ 先落到服务头；独立菜单的触发器不在序列里，
                  ↓ 直接到第一个模型。悬浮展开由 openOnHover 保留 */}
              <DropdownMenu
                open={providerSubOpen}
                onOpenChange={setProviderSubOpen}
              >
                <DropdownMenuTrigger
                  openOnHover
                  delay={100}
                  closeDelay={120}
                  render={
                    <button
                      type="button"
                      title={activeGroup?.title}
                      className="focus-visible:bg-foreground/[0.06] data-open:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06] flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-hidden select-none"
                    >
                      {activeGroup && (
                        <ProviderIcon
                          provider={activeGroup.providerId}
                          providerName={activeGroup.title}
                          className="size-4"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {activeGroup?.title ?? "选择服务"}
                      </span>
                      {activeGroup && (
                        <ModelCountBadge count={activeGroup.models.length} />
                      )}
                      <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
                    </button>
                  }
                />
                <DropdownMenuSubContent
                  sideOffset={12}
                  alignOffset={0}
                  className="w-64 ring-border"
                >
                  {/* 供应商可能很多：子菜单是独立浮层，不会继承主菜单的可用高度，
                      不单独限高会整列溢出窗口。「管理模型」留在滚动区外常驻。 */}
                  <div className="max-h-60 overflow-y-auto overscroll-contain">
                    {groups.map((g) => (
                      <DropdownMenuItem
                        key={g.key}
                        // 只切换主面板浏览的服务，不关闭主菜单
                        closeOnClick={false}
                        title={g.title}
                        onClick={() => {
                          setBrowseKey(g.key);
                          setProviderSubOpen(false);
                        }}
                        className="gap-2"
                      >
                        <ProviderIcon
                          provider={g.providerId}
                          providerName={g.title}
                          className="size-4"
                        />
                        <span className="min-w-0 flex-1 truncate">{g.title}</span>
                        <ModelCountBadge count={g.models.length} />
                        {g.key === activeGroup?.key && (
                          <CheckIcon className="size-4 shrink-0" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={openModelSettings}>
                    管理模型
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenu>

              {/* 搜索：只过滤当前浏览服务（服务头标出范围）。打开面板即聚焦，
                  输入即筛；↑/↓ 与回车由 DropdownMenuFilter 接管 */}
              <div className="px-1 pt-1.5 pb-1.5">
                <DropdownMenuSearchInput
                  placeholder="搜索当前服务的模型"
                  aria-label="搜索当前服务的模型"
                />
              </div>

              {/* 模型区：当前浏览服务的模型列表（名称 + 能力徽标 + 当前项勾选）。
                  过滤、高亮与回车选中都交给 Base UI 的可搜索菜单 */}
              <DropdownMenuList className="max-h-60 overflow-y-auto overscroll-contain">
                {filteredModels.map((m) => {
                  const isSelected =
                    selectedModel?.provider === m.provider && selectedModel.id === m.id;
                  return (
                    <DropdownMenuItem
                      key={`${m.provider}/${m.id}`}
                      // 搜索匹配文本：命中模型名/id 任一项即可
                      label={modelSearchLabel(m)}
                      disabled={modelLocked}
                      onClick={() => selectModel(m)}
                      className={cn("gap-2", isSelected && "bg-muted/50")}
                    >
                      {/* 模型 id 动辄几十个字符：悬浮左滚展示全文（会话标题
                          同款），原生 title 兜底；不再用 tooltip 遮相邻行 */}
                      <HoverScrollText
                        title={m.name || m.id}
                        className="min-w-0 flex-1"
                      >
                        {m.name || m.id}
                      </HoverScrollText>
                      {modelCapabilityBadges(m)}
                      {isSelected && <CheckIcon className="size-4 shrink-0" />}
                    </DropdownMenuItem>
                  );
                })}
                {noMatches ? (
                  <div
                    role="status"
                    className="text-muted-foreground px-2 py-3 text-center text-xs"
                  >
                    当前服务下没有匹配的模型
                  </div>
                ) : null}
              </DropdownMenuList>

              {/* 思考深度：档位跟随当前模型收窄。showEffort=false（调用方收窄）
                  不渲染，分隔线一并隐藏 */}
              {showEffort ? (
                <>
                  <DropdownMenuSeparator />
                  {/* 标题行在滑杆外（思考深度 + 精确档位），滑杆本体用 InlineSlider
                      的 bare 变体：只留轨道/刻度/拇指，不把文字嵌进轨道。
                      拖动中只更新草稿（handleEffortChange 节流 150ms 才下发） */}
                  <div className="px-2 pt-1.5 pb-1.5">
                    <div className="flex items-center justify-between pb-1">
                      <span className="text-foreground text-sm font-semibold">
                        思考深度
                      </span>
                      <span className="text-muted-foreground text-xs font-medium">
                        {THINKING_LEVEL_LABELS[shownLevel]}
                      </span>
                    </div>
                    {levels.length > 1 ? (
                      <>
                        <InlineSlider
                          bare
                          thumb="ring"
                          aria-label="思考深度"
                          className="h-8"
                          comet={cometLevel}
                          min={0}
                          max={levels.length - 1}
                          step={1}
                          value={shownIndex}
                          disabled={sliderDisabled}
                          formatValueText={(v) =>
                            THINKING_LEVEL_LABELS[levels[Math.round(v)] ?? "off"]
                          }
                          onValueChange={handleEffortChange}
                        />
                        {/* 三档粗粒度提示（参考 ZCode）：精确档位仍在标题右侧，
                            这里只负责让“简单/中度/深度”一眼可读 */}
                        <div className="flex items-center justify-between px-0.5 pt-0.5 text-[11px] leading-4">
                          {THINKING_DEPTH_LABELS.map((label, i) => (
                            <span
                              key={label}
                              className={cn(
                                "transition-colors",
                                depthZone === i
                                  ? "text-primary font-medium"
                                  : "text-muted-foreground",
                              )}
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </ModelMenuFilter>
  );
};

/** 服务列表里的模型数徽标（对应 ZCode 的 API 标签位；kova 没有接入类型之分，
 *  这里给的是真实信息：该服务下可用的模型数） */
const ModelCountBadge: FC<{ count: number }> = ({ count }) => (
  <span
    title={`${count} 个模型`}
    className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-px text-3xs leading-4 font-medium tabular-nums"
  >
    {count}
  </span>
);

/** 选择器分组：按服务名合并（同名服务视为同一组，与设置页口径一致） */
type ProviderGroup = {
  key: string;
  title: string;
  /** 组内任一 provider id（图标与兜底用） */
  providerId: string;
  models: PiModelSummary[];
};

/**
 * 有模型时才启用可搜索菜单：
 *
 * - 过滤由我们自己算：base-ui 的原生 filter 把服务头也当成匹配项，搜不到
 *   模型时连服务头一起隐藏，搜索中就没法切服务了。filter=null = 外部过滤，
 *   它只负责输入框与键盘，不隐藏任何已注册条目。
 * - 没有模型时不要套 Provider：filterable menu 的 popup 是 role=dialog，但
 *   空态里没有搜索框/列表，虚拟焦点没有宿主，纯键盘就走不到「管理模型」。
 *   空态保持普通菜单，roving focus 照旧。
 */
const ModelMenuFilter: FC<{
  enabled: boolean;
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}> = ({ enabled, value, onValueChange, children }) =>
  enabled ? (
    <DropdownMenuFilter
      value={value}
      onValueChange={onValueChange}
      filter={null}
    >
      {children}
    </DropdownMenuFilter>
  ) : (
    <>{children}</>
  );

/** 搜索匹配：空白分词，每个词都要在文本里出现——「deepseek r1」
 *  这类多词查询才分得清 */
const matchModelQuery = (text: string, query: string) => {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
};

/** 搜索框的匹配文本：模型名 + id。base-ui 在条目被过滤掉后靠这段 label
 *  继续匹配，不能只取渲染出来的名字 */
const modelSearchLabel = (m: PiModelSummary) => `${m.name} ${m.id}`;
