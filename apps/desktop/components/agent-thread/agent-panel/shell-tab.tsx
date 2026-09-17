"use client";

// xterm 基础样式（字体/滚动条/光标），随 shell 标签首次加载才进页面
import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, type FC } from "react";
import { Loader2Icon, RotateCcwIcon, SquareTerminalIcon } from "lucide-react";
import {
  ensureShellTabBridge,
  findShell,
  fitShell,
  hasPendingShell,
  restartShellTab,
  useShellStore,
} from "@/lib/shell";
import type { PanelTab } from "@/lib/panel-tabs";
import { isTauri } from "@/lib/tauri";
import { TabEmpty } from "./tab-empty";

/**
 * 真终端面板（VSCode 终端 tab 形态）：一个会话 = 一个面板标签，会话列表
 * 并入顶部标签栏（图标 + 标题即身份），面板内不再有工具栏/会话条——
 * 整个视图就是 xterm 视口。视图只是搬运工：会话对象活在 lib/shell.ts
 * store 里，挂载时 appendChild 宿主 + 首次 open + fit + 聚焦，卸载时摘除
 * 宿主——隐藏时零 DOM 残留，也不做 0×0 的 fit 空转；进程与缓冲不受影响。
 * 关标签的回收（杀 PTY + dispose）由 shell store 的标签桥统一处理；
 * 进程退出（exit）时桥反向自动关闭标签。仅剩两种非视口态：创建中
 * （加载态）与刷新后会话悬空（"重新启动"卡，一键重建并回绑本标签）。
 */

export const ShellTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  useShellStore(); // 订阅会话集合：spawn/dispose 触发本视图重取 findShell
  const session = findShell(tab.sessionId);
  const boxRef = useRef<HTMLDivElement>(null);

  // 桥安装与视图共存亡无意义（模块级、幂等），触达即装
  useEffect(() => {
    ensureShellTabBridge();
  }, []);

  // 宿主就位 + 首次 open + 自适应 + 聚焦；卸载摘除宿主（元素本体 store 保活）。
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
    session.terminal.focus();
    const ro = new ResizeObserver(() => fitShell(session));
    ro.observe(box);
    return () => {
      ro.disconnect();
      session.host.remove();
    };
  }, [session]);

  if (!isTauri())
    return <TabEmpty icon={SquareTerminalIcon} text="交互式终端仅桌面端可用" />;

  // 刷新恢复/启动失败：标签还在但会话不在了（pending = 创建中，出加载态）
  if (!session) {
    if (hasPendingShell(tab.sessionId)) {
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
          onClick={() => restartShellTab(tab)}
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
      className="px-2 py-1.5 relative h-full min-h-0 overflow-hidden"
    />
  );
};
