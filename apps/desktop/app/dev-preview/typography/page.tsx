"use client";

/**
 * 【字体验收页】Windows 字体渲染/字号/细线的肉眼对照。
 *
 * 用途：Windows 是当前字体问题最集中的平台（系统雅黑只有 400/700、
 * 100%/125% 缩放下的整像素 hinting、0.5px 细线发灰）。本页把
 * 字体档位 × 字重 × 字号、行高和细线样本放在一起，供真机截图比对。
 *
 * 用法：
 *   /dev-preview/typography          当前主题/平台
 *   /dev-preview/typography?platform=windows  （只影响窗口三键判定，不影响字体）
 *
 * Windows 检查清单：
 * 1. 每个档位下 500 与 600 是否有真实字面差异（Rendered Fonts 面板）；
 * 2. 9/10/11px 只用 Latin/等宽，中文最小 12px；
 * 3. 100%/125%/150% 缩放下行高是否为整数、细线是否发灰。
 */

import { useEffect, useState } from "react";
import { CODE_FONT_OPTIONS, UI_FONT_OPTIONS } from "@/lib/theme/fonts";

const WEIGHTS = [400, 500, 600, 700] as const;
const SIZES = [9, 10, 11, 12, 13, 15, 22] as const;

const SAMPLE = "中文 Aa 123";

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border flex flex-col gap-2 border-b pb-5">
      <div>
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function FamilyBlock({
  label,
  stack,
}: {
  label: string;
  stack: string;
}) {
  return (
    <div className="bg-muted/40 flex flex-col gap-2 rounded-xl p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-foreground text-sm font-semibold">{label}</span>
        <code className="text-muted-foreground font-mono text-[11px]">
          {stack}
        </code>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {WEIGHTS.map((weight) => (
          <span
            key={weight}
            style={{ fontFamily: stack, fontWeight: weight, fontSize: 15 }}
          >
            {SAMPLE} · {weight}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {SIZES.map((size) => (
          <span
            key={size}
            style={{ fontFamily: stack, fontSize: size, lineHeight: 1.35 }}
          >
            {SAMPLE}
            <span className="text-muted-foreground font-mono text-[9px]">
              {" "}
              {size}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function RuntimeFacts() {
  const [facts, setFacts] = useState<{
    dpr: number;
    hairline: string;
    rootSize: string;
    bodyFont: string;
  } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    setFacts({
      dpr: window.devicePixelRatio,
      hairline: styles.getPropertyValue("--hairline").trim() || "(未设置)",
      rootSize: styles.fontSize,
      bodyFont: getComputedStyle(document.body).fontFamily,
    });
  }, []);

  return (
    <div className="bg-muted/40 grid gap-1 rounded-xl p-3 font-mono text-[12px]">
      <span>devicePixelRatio: {facts?.dpr ?? "…"}</span>
      <span>--hairline: {facts?.hairline ?? "…"}</span>
      <span>root font-size: {facts?.rootSize ?? "…"}</span>
      <span className="break-all">body font-family: {facts?.bodyFont ?? "…"}</span>
    </div>
  );
}

export default function TypographyPreviewPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">字体验收</h1>
        <p className="text-muted-foreground text-sm">
          Windows 真机请分别用 100% / 125% / 150% 缩放各截一次图；重点看 500/600
          字重是否命中、9–11px 是否只剩 Latin、细线是否发灰。
        </p>
      </header>

      <Section title="运行时事实" note="确认 DPR、细线宽度与根字号">
        <RuntimeFacts />
      </Section>

      <Section
        title="UI 字体档位 × 字重 × 字号"
        note="每档第一行是 400/500/600/700；第二行是 9–22px。中文低于 12px 的样本仅用于观察渲染，不作为可接受用法。"
      >
        <div className="flex flex-col gap-3">
          {UI_FONT_OPTIONS.map((option) => (
            <FamilyBlock
              key={option.value}
              label={option.label}
              stack={option.value === "default" ? "var(--app-font-sans)" : option.stack}
            />
          ))}
        </div>
      </Section>

      <Section
        title="代码字体"
        note="代码字号下限已从 10px 提到 11px；12px 为标准档"
      >
        <div className="flex flex-col gap-3">
          {CODE_FONT_OPTIONS.map((option) => (
            <FamilyBlock
              key={option.value}
              label={option.label}
              stack={option.stack}
            />
          ))}
        </div>
      </Section>

      <Section
        title="小字号语义档"
        note="text-2xs = 12px/16px（中文下限）；text-3xs = 11px/16px（仅 Latin/等宽）"
      >
        <div className="flex flex-col gap-2">
          <p className="text-2xs">
            text-2xs：中文标签 12px/16px，Windows 100% 下仍应清晰
          </p>
          <p className="text-3xs font-mono">
            text-3xs: 11px/16px latin mono / 1234567890
          </p>
          <p className="text-[10px] font-mono">text-[10px]: legacy latin only</p>
        </div>
      </Section>

      <Section
        title="细线"
        note="border-b 走 --hairline：2x 屏 0.5px，1x/125%/150% 用 1px"
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-muted-foreground text-2xs">
              border-b（实际使用）
            </div>
            <div className="border-border mt-1 border-b" />
          </div>
          <div>
            <div className="text-muted-foreground text-2xs">
              1px 对照（h-px）
            </div>
            <div className="bg-border mt-1 h-px" />
          </div>
          <div>
            <div className="text-muted-foreground text-2xs">
              var(--hairline) 对照
            </div>
            <div className="bg-border mt-1" style={{ height: "var(--hairline)" }} />
          </div>
        </div>
      </Section>

      <Section
        title="正文行高"
        note="聊天正文已改为 15px / 24px 整数；对照 15px / 22.5px"
      >
        <div className="flex flex-col gap-3">
          <p className="text-ui-lg leading-6">
            整数行高：中文正文在 Windows 100% 与 125% 下都应保持均匀行距。The quick
            brown fox jumps over the lazy dog. 0123456789。
          </p>
          <p className="text-ui-lg leading-[22.5px]">
            小数行高对照：这一行刻意使用 22.5px，Windows 上可能出现逐行 22/23px
            的抖动。The quick brown fox jumps over the lazy dog. 0123456789。
          </p>
        </div>
      </Section>
    </div>
  );
}
