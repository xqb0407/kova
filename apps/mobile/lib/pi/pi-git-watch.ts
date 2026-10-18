"use client";

/**
 * Git 面板的失效通道（移动端）。
 *
 * 桌面端有 "git-changed" 事件、窗口聚焦、agent 回合结束三路失效；移动端没有
 * 桌面壳，sidecar 也不推 git-changed，能依赖的只有：
 *   - turn 结束（agent 可能改过文件）——subscribeTurns 的 active=false；
 *   - 回前台（离开期间 agent 可能跑完）——AppState 变 active。
 * 只刷新当前打开的会话：快照本身就按会话键存在，别的会话没有面板在看。
 */
import { useEffect } from "react";
import { AppState } from "react-native";
import { getPiChannel } from "@/lib/pi/pi-channel";
import { refreshGitStatus } from "@/lib/pi/pi-git";

/**
 * @param enabled 面板是否可能展示（仓库会话或有错误）。非仓库会话即使
 *   `GitSection` 渲染为 null，hook 也会常驻；不关掉的话每回合结束都会让
 *   sidecar 起一次 `git rev-parse`，纯浪费。代价：agent 在非 git 目录里
 *   `git init` 后不会自动发现，需切会话/重进面板。
 */
export function useGitStatusInvalidation(
  sessionId: string | undefined,
  enabled = true,
): void {
  useEffect(() => {
    if (!sessionId || !enabled) return;

    let disposed = false;
    let off: (() => void) | null = null;
    try {
      const sub = getPiChannel().subscribeTurns?.((sid, active) => {
        // sid === null 是事件源失效（断连/后端重启），不是回合结束
        if (sid === sessionId && !active) void refreshGitStatus(sessionId);
      });
      if (typeof sub === "function") {
        off = sub;
      } else if (sub) {
        // 桌面壳的 listen 是异步登记；卸载后才就绪就直接退订
        void sub
          .then((fn) => {
            if (disposed) fn();
            else off = fn;
          })
          .catch(() => {});
      }
    } catch {
      // 通道未就绪（未配对）：挂载时的首拉会走 piRequest，失败同样落进快照
    }

    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshGitStatus(sessionId);
    });

    return () => {
      disposed = true;
      off?.();
      appState.remove();
    };
  }, [sessionId, enabled]);
}
