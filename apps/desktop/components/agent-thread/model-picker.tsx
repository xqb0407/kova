"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { motion, useReducedMotion } from "motion/react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineSlider } from "@/components/custom-ui/range-slider-inline";
import { Input } from "@/components/ui/input";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
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
import type { PiModelSummary } from "@/lib/pi/pi-bridge";

/**
 * 对话页模型选择器（两级，交互对齐 ZCode 的合并选择菜单）：
 *
 * - 主面板 =「当前服务头 + 模型列表 + 思考强度」。服务头是子菜单触发器，
 *   模型行带能力徽标（视觉等，见 modelCapabilityBadges），点击即定靶该模型。
 * - 子菜单 = 服务列表（图标 + 名称 + 模型数徽标 + 当前服务勾选）+「管理模型」
 *   入口（跳设置 → 模型）。点服务只切换主面板浏览的服务、不关闭主菜单。
 * - 思考强度并入面板底部（原先 composer 里独立的 ThinkingPicker 入口移除，
 *   与 ZCode 的合并菜单一致）：档位按当前模型的 supportedThinkingLevels
 *   收窄，不支持推理的模型只剩「关闭」，滑杆禁用。
 *
 * 选择仍经定靶 set_model 只落当前会话；思考档位同款走 pi-session-thinking。
 * 发送锁（useSendLock）：消息发送完成前禁止切换模型/档位，见 pi-send-lock。
 *
 * showEffort：问答档等「不涉及本次思考强度」的场景隐藏思考强度区
 * （原先由 composer 是否渲染 ThinkingPicker 决定，现由该属性承接）。
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
  /** 子菜单里点选后浏览的服务（null = 跟随当前选中模型的服务） */
  const [browseKey, setBrowseKey] = useState<string | null>(null);
  const [providerSubOpen, setProviderSubOpen] = useState(false);
  /** 模型搜索：非空时跨全部服务匹配（输入模型名不必先切服务） */
  const [query, setQuery] = useState("");
  /** 滑杆拖动中的草稿档位：拖动只更新草稿，停 150ms 才真正下发（见
   *  handleEffortChange），避免途经的每个档位都写一次 sidecar */
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  /** 触发器值滚动过渡：系统开了「减少动效」时直接切换，不播动画 */
  const reducedMotion = useReducedMotion();

  // 切线程时水合该会话记住的模型与档位（无记忆则回落设置页默认值）
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

  const trimmedQuery = query.trim().toLowerCase();
  /** 搜索优先跨全部服务；空查询回到当前浏览服务的模型列表 */
  const visibleModels = useMemo(() => {
    if (!trimmedQuery) return activeGroup?.models ?? [];
    return models.filter((m) => {
      const name = (m.name || m.id).toLowerCase();
      return name.includes(trimmedQuery) || m.id.toLowerCase().includes(trimmedQuery);
    });
  }, [trimmedQuery, activeGroup, models]);

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
    if (currentShown.key === shown.key) return;
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
  const sliderDisabled = modelLocked || levels.length < 2;

  const selectModel = (m: PiModelSummary) => {
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
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // 每次打开回到「当前选中模型的服务」，并刷新目录
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
            className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 max-w-60 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors [&>span]:min-w-0 [&>svg]:size-3.5 @max-2xl:px-2"
            disabled={modelLocked}
            title={modelLocked ? "消息发送完成前禁止切换模型" : selectedLabel}
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
      <DropdownMenuContent align="end" className="w-72 p-1.5">
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
            {/* 服务头：子菜单里切换浏览的服务（与 ZCode 的供应商行同款） */}
            <DropdownMenuSub
              open={providerSubOpen}
              onOpenChange={setProviderSubOpen}
            >
              <DropdownMenuSubTrigger className="gap-2">
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
                {activeGroup && <ModelCountBadge count={activeGroup.models.length} />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56 border-0">
                {groups.map((g) => (
                  <DropdownMenuItem
                    key={g.key}
                    // 只切换主面板浏览的服务，不关闭主菜单
                    closeOnClick={false}
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
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={openModelSettings}>
                  管理模型
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* 模型区：搜索 + 列表（名称 + 能力徽标 + 当前项勾选）。
                popup 层有键盘导航/typeahead，输入框按键必须 stopPropagation，
                否则打字被菜单吞掉、方向键会移走高亮；Esc 先清空搜索再关菜单 */}
            <div className="relative px-1.5 pt-1 pb-1">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute start-3.5 top-1/2 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (query) {
                      e.preventDefault();
                      e.stopPropagation();
                      setQuery("");
                    }
                    return;
                  }
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = visibleModels[0];
                    if (first) {
                      selectModel(first);
                      setOpen(false);
                    }
                  }
                }}
                placeholder="搜索模型…"
                aria-label="搜索模型"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="h-8 ps-8 text-xs md:text-xs"
              />
            </div>
            <div className="max-h-60 overflow-y-auto">
              {visibleModels.map((m) => {
                const isSelected =
                  selectedModel?.provider === m.provider && selectedModel.id === m.id;
                return (
                  <DropdownMenuItem
                    key={`${m.provider}/${m.id}`}
                    title={m.id}
                    onClick={() => selectModel(m)}
                    className={cn("gap-2", isSelected && "bg-muted/50")}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {m.name || m.id}
                    </span>
                    {/* 跨服务搜索时补服务名：不然同名模型分不清来源 */}
                    {trimmedQuery ? (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {m.providerName}
                      </span>
                    ) : null}
                    {modelCapabilityBadges(m)}
                    {isSelected && <CheckIcon className="size-4 shrink-0" />}
                  </DropdownMenuItem>
                );
              })}
              {visibleModels.length === 0 && (
                <div className="text-muted-foreground px-2 py-3 text-center text-xs">
                  没有匹配的模型
                </div>
              )}
            </div>

            {/* 思考强度：档位跟随当前模型收窄。问答档（showEffort=false）不渲染
                ——那里没有"这次思考强度"的决策，分隔线一并隐藏 */}
            {showEffort ? (
              <>
                <DropdownMenuSeparator />
                {/* 标题行在滑杆外（思考强度 + 当前档位），滑杆本体用 InlineSlider
                    的 bare 变体：只留轨道/刻度/拇指，不把文字嵌进轨道。
                    拖动中只更新草稿（handleEffortChange 节流 150ms 才下发） */}
                <div className="px-2 pt-1.5 pb-1.5">
                  <div className="flex items-center justify-between pb-1">
                    <span className="text-muted-foreground text-xs font-medium">
                      思考强度
                    </span>
                    <span
                      className={cn(
                        "text-xs font-medium",
                        shownLevel === "off" && "text-muted-foreground",
                      )}
                    >
                      {THINKING_LEVEL_LABELS[shownLevel]}
                    </span>
                  </div>
                  {levels.length > 1 ? (
                    <InlineSlider
                      bare
                      aria-label="思考强度"
                      className="h-8"
                      comet={shownIndex >= levels.length - 1}
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
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** 服务列表里的模型数徽标（对应 ZCode 的 API 标签位；kova 没有接入类型之分，
 *  这里给的是真实信息：该服务下可用的模型数） */
const ModelCountBadge: FC<{ count: number }> = ({ count }) => (
  <span
    title={`${count} 个模型`}
    className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4 font-medium tabular-nums"
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
