"use client";

import { useMemo, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  getTurnParts,
  packTurnSlot,
  parseTurnSlot,
} from "@/lib/panels/message-turns";
import {
  usePanelActivity,
  type CitationEntry,
} from "@/lib/panels/panel-activity";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { SiteIcon } from "@/components/custom-ui/site-icon";
import { cn } from "@/lib/utils";

/**
 * 轮末回答底部的「来源条」：本轮 WebSearch/WebFetch 产出的引用以 favicon
 * 头像堆叠呈现（超出 MAX 显示 +N），类 Perplexity 的 sources 行。
 * 数据零新增派生：引用来自 usePanelActivity 的 citationsAll（增量 store，
 * 流式期间条目身份稳定）——**去重前的全量列表**。面板列表的全局 url 去重
 * 会把重复 url 记在首现 toolCallId 名下，按轮过滤会让后轮重抓早先轮已列过
 * url 的来源条空手而归；这里消费全量列表、按本轮 toolCallId 归因，同轮内
 * 再按 url 去重（首条保留），序与发生顺序一致。
 *
 * 交互：单个 favicon → 应用内「浏览器」标签打开该页（复用既有标签并导航，
 * 同工具行 WebFetch 的面板目标语义）；「来源」标签 / +N → 活动页「引用资料」
 * 区（focus="citations"，活动视图滚动定位）。
 *
 * 挂载门控同 MessageArtifacts：轮末或 answer-tail 消息（dividerOnly 除外）
 * 且轮已收尾——流式过程中不显示（避免来源条跟着正文增长上下跳动、以及
 * 收录尚未被最终回答引用的中间搜索），轮结束落在最终回答底部一次性出现；
 * process 面不渲染（由 assistant-message 的挂载侧保证），折叠轮中不会出现两份。
 */

/** 直接展示的 favicon 上限，超出折叠成 +N（Perplexity 同款量级） */
const MAX_FAVICONS = 5;

/** 稳定空态：无引用时 memo 返回它，避免新数组身份触发重渲 */
const EMPTY_ENTRIES: readonly CitationEntry[] = [];

function openReferencesPanel(): void {
  // focus 带 @nonce：activity 标签已停在引用资料区时重复点击也要重滚
  // （值变化才会让 ReferencesSection 的 reveal 效应重跑），见 activity-view 解析
  focusPanelTab("activity", { focus: `citations@${Date.now()}` });
  window.dispatchEvent(new Event("agent-panel:open"));
}

/** 单个来源 → 应用内浏览器标签（同 tool-panel 的 WebFetch 面板目标） */
function openSourceInBrowserTab(url: string): void {
  let title = url;
  try {
    title = new URL(url).hostname;
  } catch {
    // 非法 URL：标题用原文，浏览器标签自己会 normalizeUrl
  }
  focusPanelTab("browser", { url, title });
  window.dispatchEvent(new Event("agent-panel:open"));
}

const entryKey = (e: CitationEntry) => e.url ?? `${e.toolCallId}\u0000${e.title}`;

/** 单个来源头像：圆形底 + favicon，堆叠负边距；有 url 才可点（无 url 的纯文字条目只展示） */
const SourceChip: FC<{ entry: CitationEntry; index: number; stacked: boolean }> = ({
  entry,
  index,
  stacked,
}) => {
  const avatar = <SiteIcon url={entry.url ?? ""} className="size-3.5" />;
  const title = `${index + 1}. ${entry.title}${entry.url ? `\n${entry.url}` : ""}`;
  const cls = cn(
    "grid size-5 shrink-0 place-items-center rounded-full bg-background ring-1 ring-border/70 transition-shadow",
    stacked && "-ml-1.5",
    entry.url && "hover:ring-primary/60 cursor-pointer",
  );
  if (!entry.url) return <span title={title} className={cls}>{avatar}</span>;
  return (
    <button
      type="button"
      title={title}
      onClick={() => openSourceInBrowserTab(entry.url!)}
      className={cls}
    >
      {avatar}
    </button>
  );
};

export const MessageSources: FC = () => {
  // 门控（返回稳定字符串，Object.is 挡住流式重渲；packTurnSlot 走缓存索引 O(1)）
  const gate = useAuiState((s) => {
    if (s.message.role !== "assistant") return "";
    const packed = packTurnSlot(s.thread.messages, String(s.message.id));
    const slot = parseTurnSlot(packed);
    if (
      !slot ||
      slot.dividerOnly ||
      (!slot.isTurnEnd && !slot.isAnswerTail) ||
      slot.turnRunning
    )
      return "";
    return packed;
  });
  const slot = useMemo(() => (gate ? parseTurnSlot(gate) : null), [gate]);
  // 本轮全部 parts（按 messages 数组身份缓存的 frozen 数组，引用稳定）
  const parts = useAuiState((s) =>
    slot ? getTurnParts(s.thread.messages, slot.turnKey) : null,
  );
  const { citationsAll } = usePanelActivity();
  // 本轮引用 = 全量列表（未跨轮去重）按本轮 WebSearch/WebFetch 的 toolCallId
  // 过滤，同轮内按 url 去重（首条保留：一次搜索多条命中 + 重抓同一页不重复陈列）
  const entries = useMemo(() => {
    if (!slot || !parts) return EMPTY_ENTRIES;
    const ids = new Set<string>();
    for (const p of parts) {
      if (
        p.type === "tool-call" &&
        (p.toolName === "WebSearch" || p.toolName === "WebFetch")
      )
        ids.add(p.toolCallId);
    }
    if (ids.size === 0) return EMPTY_ENTRIES;
    const seen = new Set<string>();
    const out: CitationEntry[] = [];
    for (const c of citationsAll) {
      if (!ids.has(c.toolCallId)) continue;
      const k = entryKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out.length > 0 ? out : EMPTY_ENTRIES;
  }, [slot, parts, citationsAll]);

  if (entries.length === 0) return null;

  const shown = entries.slice(0, MAX_FAVICONS);
  const overflow = entries.length - shown.length;
  // 悬浮列出全部来源（编号+标题），+N 与「来源」标签共用
  const listTitle = entries.map((e, i) => `${i + 1}. ${e.title}`).join("\n");

  return (
    <div
      data-slot="aui_message-sources"
      className="flex min-w-0 items-center gap-1.5"
    >
      <button
        type="button"
        title={listTitle}
        onClick={openReferencesPanel}
        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer py-0.5 text-sm transition-colors"
      >
        来源
      </button>
      <div className="flex min-w-0 items-center py-0.5">
        {shown.map((e, i) => (
          <SourceChip key={entryKey(e)} entry={e} index={i} stacked={i > 0} />
        ))}
        {overflow > 0 && (
          <button
            type="button"
            title={listTitle}
            onClick={openReferencesPanel}
            className="text-muted-foreground hover:text-foreground hover:border-primary/50 -ml-1.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border border-border/70 bg-background text-3xs font-medium leading-none tabular-nums transition-colors"
          >
            +{overflow}
          </button>
        )}
      </div>
    </div>
  );
};
