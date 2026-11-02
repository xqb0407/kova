"use client";

/**
 * 【校对页】对话页模型选择器（两级菜单）：/dev-preview/model-picker
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/model-picker
 *
 * 真实选择器的数据来自 sidecar（usePiModels/useThreadModel），浏览器里拿不到，
 * 这里用夹具复刻弹层结构：服务头（子菜单）+ 模型列表（视觉徽标）+ 思考强度滑杆。
 * 用来校对：面板高度与滚动条（内容不足时不应出现滚动条）、模型行密度、
 * 徽标与勾选、滑杆交互。
 */

import { useEffect, useRef, useState } from "react";
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
import {
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  type ThinkingLevel,
} from "@/lib/settings/thinking-settings";

type Fixture = {
  provider: string;
  providerName: string;
  models: { id: string; name: string; vision: boolean }[];
};

const SHORT: Fixture[] = [
  {
    provider: "custom-qoder",
    providerName: "Qoder",
    models: [
      { id: "DeepSeek-Flash", name: "DeepSeek-Flash", vision: true },
      { id: "Qwen3.8-Flash", name: "Qwen3.8-Flash", vision: true },
    ],
  },
];

const LONG: Fixture[] = [
  {
    provider: "custom-agnes",
    providerName: "Agnes",
    models: [
      { id: "agnes-2.5-flash", name: "agnes-2.5-flash", vision: true },
      { id: "agnes-3.0-flash", name: "agnes-3.0-flash", vision: true },
      { id: "agnes-image-2.1-flash", name: "agnes-image-2.1-flash", vision: false },
      { id: "agnes-image-2.5-flash", name: "agnes-image-2.5-flash", vision: false },
    ],
  },
  ...SHORT,
];

const VisionBadge = () => (
  <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs font-normal">
    视觉
  </span>
);

export default function ModelPickerPreview() {
  const [groups, setGroups] = useState(SHORT);
  const [selected, setSelected] = useState({ provider: "custom-qoder", id: "DeepSeek-Flash" });
  const [level, setLevel] = useState<ThinkingLevel>("max");
  const [browseKey, setBrowseKey] = useState<string | null>(null);
  const [providerSubOpen, setProviderSubOpen] = useState(false);
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const reducedMotion = useReducedMotion();

  const all = groups.flatMap((g) =>
    g.models.map((m) => ({ ...m, provider: g.provider, providerName: g.providerName })),
  );
  const selectedModel = all.find(
    (m) => m.provider === selected.provider && m.id === selected.id,
  );
  const activeGroup =
    (browseKey ? groups.find((g) => g.providerName === browseKey) : undefined) ??
    groups.find((g) => g.provider === selected.provider) ??
    groups[0];
  const trimmedQuery = query.trim().toLowerCase();
  const visibleModels = trimmedQuery
    ? all.filter(
        (m) =>
          m.name.toLowerCase().includes(trimmedQuery) ||
          m.id.toLowerCase().includes(trimmedQuery),
      )
    : (activeGroup?.models.map((m) => ({ ...m, provider: activeGroup.provider, providerName: activeGroup.providerName })) ?? []);

  const levels = THINKING_LEVELS;
  const levelIndex = Math.max(0, levels.indexOf(level));
  const shownIndex = draftIndex ?? levelIndex;

  // 与正式选择器同款：菜单打开期间冻结触发器显示值，关闭时才切换并播放滚动
  const currentShown = {
    key: `${selected.provider}/${selected.id}:${level}`,
    provider: selectedModel?.provider,
    modelId: selectedModel?.id,
    providerName: selectedModel?.providerName,
    label: selectedModel?.name ?? null,
    levelLabel: THINKING_LEVEL_LABELS[level],
  };
  const [shown, setShown] = useState(currentShown);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 快照切换只挂 key 变化
  }, [open, currentShown.key, shown.key]);
  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex gap-2">
        <button
          type="button"
          className="bg-muted rounded-md px-3 py-1.5 text-sm"
          onClick={() => setGroups(SHORT)}
        >
          短列表（2 模型）
        </button>
        <button
          type="button"
          className="bg-muted rounded-md px-3 py-1.5 text-sm"
          onClick={() => setGroups(LONG)}
        >
          长列表（4 模型 + 双服务）
        </button>
      </div>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              data-testid="preview-trigger"
              className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 max-w-60 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors [&>span]:min-w-0 [&>svg]:size-3.5"
            >
              <ProviderIcon
                provider={shown.provider ?? ""}
                modelId={shown.modelId}
                providerName={shown.providerName}
              />
              <span className="relative flex h-5 min-w-0 items-center overflow-hidden">
                <motion.span
                  key={shown.key}
                  className="flex min-w-0 items-center gap-1.5"
                  initial={{ y: reducedMotion ? 0 : 20 }}
                  animate={{ y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.15, ease: [0.4, 0, 0.2, 1] }}
                >
                  <span className="min-w-0 truncate">
                    {shown.label ?? "请选择模型"}
                  </span>
                  <span className="text-muted-foreground/80 shrink-0 text-sm">
                    {shown.levelLabel}
                  </span>
                </motion.span>
                {leaving && leaving.key !== shown.key && (
                  <motion.span
                    key={`leave-${leaving.key}`}
                    aria-hidden
                    className="pointer-events-none absolute inset-0 flex min-w-0 items-center gap-1.5"
                    initial={{ y: 0 }}
                    animate={{ y: reducedMotion ? 0 : -20 }}
                    transition={{ duration: reducedMotion ? 0 : 0.15, ease: [0.4, 0, 0.2, 1] }}
                  >
                    <span className="min-w-0 truncate">{leaving.label}</span>
                    <span className="shrink-0 text-sm">{leaving.levelLabel}</span>
                  </motion.span>
                )}
              </span>
              <ChevronDownIcon className="text-muted-foreground shrink-0 opacity-70" />
            </button>
          }
        />
        <DropdownMenuContent align="end" className="w-72 p-1.5 ring-border">
          <DropdownMenuSub open={providerSubOpen} onOpenChange={setProviderSubOpen}>
            <DropdownMenuSubTrigger className="gap-2">
              <ProviderIcon
                provider={activeGroup?.provider}
                providerName={activeGroup?.providerName}
                className="size-4"
              />
              <span className="min-w-0 flex-1 truncate">{activeGroup?.providerName}</span>
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4 font-medium tabular-nums">
                {activeGroup?.models.length}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 ring-border">
              {groups.map((g) => (
                <DropdownMenuItem
                  key={g.provider}
                  closeOnClick={false}
                  onClick={() => {
                    setBrowseKey(g.providerName);
                    setProviderSubOpen(false);
                  }}
                  className="gap-2"
                >
                  <ProviderIcon
                    provider={g.provider}
                    providerName={g.providerName}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1 truncate">{g.providerName}</span>
                  <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4 font-medium tabular-nums">
                    {g.models.length}
                  </span>
                  {g.providerName === activeGroup?.providerName && (
                    <CheckIcon className="size-4 shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem>管理模型</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

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
                    setSelected({ provider: first.provider, id: first.id });
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
          <div className="max-h-60 overflow-y-auto" data-testid="preview-model-list">
            {visibleModels.map((m) => {
              const isSelected = selected.provider === m.provider && selected.id === m.id;
              return (
                <DropdownMenuItem
                  key={`${m.provider}/${m.id}`}
                  title={m.id}
                  onClick={() => setSelected({ provider: m.provider, id: m.id })}
                  className={cn("gap-2", isSelected && "bg-muted/50")}
                >
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  {trimmedQuery ? (
                    <span className="text-muted-foreground shrink-0 text-xs">{m.providerName}</span>
                  ) : null}
                  {m.vision && <VisionBadge />}
                  {isSelected && <CheckIcon className="size-4 shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            {visibleModels.length === 0 && (
              <div className="text-muted-foreground px-2 py-3 text-center text-xs">没有匹配的模型</div>
            )}
          </div>

          <DropdownMenuSeparator />

          <div className="px-2 pt-1.5 pb-1.5">
            <div className="flex items-center justify-between pb-1">
              <span className="text-muted-foreground text-xs font-medium">思考强度</span>
              <span className="text-xs font-medium">
                {THINKING_LEVEL_LABELS[levels[shownIndex] ?? "off"]}
              </span>
            </div>
            <InlineSlider
              bare
              aria-label="思考强度"
              className="h-8"
              comet={shownIndex >= levels.length - 1}
              min={0}
              max={levels.length - 1}
              step={1}
              value={shownIndex}
              formatValueText={(v) => THINKING_LEVEL_LABELS[levels[Math.round(v)] ?? "off"]}
              onValueChange={(v) => {
                const idx = Math.round(v);
                setDraftIndex(idx);
                const lv = levels[idx];
                if (lv) setLevel(lv);
              }}
            />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
