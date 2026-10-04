/**
 * 打字机式流式文本（移植自 assistant-ui 官方 web 实现
 * `packages/react/src/utils/smooth/useSmooth.ts` 的 `TextStreamAnimator`）：
 * RN 的 markdown element 上游没有这一层（只有节流），官方那套 smooth 只挂在
 * web 的 `<MessagePartPrimitive.Text smooth>` 上。这里按原算法搬过来：
 *
 * - 按帧推进：每帧把「未揭示的积压」按 drainMs 摊平（baseTimePerChar =
 *   min(maxCharIntervalMs, drainMs / 剩余字符)），积压大就一次多吐几个字，
 *   积压小就慢到 maxCharIntervalMs 一个字——观感是连续的打字机，而不是
 *   每 50ms 蹦一块；
 * - 提交节流（minCommitMs）：推进每帧都在跑，但**渲染提交**最多每个间隔一次。
 *   这正是官方向 markdown 场景暴露这个参数的原因——下游要重新解析 markdown，
 *   不能每帧都提交。这里取 50ms；
 * - 收尾：源文本已结束但还没揭示完时继续追（不会留半截），追上即停；
 * - 内容被整段替换（编辑/重生成）→ 从头重放；
 * - 未流式（历史消息/已结束）→ 直接返回全文，零动画零成本；
 * - 降低动效偏好（iOS 辅助功能）→ 直接返回全文（对齐官方 reduce-motion 行为）。
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";

export type SmoothTextOptions = {
  /** 把积压揭示完的目标时长（ms），越大越绵 */
  drainMs?: number;
  /** 积压很小时的最慢出字间隔（ms），即最慢速度 */
  maxCharIntervalMs?: number;
  /** 单帧最多揭示多少字符（防一次性哗啦一大片） */
  maxCharsPerFrame?: number;
  /** 两次渲染提交之间的最小间隔（ms）：markdown 重解析的成本闸门 */
  minCommitMs?: number;
};

const DRAIN_MS = 250;
const MAX_CHAR_INTERVAL_MS = 5;
const MIN_COMMIT_MS = 50;

/** 官方 TextStreamAnimator 的原样移植（去掉了 web 专属的 store 状态回写） */
class TextStreamAnimator {
  private animationFrameId: number | null = null;
  private lastUpdateTime = Date.now();
  public lastCommitTime = 0;

  public targetText = "";
  public drainMs = DRAIN_MS;
  public maxCharIntervalMs = MAX_CHAR_INTERVAL_MS;
  public maxCharsPerFrame = Infinity;
  public minCommitMs = MIN_COMMIT_MS;
  public currentText: string;

  constructor(
    currentText: string,
    private readonly setText: (next: string) => void,
  ) {
    this.currentText = currentText;
  }

  start() {
    if (this.animationFrameId !== null) return;
    this.lastUpdateTime = Date.now();
    this.animate();
  }

  stop() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private animate = () => {
    const currentTime = Date.now();
    const deltaTime = currentTime - this.lastUpdateTime;
    let timeToConsume = deltaTime;

    const remainingChars = this.targetText.length - this.currentText.length;
    const baseTimePerChar = Math.min(
      this.maxCharIntervalMs,
      this.drainMs / remainingChars,
    );

    const frameLimit = Math.min(remainingChars, this.maxCharsPerFrame);
    let charsToAdd = 0;
    while (timeToConsume >= baseTimePerChar && charsToAdd < frameLimit) {
      charsToAdd++;
      timeToConsume -= baseTimePerChar;
    }
    // 被单帧上限截断时，多余的时间不能存着，否则下一帧会冲过上限爆发一大段
    if (charsToAdd === frameLimit && frameLimit === this.maxCharsPerFrame) {
      timeToConsume = 0;
    }

    if (charsToAdd !== remainingChars) {
      this.animationFrameId = requestAnimationFrame(this.animate);
    } else {
      this.animationFrameId = null;
    }
    if (charsToAdd === 0) return;

    this.currentText = this.targetText.slice(
      0,
      this.currentText.length + charsToAdd,
    );
    this.lastUpdateTime = currentTime - timeToConsume;

    const isComplete = charsToAdd === remainingChars;
    if (isComplete || currentTime - this.lastCommitTime >= this.minCommitMs) {
      this.lastCommitTime = currentTime;
      this.setText(this.currentText);
    }
  };
}

/** 降低动效偏好：开启时不做打字机（官方同款行为） */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (alive) setReduce(v === true);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.(
      "reduceMotionChanged",
      (v) => setReduce(v === true),
    );
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduce;
}

export function useSmoothText(
  text: string,
  streaming: boolean,
  options: SmoothTextOptions = {},
): string {
  const reduceMotion = useReduceMotion();
  const enabled = streaming && !reduceMotion;
  const { drainMs, maxCharIntervalMs, maxCharsPerFrame, minCommitMs } = options;

  const [displayed, setDisplayed] = useState(() =>
    streaming ? "" : text,
  );
  const animatorRef = useRef<TextStreamAnimator | null>(null);
  if (animatorRef.current === null) {
    animatorRef.current = new TextStreamAnimator(streaming ? "" : text, (next) =>
      setDisplayed(next),
    );
  }
  const animator = animatorRef.current;

  // 参数落到 animator 上（每帧读取，不需要重建）
  animator.drainMs = drainMs ?? DRAIN_MS;
  animator.maxCharIntervalMs = maxCharIntervalMs ?? MAX_CHAR_INTERVAL_MS;
  animator.maxCharsPerFrame = maxCharsPerFrame ?? Infinity;
  animator.minCommitMs = minCommitMs ?? MIN_COMMIT_MS;

  // 渲染期纠正：已显示内容不再是新文本的前缀（换消息/编辑/重生成）→ 重置游标
  const shown = enabled ? displayed : text;
  if (enabled && !text.startsWith(animator.currentText)) {
    animator.currentText = "";
    animator.lastCommitTime = 0;
  }

  useEffect(() => {
    if (!enabled) {
      animator.stop();
      animator.currentText = text;
      animator.targetText = text;
      return;
    }
    animator.targetText = text;
    animator.start();
  }, [animator, enabled, text]);

  useEffect(
    () => () => {
      animator.stop();
    },
    [animator],
  );

  return shown;
}
