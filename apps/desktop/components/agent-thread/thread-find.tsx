"use client";

/**
 * 会话内搜索（Ctrl/Cmd+F）：搜当前会话的可见正文，结果按消息列成目录，
 * 点击/回车跳转并把命中词在正文里真正高亮出来。
 *
 * 两个口径上的取舍：
 *  - 搜索数据取 thread.messages 的 text parts，不取 DOM：收起的过程中文不挂载，
 *    取 DOM 会漏；轮次归属也直接用 getTurnIndex，与折叠/摘要行同一套索引。
 *  - 高亮走 CSS Custom Highlight API（Chromium 支持），按跳转目标的 DOM 现算
 *    Range——不侵入 markdown 渲染树，流式重渲染也不会把高亮节点拆掉。
 */

import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import {
  collectProcessTexts,
  getTurnIndex,
  packTurnSlot,
  parseTurnSlot,
  type TurnSlotInfo,
} from "@/lib/panels/message-turns";
import { useAuiState } from "@assistant-ui/react";
import type { ThreadMessage } from "@assistant-ui/react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { yieldViewportScroll } from "./viewport-scroll-manager";

const VIEWPORT_SELECTOR = '[data-slot="aui_thread-viewport"]';
const HIGHLIGHT_NAME = "thread-find";
/** 片段里命中词前后各留的字符数 */
const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 72;
/** 单次高亮的 Range 上限：长会话里点一个高频词不该把整屏都染色 */
const MAX_RANGES = 400;

type FindHit = {
  messageId: string;
  /** 1-based 轮次，与左侧刻度条的「第 N 轮」对齐 */
  turn: number;
  role: "user" | "assistant";
  /** 该消息内的命中次数 */
  count: number;
  /** 命中附近的原文（未折叠空白，交给 HTML 自然处理） */
  snippet: string;
};

/** 一条消息里「用户看得到」的正文。已结束的轮会把更早步骤的叙述收进过程面，
 *  收起状态下那部分不挂载——搜进来只会得到点不中的结果，按同一口径剔掉
 *  （collectProcessTexts 就是折叠用的那把尺子）。 */
function visibleText(
  message: ThreadMessage,
  scope: "all" | "answer",
): string {
  // content 只取一次：collectProcessTexts 按 part 身份判定，两次读属性若拿到
  // 不同的数组/对象（store 的惰性重建）就会一个都剔不掉
  const content = message.content;
  if (message.role === "user") {
    return content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
  }
  if (message.role !== "assistant") return "";
  const processTexts = scope === "answer" ? collectProcessTexts(content) : null;
  return content
    .flatMap((part) =>
      part.type === "text" && (!processTexts || !processTexts.has(part))
        ? [part.text]
        : [],
    )
    .join("\n");
}

/**
 * 消息当前是否挂载在 DOM 里，口径与 TurnSlot 的拆分完全一致：
 *  - 流式中的轮末整条渲染（正文与工具交错不重排）→ all
 *  - 已结束的轮末/答案尾拆成过程面 + 答案面 → 只搜答案面（answer）
 *  - 轮中过程块与纯分隔线消息包在默认收起的过程区里，压根没挂载 → none
 * 跳转要落到真实存在的元素上，收起的面不搜，才能保证每条结果都点得中。
 * 索引缺失（buildTurnIndex fail-open）时按 all 处理，宁可多搜不漏搜。
 */
function searchScope(
  slot: TurnSlotInfo | null,
  threadRunning: boolean,
): "all" | "answer" | "none" {
  if (!slot) return "all";
  // 顺序必须与 TurnSlot 的判定顺序一致：拆分分支先于整条渲染分支，
  // 否则普通的「已结束轮末」会被误判成整条渲染（它的 isTurnEnd 恒真）
  if (
    (slot.isTurnEnd || slot.isAnswerTail) &&
    !slot.dividerOnly &&
    !slot.turnRunning
  ) {
    return "answer";
  }
  const streamingTurnEnd =
    slot.isTurnEnd &&
    (!slot.dividerOnly || slot.turnRunning || (slot.isLastTurn && threadRunning));
  if (streamingTurnEnd) return "all";
  if (slot.turnRunning || (slot.isLastTurn && threadRunning)) return "all";
  return "none";
}

function buildHits(
  messages: readonly ThreadMessage[],
  rawQuery: string,
  threadRunning: boolean,
): FindHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const index = getTurnIndex(messages);
  const hits: FindHit[] = [];
  for (const message of messages) {
    const id = String(message.id);
    const slot = parseTurnSlot(packTurnSlot(messages, id));
    const scope = message.role === "user" ? "all" : searchScope(slot, threadRunning);
    if (scope === "none") continue;
    const text = visibleText(message, scope);
    if (!text) continue;
    const lower = text.toLowerCase();
    let count = 0;
    let first = -1;
    for (
      let at = lower.indexOf(query);
      at >= 0;
      at = lower.indexOf(query, at + query.length)
    ) {
      if (first < 0) first = at;
      count += 1;
    }
    if (count === 0) continue;
    const from = Math.max(0, first - SNIPPET_BEFORE);
    hits.push({
      messageId: id,
      turn: (index.slots.get(id)?.turnIndex ?? 0) + 1,
      role: message.role === "user" ? "user" : "assistant",
      count,
      snippet:
        (from > 0 ? "…" : "") +
        plainSnippet(text.slice(from, first + query.length + SNIPPET_AFTER)),
    });
  }
  return hits;
}

/** 结果目录里的片段去掉 markdown 记号：标题井号、强调/行内代码符号、引用箭头。
 *  不改空白（换行由 HTML 折叠），这样命中词仍能在片段里按原文定位。 */
function plainSnippet(text: string): string {
  return text
    .replace(/^#{1,6}[ \t]+/gm, "")
    .replace(/^>[ \t]?/gm, "")
    .replace(/\*\*|__|`{1,3}/g, "")
    .trim();
}

/** 命中词在片段里加底色；找不到就整体当普通文本（查询跨了换行等边角） */
const Snippet: FC<{ text: string; query: string }> = ({ text, query }) => {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="bg-primary/20 text-foreground">
        {text.slice(at, at + q.length)}
      </span>
      {text.slice(at + q.length)}
    </>
  );
};

type HighlightRegistryLike = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};
type HighlightCtor = new (...ranges: Range[]) => unknown;

const getRegistry = (): HighlightRegistryLike | undefined =>
  (globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined)
    ?.highlights;

const getHighlightCtor = (): HighlightCtor | undefined =>
  (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;

function clearHighlight() {
  getRegistry()?.delete(HIGHLIGHT_NAME);
}

/** 按 DOM 现算命中 Range。文字跨节点（markdown 把一句话拆进多个 inline 元素）
 *  时，起止各定位到所在文本节点，一个 Range 可以横跨多个节点。 */
function highlightMatches(root: HTMLElement, rawQuery: string) {
  const registry = getRegistry();
  const Highlight = getHighlightCtor();
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    clearHighlight();
    return;
  }
  if (!registry || !Highlight) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest("script,style")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = (node as Text).data;
    starts.push(text.length);
    nodes.push(node as Text);
    text += value;
  }
  const lower = text.toLowerCase();
  const locate = (offset: number) => {
    for (let i = 0; i < nodes.length; i++) {
      const length = nodes[i].data.length;
      if (offset <= starts[i] + length) {
        return { node: nodes[i], offset: offset - starts[i] };
      }
    }
    return null;
  };

  const ranges: Range[] = [];
  for (
    let at = lower.indexOf(query);
    at >= 0 && ranges.length < MAX_RANGES;
    at = lower.indexOf(query, at + query.length)
  ) {
    const start = locate(at);
    const end = locate(at + query.length);
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  if (ranges.length === 0) {
    clearHighlight();
    return;
  }
  registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

/**
 * 供全局搜索定位用：把消息滚动进视口并高亮 query（复用本文件的
 * TreeWalker + Custom Highlight 管线，注册名与 Ctrl+F 共享——后到者覆盖）。
 * seq 转消息 id 走投影的稳定锚点 `pi-msg:<seq>`（messageProjection.ts）；
 * 消息不在已加载窗（分页裁掉）时静默返回 false，调用方可回落仅滚动。
 */
export function highlightMessageBySeq(seq: number, query: string): boolean {
  const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
  if (!viewport) return false;
  const target = viewport.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(`pi-msg:${seq}`)}"]`,
  );
  if (!target) return false;
  yieldViewportScroll();
  const viewportRect = viewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  viewport.scrollTo({
    top: Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top - 16),
    behavior: "smooth",
  });
  highlightMatches(target, query);
  return true;
}

export { clearHighlight as clearThreadFindHighlight };

export const ThreadFind: FC = () => {
  const messages = useAuiState((state) => state.thread.messages);
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** 结果目录里当前选中的那条（-1 = 无） */
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // 流式期间 messages 每帧都变：查询滞后一拍再搜，避免每落一个 token 全量扫一遍
  const deferredQuery = useDeferredValue(query);
  const hits = useMemo(
    () => (open ? buildHits(messages, deferredQuery, threadRunning) : []),
    [open, messages, deferredQuery, threadRunning],
  );
  // 流式期间命中集合会缩：把选中项夹回当前范围内，避免出现「3 / 2」
  const activeIndex = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
    clearHighlight();
  }, []);

  const jumpTo = useCallback(
    (hit: FindHit, index: number) => {
      const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
      if (!viewport) return;
      const target = viewport.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(hit.messageId)}"]`,
      );
      if (!target) return;
      // 跳转是用户意图：ViewportScrollManager 收不到手势，显式让它放开跟随
      yieldViewportScroll();
      setActive(index);
      const viewportRect = viewport.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      viewport.scrollTo({
        top: Math.max(
          0,
          viewport.scrollTop + targetRect.top - viewportRect.top - 16,
        ),
        behavior: "smooth",
      });
      highlightMatches(target, deferredQuery);
    },
    [deferredQuery],
  );

  const step = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      const next = (Math.max(activeIndex, 0) + delta + hits.length) % hits.length;
      jumpTo(hits[next]!, next);
    },
    [activeIndex, hits, jumpTo],
  );

  // Ctrl/Cmd+F 打开；已开时再按只聚焦并全选（与浏览器行为一致）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "f") return;
      if (event.defaultPrevented) return;
      // 对话框/浮层开着时不抢：搜索面板是会话内的，压在其他浮层下面没有意义
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Esc 关闭（焦点在输入框外时也要能关；对话框自己处理过的 Esc 不抢）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // 查询变化：落到第一条命中。流式导致 hits 变化时不重复跳（依赖只放查询）
  useEffect(() => {
    if (!open) return;
    if (hits.length === 0) {
      setActive(-1);
      clearHighlight();
      return;
    }
    setActive(0);
    jumpTo(hits[0]!, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery, open]);

  if (!open) return null;

  return (
    // 贴右上角（不居中）：搜索面板是临时工具，别压着正文的中轴
    <div className="pointer-events-none absolute inset-x-4 top-3 z-30 flex justify-end">
      <div
        data-slot="aui_thread-find"
        role="search"
        className="animate-in fade-in slide-in-from-top-2 pointer-events-auto w-full max-w-120 overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-lg backdrop-blur-xl duration-150"
      >
        <div className="flex items-center gap-1 p-1.5">
          <InputGroup className="min-w-0 flex-1 border-0 shadow-none">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // 长查询不撑破面板：失焦时按省略号截断，聚焦时由输入框自己横向滚动
              className="truncate"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  step(1);
                }
              }}
              placeholder="搜索当前会话的消息"
              aria-label="搜索当前会话的消息"
            />
            <InputGroupAddon align="inline-end">
              <span className="text-muted-foreground text-xs tabular-nums">
                {query.trim().length === 0
                  ? ""
                  : hits.length === 0
                    ? "无结果"
                    : `${activeIndex + 1} / ${hits.length}`}
              </span>
            </InputGroupAddon>
          </InputGroup>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上一个命中"
            disabled={hits.length === 0}
            onClick={() => step(-1)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="下一个命中"
            disabled={hits.length === 0}
            onClick={() => step(1)}
          >
            <ChevronDownIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭搜索"
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>

        {hits.length > 0 ? (
          <div className="max-h-72 overflow-x-hidden overflow-y-auto overscroll-contain border-t border-border/60 p-1">
            {hits.map((hit, index) => (
              <Button
                key={hit.messageId}
                variant="ghost"
                onClick={() => {
                  jumpTo(hit, index);
                  // 焦点留在搜索框：点完一条还能直接 Enter/↑↓ 继续翻
                  inputRef.current?.focus();
                }}
                className={cn(
                  // whitespace-normal：Button 基类是 whitespace-nowrap，结果行要折行
                  "flex h-auto w-full flex-col items-start gap-1 rounded-lg px-2.5 py-2 text-left whitespace-normal",
                  index === activeIndex && "bg-accent",
                )}
              >
                <span className="text-muted-foreground text-[11px] leading-none">
                  第 {hit.turn} 轮 · {hit.role === "user" ? "你" : "AI"}
                  {hit.count > 1 ? ` · ${hit.count} 处` : ""}
                </span>
                {/* wrap-anywhere 而非 break-words：后者不降低固有宽度，长 token
                    （路径、包名）会把整行顶出面板，flex 子项也压不回来 */}
                <span className="line-clamp-2 w-full min-w-0 text-xs leading-snug text-foreground/80 wrap-anywhere">
                  <Snippet text={hit.snippet} query={deferredQuery} />
                </span>
              </Button>
            ))}
          </div>
        ) : null}

        <div className="text-muted-foreground flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-[11px]">
          <Kbd>Enter</Kbd> 下一个
          <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 上一个
          <Kbd>Esc</Kbd> 关闭
        </div>
      </div>
    </div>
  );
};
