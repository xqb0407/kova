"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { useAui } from "@assistant-ui/react";
import {
  ChevronRightIcon,
  BugIcon,
  CircleXIcon,
  EraserIcon,
  InfoIcon,
  ListFilterIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const desktopCore = () => import("@/desktop-bridge/core");

export type ConsoleLevel = "error" | "warning" | "info" | "debug";

export type ConsoleEntry = {
  id: number;
  level: ConsoleLevel;
  message: string;
  source: string;
  line: number;
  ts: number;
};

type LevelFilter = "all" | "error" | "warning";

const LEVEL_META: Record<
  ConsoleLevel,
  { icon: typeof CircleXIcon; className: string; label: string }
> = {
  error: { icon: CircleXIcon, className: "text-red-500", label: "错误" },
  warning: {
    icon: TriangleAlertIcon,
    className: "text-amber-500",
    label: "警告",
  },
  info: { icon: InfoIcon, className: "text-muted-foreground", label: "信息" },
  debug: { icon: BugIcon, className: "text-muted-foreground/70", label: "调试" },
};

const FILTER_LABEL: Record<LevelFilter, string> = {
  all: "全部",
  error: "仅错误",
  warning: "仅警告",
};

/**
 * 浏览器面板底部控制台（仿 Trae）：列出 guest 页面的 console 消息
 * （主进程 browser.ts 采集，环形缓冲 300 条、主框架导航即清空），
 * 支持按级别过滤、清空、以及把日志内容加进对话输入框。
 *
 * 默认收起；出现第一条错误时自动展开（用户手动收起过就不再自动弹，
 * 尊重显式操作）。"添加到对话" 走 assistant-ui 的 composer.setText——
 * 只回填不发送（与欢迎建议/排队条回填同款语义），用户可编辑后再发。
 */
export const BrowserConsolePanel: FC<{ pageUrl: string }> = ({ pageUrl }) => {
  const aui = useAui();
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  /** 用户显式开合过之后不再自动展开（null=没动过，走自动策略） */
  const userToggledRef = useRef(false);
  const [filter, setFilter] = useState<LevelFilter>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  /** 日志区高度（拖面板上缘改，DevTools 控制台同款）；收起时无关 */
  const [bodyHeight, setBodyHeight] = useState(192);

  /** 拖上缘调高度：向上拖变高；限幅 64~560，拖动期间锁 body 光标 */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = bodyHeight;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "ns-resize";
    const onMove = (ev: PointerEvent) => {
      setBodyHeight(
        Math.max(64, Math.min(560, Math.round(startH - (ev.clientY - startY)))),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // 首帧全量对齐 + 订阅增量（主进程 150ms 批量推送）
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    desktopCore()
      .then(({ invoke }) =>
        invoke<{ entries: ConsoleEntry[] }>("browser_console_get"),
      )
      .then((r) => {
        if (alive && Array.isArray(r?.entries)) setEntries(r.entries);
      })
      .catch(() => {});
    import("@/desktop-bridge/event")
      .then(({ listen }) =>
        listen<{ entries: ConsoleEntry[] }>("browser:console", (e) => {
          const batch = e.payload?.entries ?? [];
          if (batch.length === 0) return;
          setEntries((prev) => {
            const next = [...prev, ...batch];
            return next.length > 300 ? next.slice(next.length - 300) : next;
          });
          if (
            !userToggledRef.current &&
            batch.some((it) => it.level === "error")
          ) {
            setCollapsed(false);
          }
        }),
      )
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const errorCount = useMemo(
    () => entries.filter((e) => e.level === "error").length,
    [entries],
  );
  const warningCount = useMemo(
    () => entries.filter((e) => e.level === "warning").length,
    [entries],
  );
  const visible = useMemo(
    () =>
      filter === "all" ? entries : entries.filter((e) => e.level === filter),
    [entries, filter],
  );

  const toggle = () => {
    userToggledRef.current = true;
    setCollapsed((v) => !v);
  };

  const clear = () => {
    setEntries([]);
    setExpandedId(null);
    desktopCore()
      .then(({ invoke }) => invoke("browser_console_clear"))
      .catch(() => {});
  };

  /** 把当前可见日志灌进对话输入框（只回填不发送） */
  /** 往输入框插**控制台芯片**（`:console[<标签>]{name=<日志摘要>}`，与元素芯片同
   *  一套 directive 机制）：人类看到「3 error(s)」芯片（可悬浮删除），模型从
   *  name 槽直接读到页面 URL 与逐条日志（无换行/无花括号，上限 900 字防爆 token） */
  const addToConversation = () => {
    if (visible.length === 0) return;
    const compact = visible
      .map((e) => `[${e.level}] ${e.message}`)
      .join(" ; ")
      .replace(/[{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const body = `页面 ${pageUrl || "(未知)"} ; ${compact || "no-logs"}`;
    const capped = body.length > 900 ? `${body.slice(0, 900)}…(截断)` : body;
    const allErrors = visible.every((e) => e.level === "error");
    // 标签对齐 Trae 的「3 error(s)」；混有警告时退回中文计数
    const label = allErrors
      ? `${visible.length} error(s)`
      : `${visible.length} 条日志`;
    const token = `:console[${label}]{name=${capped}}`;
    let current = "";
    try {
      current = (aui.composer.getState() as { text?: string })?.text ?? "";
    } catch {
      current = "";
    }
    aui.composer.setText(current.trim() ? `${current.trimEnd()} ${token}` : token);
    toast.add({ title: "已加入输入框", type: "success" });
  };

  return (
    <div className="relative shrink-0 border-t" data-slot="browser-console">
      {/* 上缘拖拽条：调日志区高度（只在展开态有意义） */}
      {!collapsed ? (
        <div
          onPointerDown={startResize}
          title="拖动调整高度"
          className="absolute inset-x-0 -top-0.5 z-10 h-1.5 cursor-ns-resize"
        />
      ) : null}
      {/* 头部：开合 / 标题 / 错误计数 / 过滤 · 清空 · 添加到对话 */}
      <div className="text-muted-foreground flex h-8 items-center gap-1 px-2 text-xs">
        <button
          type="button"
          aria-label={collapsed ? "展开控制台" : "收起控制台"}
          title={collapsed ? "展开控制台" : "收起控制台"}
          onClick={toggle}
          className="hover:text-foreground hover:bg-muted inline-flex size-5 shrink-0 items-center justify-center rounded"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
          />
        </button>
        <span>控制台日志</span>
        {errorCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title={`错误 ${errorCount}`}>
            <CircleXIcon className="size-3.5 text-red-500" />
            <span className="text-red-500">{errorCount}</span>
          </span>
        ) : null}
        {warningCount > 0 ? (
          <span
            className="inline-flex items-center gap-0.5"
            title={`警告 ${warningCount}`}
          >
            <TriangleAlertIcon className="size-3.5 text-amber-500" />
            <span className="text-amber-500">{warningCount}</span>
          </span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="过滤级别"
                title={`过滤：${FILTER_LABEL[filter]}`}
                className={cn(
                  "hover:text-foreground hover:bg-muted inline-flex size-5 shrink-0 items-center justify-center rounded",
                  filter !== "all" && "text-foreground bg-muted",
                )}
              >
                <ListFilterIcon className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-32">
            {(Object.keys(FILTER_LABEL) as LevelFilter[]).map((key) => (
              <DropdownMenuItem
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
                onClick={() => setFilter(key)}
              >
                {FILTER_LABEL[key]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={clear}
          disabled={entries.length === 0}
          className="hover:text-foreground hover:bg-muted inline-flex h-5 items-center gap-1 rounded px-1.5 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <EraserIcon className="size-3.5" />
          清除
        </button>
        <button
          type="button"
          onClick={addToConversation}
          disabled={visible.length === 0}
          className="hover:text-foreground hover:bg-muted inline-flex h-5 items-center gap-1 rounded px-1.5 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <SparklesIcon className="size-3.5 text-emerald-500" />
          添加到对话
          {visible.length > 0 ? (
            <span className="text-muted-foreground/70">· {visible.length}</span>
          ) : null}
        </button>
      </div>
      {!collapsed && (
        <div
          style={{ height: bodyHeight }}
          className="border-border/50 overflow-y-auto border-t px-2 py-1"
        >
          {visible.length === 0 ? (
            <div className="text-muted-foreground/60 py-3 text-center text-xs">
              {entries.length === 0 ? "暂无日志" : "当前过滤下没有日志"}
            </div>
          ) : (
            visible.map((e) => {
              const meta = LEVEL_META[e.level] ?? LEVEL_META.info;
              const Icon = meta.icon;
              const expanded = expandedId === e.id;
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                  title={`${meta.label}：${e.message}`}
                  className="hover:bg-muted/60 flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left"
                >
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", meta.className)} />
                  <span
                    className={cn(
                      "text-foreground/85 min-w-0 flex-1 font-mono text-[11px] leading-5 break-all",
                      !expanded && "line-clamp-2",
                    )}
                  >
                    {e.message}
                    {e.source ? (
                      <span className="text-muted-foreground/60">
                        {" "}
                        {e.source}
                        {e.line ? `:${e.line}` : ""}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
