"use client";

// xterm 基础样式（字体/滚动条/光标），随 shell 标签首次加载才进页面
import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, type FC } from "react";
import {
  PlusIcon,
  RotateCcwIcon,
  SquareTerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  closeAllShells,
  closeShell,
  createShell,
  fitShell,
  setActiveShell,
  useShellStore,
} from "@/lib/shell";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { TabEmpty } from "./tab-empty";

/**
 * 真终端面板：VSCode 集成终端形态——一个面板标签内多会话，
 * 顶栏（新建/清屏全部/重启）+ 中部视口 + 底部会话列表。
 * 视图只是宿主：会话与 xterm 元素在 lib/shell.ts store 里保活，
 * 切面板标签重挂载时把元素 append 回来；非激活会话 display:none。
 * 关面板标签不杀会话（同 VSCode 隐藏面板），杀会话走列表 × / 垃圾桶。
 */

const ToolButton: FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className="hover:bg-muted size-6 rounded-md p-1 text-muted-foreground transition-colors"
  >
    {children}
  </button>
);

export const ShellTab: FC = () => {
  const { list, activeId } = useShellStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const active = list.find((s) => s.id === activeId) ?? null;
  const activeRef = useRef(active);
  activeRef.current = active;

  // 把全部会话宿主挂进视口；未 open 的首次 open（fit 由 ResizeObserver 兜底）
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    for (const s of list) {
      if (!box.contains(s.host)) box.appendChild(s.host);
      if (!s.opened) {
        s.terminal.open(s.host);
        s.opened = true;
      }
    }
  }, [list]);

  // 激活项切换：显隐 + 自适应 + 聚焦
  useEffect(() => {
    for (const s of list) s.host.classList.toggle("hidden", s.id !== activeId);
    if (active) {
      fitShell(active);
      active.terminal.focus();
    }
  }, [list, activeId, active]);

  // 容器尺寸变化 → 当前会话重排（隐藏会话的 fit 在 0×0 下合法空转）
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      if (activeRef.current) fitShell(activeRef.current);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  if (!isTauri())
    return <TabEmpty icon={SquareTerminalIcon} text="交互式终端仅桌面端可用" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <span className="text-muted-foreground text-xs">终端</span>
        {active ? (
          <span
            className={cn(
              "size-1.5 rounded-full",
              active.alive ? "bg-emerald-500" : "bg-destructive",
            )}
          />
        ) : null}
        {active?.title ? (
          <span className="text-muted-foreground/70 truncate font-mono text-xs">
            {active.title}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {active && !active.alive ? (
            <ToolButton
              title="重启当前终端"
              onClick={() => {
                const deadId = active.id;
                // 先开新（activeId 自动切到新会话）再收掉死会话，不留僵尸标签
                void createShell().finally(() => closeShell(deadId));
              }}
            >
              <RotateCcwIcon className="size-3.5" />
            </ToolButton>
          ) : null}
          <ToolButton title="新建终端" onClick={() => void createShell()}>
            <PlusIcon className="size-3.5" />
          </ToolButton>
          {list.length > 0 ? (
            <ToolButton title="全部关闭" onClick={closeAllShells}>
              <Trash2Icon className="size-3.5" />
            </ToolButton>
          ) : null}
        </div>
      </div>

      <div
        ref={boxRef}
        onClick={() => activeRef.current?.terminal.focus()}
        className="relative min-h-0 flex-1 overflow-hidden"
      />

      {list.length > 1 || list.length === 0 ? (
        // VSCode 底栏式全高 tab：激活项 = 加粗文字 + 主题色下划线，
        // 不靠背景色差（深浅主题下背景色都太含蓄，观感"不明显"）
        <div className="bg-muted/50 border-border/70 flex h-10 shrink-0 items-stretch gap-0.5 border-t px-1.5 overflow-x-auto select-none">
          {list.length === 0 ? (
            <button
              type="button"
              onClick={() => void createShell()}
              className="border-border/80 text-muted-foreground hover:border-primary/60 hover:text-foreground my-2 flex items-center gap-1.5 rounded-lg border border-dashed px-3 text-xs transition-colors"
            >
              <PlusIcon className="size-3.5" />
              新建终端
            </button>
          ) : null}
          {list.map((s, i) => {
            const isActive = s.id === activeId;
            return (
              <div
                key={s.id}
                className={cn(
                  "group relative flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs transition-colors",
                  isActive
                    ? "bg-background/80 text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
                onClick={() => setActiveShell(s.id)}
              >
                {/* 激活下划线：贴条带上沿，主题色，深浅底都醒目 */}
                {isActive ? (
                  <span className="bg-primary absolute inset-x-2 bottom-0 h-[2px] rounded-full" />
                ) : null}
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    s.alive ? "bg-emerald-500" : "bg-destructive",
                  )}
                />
                <span className="text-muted-foreground/80 tabular-nums">
                  {i + 1}
                </span>
                <span className="max-w-44 truncate font-mono">{s.title}</span>
                <button
                  type="button"
                  title="关闭终端"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeShell(s.id);
                  }}
                  className="-mr-1 rounded-sm p-0.5 opacity-40 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
