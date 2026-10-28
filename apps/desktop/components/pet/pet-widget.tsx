"use client";

/**
 * 桌宠组合宿主（内嵌 / 悬浮窗共用）：<Pet> + 事件动作 + 头顶气泡。
 *
 * 定位是宿主的事：variant 只影响默认尺寸与外层包裹（inline 自适应内容，
 * floating 由悬浮窗路由绝对定位），组件本身不写 fixed。
 * 事件源经 `subscribeEvents` 注入（见 `use-pet-agent-events.ts` 的三种来源）。
 */

import * as React from "react";
import type { PetManifest, PetMotion, PetMotionInput, PetRef } from "@/lib/pet/types";
import { PET_DEFAULT_SIZE } from "@/lib/pet/atlas";
import { Pet } from "./pet";
import { PetBubble, type PetBubbleState } from "./pet-bubble";
import { usePetAgentEvents, type PetEventSubscribe } from "./use-pet-agent-events";

export function PetWidget(props: {
  variant: "inline" | "floating";
  manifest: PetManifest | string;
  /** 显示宽度 px；inline 缺省 150，floating 缺省 170 */
  size?: number;
  subscribeEvents: PetEventSubscribe;
  /** 气泡点击跳会话 */
  onOpenSession?: (sessionId: string) => void;
  /** 素材加载失败（气泡位展示一条常驻错误气泡，不弹系统通知） */
  onError?: (error: Error) => void;
  /** 手势态透传（悬浮窗拖拽要：拖身体时宠物播左右跑）；"left"/"right" = 带方向 */
  dragging?: boolean | "left" | "right" | "up" | "down";
  /** 身体命中框按下透传（悬浮窗用它发起程序化拖窗） */
  onHitboxPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  /** 身体命中框右键（宿主接菜单） */
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  /** 声明式动作透传（动图演示页用：idle/working 落到不同素材） */
  motion?: PetMotionInput;
  /** 生效动作变化透传（dev 预览页的状态标签用） */
  onMotionChange?: (motion: PetMotion) => void;
  /** 命令面透传（宿主手动播动作，如 dev 预览页的动作按钮） */
  ref?: React.Ref<PetRef | null>;
  className?: string;
}) {
  const { variant, manifest, size, subscribeEvents, onOpenSession, onError, dragging, onHitboxPointerDown, onContextMenu, motion, onMotionChange, ref, className } = props;
  // 合并 ref：命令面动作始终走内部 ref（事件接线的 onMotion 依赖它），
  // 宿主传入的 ref 同步拿到同一个句柄（对象/回调 ref 都支持）
  const innerRef = React.useRef<PetRef | null>(null);
  const mergedRef = React.useCallback(
    (node: PetRef | null) => {
      innerRef.current = node;
      if (typeof ref === "function") {
        ref(node);
        return;
      }
      if (ref !== null && ref !== undefined) (ref as React.RefObject<PetRef | null>).current = node;
    },
    [ref],
  );
  const { bubble, onBubbleClick } = usePetAgentEvents({
    subscribe: subscribeEvents,
    onMotion: (input) => innerRef.current?.motion(input),
    onOpenSession,
  });
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const resolvedSize = size ?? (variant === "inline" ? 150 : PET_DEFAULT_SIZE - 60);

  // 切换清单即清错误态：onReady 只在图集形态有探测，动图清单加载成功没有
  // onReady 回调——不清的话，上一个素材的失败提示会永远挂在好素材上
  const manifestKey = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
  React.useEffect(() => {
    setLoadError(null);
  }, [manifestKey]);

  const handleError = React.useCallback(
    (error: Error) => {
      setLoadError(error.message);
      onError?.(error);
    },
    [onError],
  );

  // 素材挂了也要让人知道为什么没宠物：气泡位显示一条错误提示（点击关闭）
  const effectiveBubble: PetBubbleState | null = loadError !== null
    ? { id: "load-error", text: `桌宠素材加载失败：${loadError}` }
    : bubble;

  return (
    <div
      data-pet-interactive
      data-variant={variant}
      className={className}
      style={{ position: "relative", display: "inline-block" }}
    >
      <Pet
        ref={mergedRef}
        manifest={manifest}
        size={resolvedSize}
        dragging={dragging}
        onHitboxPointerDown={onHitboxPointerDown}
        onContextMenu={onContextMenu}
        motion={motion}
        onMotionChange={onMotionChange}
        onError={handleError}
        onReady={() => {
          setLoadError(null);
        }}
      />
      <PetBubble bubble={effectiveBubble} onClick={onBubbleClick} />
    </div>
  );
}
