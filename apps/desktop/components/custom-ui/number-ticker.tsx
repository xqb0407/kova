"use client";

// 移植自 kova-search（web/src/components/motion/number-ticker），仅适配本仓库的
// cn / ease 路径与注释；数字按「位」滚动，非数字字符（小数点、万/亿等单位）保持静止。

import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface NumberTickerProps {
  value: number;
  /** 左侧补零到指定位数。 */
  pad?: number;
  /** 单个数字的滚动时长（秒）。 */
  duration?: number;
  /** 数字之间的错峰间隔（秒）。 */
  stagger?: number;
  /** 进入视口后才开始滚动。 */
  startOnView?: boolean;
  prefix?: string;
  suffix?: string;
  /** 滚动期间轻微模糊。 */
  blur?: boolean;
  className?: string;
  digitClassName?: string;
  /** 用本地化千分位分隔（服务端组件安全）。 */
  locale?: boolean;
  /** 自定义格式化（仅客户端可用；服务端组件请用 locale）。 */
  format?: (value: number) => string;
}

const DIGIT_HEIGHT_EM = 1.1;
const DIGITS = Array.from({ length: 10 }, (_, n) => n);

/**
 * 数字滚轮：每个数字占一个 1ch 宽、1.1em 高的窗口，内部竖排 0~9，按目标位滚上去。
 * 文本里的非数字字符（".", "万", " " 等）原样静态渲染，所以「2679.6 万」只有数字在动。
 */
export function NumberTicker({
  value,
  pad,
  duration = 0.9,
  stagger = 0.04,
  startOnView = true,
  prefix,
  suffix,
  blur = false,
  className,
  digitClassName,
  locale,
  format,
}: NumberTickerProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const inView = useInView(containerRef, { once: true, amount: 0.6 });
  const [armed, setArmed] = useState(!startOnView);

  useEffect(() => {
    if (startOnView && inView) setArmed(true);
  }, [startOnView, inView]);

  const text = useMemo(() => {
    const rounded = Math.round(value);
    const formatted = format
      ? format(rounded)
      : locale
        ? rounded.toLocaleString()
        : rounded.toString();
    return pad ? formatted.padStart(pad, "0") : formatted;
  }, [value, pad, format, locale]);
  const glyphs = useMemo(() => {
    const chars = text.split("");
    // 按键名（从右往左的位）标记：数字变化时保持同一身份滚到新值，而不是重挂载后
    // 从 0 重播；位数增长时左侧新增字符，右侧已有的个十百位不会被重新编号。
    return chars.map((char, i) => ({ char, id: `g-${chars.length - 1 - i}` }));
  }, [text]);
  const readableText = `${prefix ?? ""}${text}${suffix ?? ""}`;

  // 错峰只是入场效果：入场播完后，数值变化时每一位立即滚动——实时更新上加每位的
  // 延迟会显得迟钝。
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!armed || entered) return;
    const total = (duration + glyphs.length * stagger) * 1000;
    const t = window.setTimeout(() => setEntered(true), total);
    return () => window.clearTimeout(t);
  }, [armed, entered, duration, stagger, glyphs.length]);

  return (
    <span
      ref={containerRef}
      className={cn("inline-flex items-center tabular-nums", className)}
    >
      <span className="sr-only">{readableText}</span>
      {/* 数字与单位走普通 inline 流，不套 flex：flex 的 items-center 会把「数字窗口」
          和「. 万 亿」这些静态字形各自居中，两者的基线就对不上周围文字了。 */}
      <span aria-hidden="true">
        {prefix ? <span>{prefix}</span> : null}
        {glyphs.map(({ char, id }, i) => {
          const isDigit = /\d/.test(char);
          if (!isDigit) {
            return (
              // whitespace-pre：空白字符也常出现在格式串里（如「1.4 亿」的空格），
              // 而纯空白的 inline-block 会被折成零宽，空格就直接消失了。
              <span key={id} className="inline-block whitespace-pre">
                {char}
              </span>
            );
          }
          const digit = Number(char);
          return (
            <Digit
              key={id}
              digit={armed ? digit : 0}
              delay={entered ? 0 : i * stagger}
              duration={duration}
              blur={blur}
              className={digitClassName}
            />
          );
        })}
        {suffix ? <span>{suffix}</span> : null}
      </span>
    </span>
  );
}

function Digit({
  digit,
  delay,
  duration,
  blur,
  className,
}: {
  digit: number;
  delay: number;
  duration: number;
  blur: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const columnRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reduce || !blur || !columnRef.current || !Number.isFinite(digit)) {
      return;
    }

    const node = columnRef.current;
    const controls = animate(
      node,
      { filter: ["blur(10px)", "blur(0px)"] },
      {
        duration: Math.min(duration * 0.75, 0.32),
        delay,
        ease: EASE_OUT,
      },
    );

    return () => {
      controls.stop();
      node.style.filter = "blur(0px)";
    };
  }, [blur, delay, digit, duration, reduce]);

  return (
    // 窗口这条规则是基线对齐的关键：overflow 非 visible 的 inline-block，基线取「盒底边」，
    // 而数字墨迹在 1.1em 窗口里是居中的，于是整段数字会浮到基线上方约 2px（小数点被抬到
    // 字腰、看着像另一套更大的字体）。三件事一起修：
    // 1. 裁剪改用 clip-path，overflow 保持 visible——窗口才能像普通文字一样由行盒定基线；
    // 2. 在流内放一个隐形 0 撑出这行行盒（滚轮列是绝对定位，不参与基线计算）；
    // 3. 行高压成 1，让窗口基线只由字号决定，不跟着调用方的 line-height 走
    //    （数字单元格同样 leading-none，两边基线偏移一致才会重合）。
    <span
      className={cn("relative inline-block", className)}
      style={{
        height: `${DIGIT_HEIGHT_EM}em`,
        width: "1ch",
        // 行高写进 style 而不是类名：调用方传 digitClassName 里的 leading-* 不会
        // 用 tailwind-merge 顶掉它，而它一旦变了，窗口和单元格的基线就会错开。
        lineHeight: 1,
        clipPath: "inset(0)",
      }}
    >
      <span className="invisible">0</span>
      <motion.span
        ref={columnRef}
        initial={{ y: 0 }}
        animate={{ y: `-${digit * DIGIT_HEIGHT_EM}em` }}
        transition={reduce ? { duration: 0 } : { duration, delay, ease: EASE_OUT }}
        className="absolute inset-x-0 top-0 flex flex-col items-center will-change-[transform,filter]"
      >
        {DIGITS.map((n) => (
          // 一格 = 一个行盒：先别用 items-center 居中——单元格 1.1em 比行盒 1em 高，
          // 居中会把数字压低约半像素，和窗口的基线错开。leading-none 也要和窗口一致。
          <span key={n} className="block h-[1.1em] text-center leading-none">
            {n}
          </span>
        ))}
      </motion.span>
    </span>
  );
}
