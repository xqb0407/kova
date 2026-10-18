"use client";

import type { FC } from "react";
import { restartShellTab } from "@/lib/shell";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import { ShellViewport } from "./shell-viewport";

/**
 * 真终端面板（VSCode 终端 tab 形态）：一个会话 = 一个面板标签，会话列表
 * 并入顶部标签栏（图标 + 标题即身份），面板内不再有工具栏/会话条——
 * 整个视图就是 xterm 视口（视口实现与底部终端坞共用，见 shell-viewport）。
 */
export const ShellTab: FC<{ tab: PanelTab }> = ({ tab }) => (
  <ShellViewport
    sessionId={tab.sessionId}
    onRestart={() => restartShellTab(tab)}
  />
);