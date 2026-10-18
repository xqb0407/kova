"use client";

// xterm 基础样式（字体/滚动条/光标）+ 本应用的视口底色修正，随 shell
// 视口首次加载才进页面
import "@xterm/xterm/css/xterm.css";
import "@/app/styles/xterm-shell.css";

import { useEffect, useRef, type FC } from "react";
import { Loader2Icon, RotateCcwIcon, SquareTerminalIcon } from "lucide-react";
import {
  ensureShellTabBridge,
  findShell,
  fitShell,
  hasPendingShell,
  useShellStore,
} from "@/lib/shell";
import { isDesktop } from "@/lib/desktop-env";
import { isResizing, onResizeSettled } from "@/lib/ui/resize-session";
import { TabEmpty } from "./tab-empty";

/**
 * 真终端视口：xterm 的挂载/自适应/聚焦逻辑，面板 terminal 标签
 * （ShellTab）与底部终端坞（terminal-dock）共用同一份实现——两个入口面
 * 只是标签宿主不同，视口行为没有分歧。
 *
 * 视图只是搬运工：会话对象活在 lib/shell.ts store 里，挂载时 appendChild
 * 宿主 + 首次 open + fit + 聚焦，卸载时摘除宿主——隐藏时零 DOM 残留，也
 * 不做 0×0 的 fit 空转；进程与缓冲不受影响。关标签的回收（杀 PTY +
 * dispose）由 shell store 的标签桥统一处理；进程退出（exit）时桥反向
 * 自动关闭标签。仅剩两种非视口态：创建中（加载态）与刷新后会话悬空
 * （"重新启动"卡，一键重建并回绑本标签）。
 */
export const ShellViewport: FC<{
  /** 绑定的终端会话 id；悬空（刷新后）出重启卡 */
  sessionId: string | null | undefined;
  /** 重启卡的"重新启动"：调用方按自己的标签宿主重建会话 */
  onRestart: () => void;
  /** 视口内边距等容器样式（面板标签 px-2 py-1.5，坞内更紧） */
  className?: string;
  /**
   * 视口当前是否可见（默认 true）。终端坞收起时视口仍常驻（保 xterm 尺寸
   * 与缓冲），但不能抢焦点——隐藏的 xterm 调 focus() 会把输入从聊天框
   * 偷走。面板标签没有隐藏态，不传即可。
   */
  visible?: boolean;
}> = ({ sessionId, onRestart, className, visible = true }) => {
  useShellStore(); // 订阅会话集合：spawn/dispose 触发本视图重取 findShell
  const session = findShell(sessionId ?? undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  // 桥安装与视图共存亡无意义（模块级、幂等），触达即装
  useEffect(() => {
    ensureShellTabBridge();
  }, []);

  // 可见才聚焦（切标签/展开坞/新会话都走这里）
  useEffect(() => {
    if (!visible || !session) return;
    session.terminal.focus();
  }, [visible, session]);

  // 宿主就位 + 首次 open + 自适应；卸载摘除宿主（元素本体 store 保活）。
  // ResizeObserver 同周期挂卸：首帧容器随会话在场与否切换渲染，
  // 空依赖挂载会赶在容器出现之前、永久错过观察
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !session) return;
    if (!box.contains(session.host)) box.appendChild(session.host);
    if (!session.opened) {
      session.terminal.open(session.host);
      session.opened = true;
    }
    fitShell(session);
    // resize → fit 会重排 xterm 缓冲区并逐次 IPC pty_resize：去抖到 80ms。
    // 拖拽调宽期间内容区已冻结（RO 本来不会响），从收起态拖开时也先跳过，
    // 松手后 resize-settled 一次落位，避免拖动中每个宽度都打一轮 PTY
    let fitTimer: number | undefined;
    const scheduleFit = () => {
      if (isResizing()) return;
      if (fitTimer !== undefined) return;
      fitTimer = window.setTimeout(() => {
        fitTimer = undefined;
        fitShell(session);
      }, 80);
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(box);
    const offSettled = onResizeSettled(() => fitShell(session));
    return () => {
      ro.disconnect();
      offSettled();
      if (fitTimer !== undefined) window.clearTimeout(fitTimer);
      session.host.remove();
    };
  }, [session]);

  if (!isDesktop())
    return <TabEmpty icon={SquareTerminalIcon} text="交互式终端仅桌面端可用" />;

  // 刷新恢复/启动失败：标签还在但会话不在了（pending = 创建中，出加载态）
  if (!session) {
    if (hasPendingShell(sessionId ?? undefined)) {
      return (
        <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1.5 text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          正在启动终端…
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <SquareTerminalIcon className="text-muted-foreground/50 size-6" />
        <p className="text-muted-foreground text-xs">
          终端会话已结束（页面刷新后旧会话随 webview 销毁）
        </p>
        <button
          type="button"
          onClick={onRestart}
          className="hover:bg-primary/10 hover:text-primary hover:border-primary/40 flex items-center gap-1.5 rounded-lg border border-border/70 px-3 py-1.5 text-xs text-foreground transition-colors"
        >
          <RotateCcwIcon className="size-3.5" />
          重新启动
        </button>
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      onClick={() => session.terminal.focus()}
      className={className ?? "relative h-full min-h-0 overflow-hidden px-2 py-1.5"}
    />
  );
};