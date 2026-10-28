"use client";

/**
 * 宠物头顶气泡：事件提醒的呈现层。
 *
 * 一个时刻只有一条气泡（新事件顶掉旧的）；到点自动收起由父级 hook 管理，
 * 本组件只负责画与点击。点击行为由 `onClick` 决定：有会话意图时跳会话，
 * 没有就只是收起气泡。`data-pet-interactive` 供悬浮窗做点击穿透命中判断。
 */

import * as React from "react";

export interface PetBubbleState {
  /** 唯一键：新事件顶掉旧气泡（同一事件重复到达不重置计时，由调用方去重） */
  id: string;
  text: string;
  /** 非空时点击气泡触发（跳会话） */
  actionSessionId?: string;
}

export function PetBubble(props: {
  bubble: PetBubbleState | null;
  onClick: (bubble: PetBubbleState) => void;
}) {
  const { bubble, onClick } = props;
  if (!bubble) return null;

  return (
    <div
      data-pet-interactive
      role="status"
      onClick={() => onClick(bubble)}
      style={{
        position: "absolute",
        bottom: "calc(100% - 10px)",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "5px 10px",
        borderRadius: 12,
        background: "var(--popover, #ffffff)",
        color: "var(--popover-foreground, #111)",
        border: "1px solid var(--border, rgba(0,0,0,.12))",
        boxShadow: "0 3px 10px rgba(0,0,0,.14)",
        fontSize: 12,
        lineHeight: 1.4,
        cursor: bubble.actionSessionId ? "pointer" : "default",
        whiteSpace: "nowrap",
        zIndex: 10,
      }}
      title={bubble.actionSessionId ? "点击查看会话" : undefined}
    >
      {bubble.text}
      {/* 指向宠物头顶的尾巴：上下两个三角叠出描边效果 */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          bottom: -5,
          left: "50%",
          transform: "translateX(-50%) rotate(45deg)",
          width: 8,
          height: 8,
          background: "inherit",
          borderRight: "1px solid var(--border, rgba(0,0,0,.12))",
          borderBottom: "1px solid var(--border, rgba(0,0,0,.12))",
        }}
      />
      {bubble.actionSessionId ? (
        <span
          style={{
            display: "block",
            marginTop: 2,
            fontSize: 10,
            color: "var(--muted-foreground, #888)",
          }}
        >
          点击查看会话
        </span>
      ) : null}
    </div>
  );
}
