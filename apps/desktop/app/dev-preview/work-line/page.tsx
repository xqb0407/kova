"use client";

/**
 * 【视觉预览页】轮次摘要行（「工作中 25 秒」）下方的分隔线：
 *  - 1px 细线（与结束态同重），运行中叠一道 indeterminate 扫光；
 *  - 步骤数先不展示（开关保留，方便以后回头评估）。
 *
 * 方案已落到正式组件（turn-summary.tsx 的 TurnRule + globals.css 的
 * .aui-turn-rule-*）。本页保留用于对比四种动效、粗细和深浅色；样式用页面内
 * <style> 独立维护，避免预览档位污染正式样式。
 */

import { ChevronDownIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

type Variant = "sweep" | "brand" | "pulse" | "static";
type StepPlacement = "inline" | "end" | "off";

const VARIANTS: { key: Variant; label: string; hint: string }[] = [
  { key: "sweep", label: "单色扫光", hint: "foreground 60%，2s 一趟" },
  { key: "brand", label: "蓝色扫光", hint: "focus-ring #6B97FF" },
  { key: "pulse", label: "呼吸", hint: "整条明暗呼吸，无位移" },
  { key: "static", label: "静止", hint: "静态线，不动" },
];

const STEPS_RULE = "工具调用 + 思考块（parseTurnSummary 的 collapsedCount）";

const PAGE_CSS = `
@keyframes workline-travel {
  0%   { transform: translateX(-115%); }
  100% { transform: translateX(340%); }
}
@keyframes workline-breathe {
  0%, 100% { opacity: 0.16; }
  50%      { opacity: 0.55; }
}
/* 轨道与结束态同重（border + 60%），线本身不靠"加粗"表示运行：
   动的是扫光。 */
.workline-track-fill {
  position: absolute;
  inset: 0;
  background: var(--border);
  opacity: 0.6;
}
/* 扫光两端都渐隐，靠渐变自身淡出，不用 mask：mask + 动画层在 Windows
   高 DPI 下容易把细线画虚（本仓库 shimmer 已踩过 mask 的坑）。 */
.workline-comet {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 30%;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    currentColor 18%,
    currentColor 82%,
    transparent 100%
  );
  color: var(--foreground);
  opacity: 0.6;
  animation: workline-travel 2s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
  will-change: transform;
}
.workline-comet-brand {
  color: var(--focus-ring, #6b97ff);
  opacity: 0.85;
}
/* 结束态静态线：与正式组件 .aui-turn-rule-static 同款 */
.workline-static {
  background: var(--border);
  opacity: 0.6;
}
.workline-pulse {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  background: var(--foreground);
  animation: workline-breathe 1.6s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  /* 减弱动效：不扫光，只留静态轨道（与结束态同款） */
  .workline-comet { display: none; }
  .workline-pulse { animation: none; opacity: 0.32; }
}
/* Windows 高对比度模式：作者色会被系统覆盖，这里显式退回系统色 */
@media (forced-colors: active) {
  .workline-static,
  .workline-track-fill { background: CanvasText; opacity: 0.45; }
  .workline-comet { background-image: none; background-color: Highlight; opacity: 1; }
  .workline-pulse { background: CanvasText; opacity: 1; }
}
`;

/** 中文时长（与 turn-summary.tsx 的 formatDuration 一致） */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

function OptionButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-foreground/25 bg-foreground/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/20",
      )}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium">{label}</span>
        {hint ? (
          <span className="text-muted-foreground text-[11px]">{hint}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** 行内文案：运行中「工作中 X 秒」，结束后「已工作 X 秒」；首秒只留「工作中」 */
function WorkLabel({
  running,
  elapsedMs,
  steps,
  placement,
}: {
  running: boolean;
  elapsedMs: number;
  steps: number;
  placement: StepPlacement;
}) {
  const showTime = elapsedMs >= 1000;
  return (
    <span className="tabular-nums">
      {running ? (
        showTime ? (
          <>
            <span className="shimmer">工作中</span>
            {` ${formatDuration(elapsedMs)}`}
          </>
        ) : (
          <span className="shimmer">工作中</span>
        )
      ) : (
        `已工作 ${formatDuration(elapsedMs)}`
      )}
      {placement === "inline" && steps > 0 ? (
        <>
          <span className="mx-1.5 opacity-40">·</span>
          <span>{steps} 步</span>
        </>
      ) : null}
    </span>
  );
}

/** 摘要行下方的线：运行中按选定方案动，结束后固定 1px 静态 */
function WorkLine({
  variant,
  thicknessPx,
}: {
  variant: Variant;
  thicknessPx: number;
}) {
  return (
    <div
      aria-hidden
      className="absolute inset-x-0 bottom-0"
      style={{ height: thicknessPx }}
    >
      <div className="workline-track-fill" />
      {variant === "static" ? null : (
        // overflow-hidden 只是把扫光裁在线段内，不是 mask：Windows 高 DPI 下
        // mask 会把 2px 细线合成到独立图层，容易发虚
        <div className="absolute inset-0 overflow-hidden rounded-full">
          {variant === "pulse" ? (
            <span className="workline-pulse" />
          ) : (
            <span
              className={cn(
                "workline-comet",
                variant === "brand" && "workline-comet-brand",
              )}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 与生产同构的一行摘要：相对定位容器 + 绝对定位的底线；
 * -mt-3 / pb-3 / gap-1.5 / text-sm / chevron size-3.5 全部照抄 turn-summary。
 */
function SummaryRow({
  running,
  elapsedMs,
  steps,
  variant,
  thicknessPx,
  placement,
  bare = false,
}: {
  running: boolean;
  elapsedMs: number;
  steps: number;
  variant: Variant;
  thicknessPx: number;
  placement: StepPlacement;
  /** 独立陈列时去掉 -mt-3（它原本用来抵消消息组的 gap-y-6） */
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative mx-auto w-full max-w-(--thread-max-width) px-2 pb-3",
        !bare && "-mt-3",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground group/turn-summary flex w-fit cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-sm transition-colors"
        >
          <WorkLabel
            running={running}
            elapsedMs={elapsedMs}
            steps={steps}
            placement={placement}
          />
          <ChevronDownIcon
            className="size-3.5 shrink-0 -rotate-90"
            aria-hidden
          />
        </button>
        {placement === "end" && steps > 0 ? (
          <span className="text-muted-foreground/70 text-xs tabular-nums">
            {steps} 步
          </span>
        ) : null}
      </div>
      {running ? (
        <WorkLine variant={variant} thicknessPx={thicknessPx} />
      ) : (
        // 结束态与正式组件一致：1px、border 60%
        <div
          aria-hidden
          className="workline-static absolute inset-x-0 bottom-0 h-px"
        />
      )}
    </div>
  );
}

export default function WorkLinePreviewPage() {
  const [running, setRunning] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(25_000);
  const [steps, setSteps] = useState(8);
  const [variant, setVariant] = useState<Variant>("sweep");
  const [thicknessPx, setThicknessPx] = useState(1);
  const [placement, setPlacement] = useState<StepPlacement>("off");
  const [dark, setDark] = useState(false);

  // 模拟一轮真在跑：每秒走表，每 3 秒来一步（真实实现直接用现成数据）
  const tickRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      tickRef.current += 1;
      setElapsedMs((ms) => ms + 1000);
      if (tickRef.current % 3 === 0) setSteps((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const reset = () => {
    tickRef.current = 0;
    setElapsedMs(0);
    setSteps(0);
    setRunning(true);
  };

  return (
    <div
      className={cn("min-h-screen bg-background text-foreground", dark && "dark")}
      // 深色只切在预览容器上：应用启动脚本会把浅色主题变量以 inline style
      // 写在 <html> 上，直接 toggle html 的 .dark 会被那层 inline 变量压住。
      style={{ ["--thread-max-width" as string]: "60rem" }}
    >
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <div className="mx-auto flex max-w-[68rem] flex-col gap-8 px-6 py-8">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold">
            轮次摘要行 · 运行态线条试验
          </h1>
          <p className="text-muted-foreground text-sm">
            dev-preview 专用：正式组件
            <code className="bg-muted mx-1 rounded px-1 py-0.5 text-[12px]">
              turn-summary.tsx
            </code>
            已按此方案落地，步骤数暂不展示。本页保留用于对比与回退。
          </p>
        </header>

        <section className="border-border bg-card/40 flex flex-col gap-4 rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRunning((v) => !v)}
              className="border-foreground/20 bg-foreground text-background rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              {running ? "暂停（看结束态）" : "继续运行"}
            </button>
            <button
              type="button"
              onClick={reset}
              className="border-border text-muted-foreground hover:text-foreground rounded-md border px-3 py-1.5 text-xs"
            >
              重置（从 0 秒开始）
            </button>
            <OptionButton active={dark} onClick={() => setDark((v) => !v)}>
              {dark ? "浅色预览" : "深色预览"}
            </OptionButton>
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              当前 {formatDuration(elapsedMs)} · {steps} 步
            </span>
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-4">
            <Field label="线条动效">
              {VARIANTS.map((v) => (
                <OptionButton
                  key={v.key}
                  active={variant === v.key}
                  onClick={() => setVariant(v.key)}
                >
                  {v.label}
                </OptionButton>
              ))}
            </Field>
            <Field label="运行中粗细">
              {[1, 1.5, 2].map((px) => (
                <OptionButton
                  key={px}
                  active={thicknessPx === px}
                  onClick={() => setThicknessPx(px)}
                >
                  {px}px
                </OptionButton>
              ))}
            </Field>
            <Field label="步骤计数">
              <OptionButton
                active={placement === "inline"}
                onClick={() => setPlacement("inline")}
              >
                行内 · 8 步
              </OptionButton>
              <OptionButton
                active={placement === "end"}
                onClick={() => setPlacement("end")}
              >
                行尾右对齐
              </OptionButton>
              <OptionButton
                active={placement === "off"}
                onClick={() => setPlacement("off")}
              >
                不显示
              </OptionButton>
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">放进消息流里</h2>
          <div className="border-border/60 flex flex-col gap-y-6 rounded-xl border p-6">
            <div className="flex justify-end">
              <div className="bg-muted max-w-[80%] rounded-2xl px-4 py-2 text-sm">
                帮我重构这个函数，顺便把测试补上
              </div>
            </div>
            <SummaryRow
              running={running}
              elapsedMs={elapsedMs}
              steps={steps}
              variant={variant}
              thicknessPx={thicknessPx}
              placement={placement}
            />
            <div className="text-sm leading-6">
              我用的是流式输出，这一行现在挂着「工作中 25 秒」。等这轮结束，它会变成
              「已工作 …」，下面的过程区随时可以点开。
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">四种动效并排（都在运行中）</h2>
          <div className="border-border divide-border divide-y rounded-xl border">
            {VARIANTS.map((v) => (
              <div
                key={v.key}
                className="grid grid-cols-[9rem_minmax(0,1fr)] items-center gap-4 py-2 pr-4 pl-4"
              >
                <div className="flex flex-col gap-0.5 py-2">
                  <span className="text-xs font-medium">{v.label}</span>
                  <span className="text-muted-foreground text-[11px] leading-4">
                    {v.hint}
                  </span>
                </div>
                <SummaryRow
                  bare
                  running
                  elapsedMs={elapsedMs}
                  steps={steps}
                  variant={v.key}
                  thicknessPx={thicknessPx}
                  placement={placement}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">结束态</h2>
          <div className="border-border/60 flex flex-col gap-y-6 rounded-xl border p-6">
            <SummaryRow
              running={false}
              elapsedMs={248_000}
              steps={12}
              variant={variant}
              thicknessPx={thicknessPx}
              placement={placement}
            />
            <div className="text-sm leading-6">
              这轮结束后：线退回 1px 静态，文案变「已工作 4 分 8 秒」。
            </div>
          </div>
        </section>

        <section className="border-border text-muted-foreground flex flex-col gap-2 rounded-xl border border-dashed p-4 text-xs leading-5">
          <p>
            步骤统计（本轮不采用）：口径可以是
            <code className="bg-muted mx-1 rounded px-1 py-0.5 text-[11px]">
              {STEPS_RULE}
            </code>
            ，数据现成；需要时再把开关打开。
          </p>
          <p>
            正式组件已落地：turn-summary.tsx 的两处行容器把
            <code className="bg-muted mx-1 rounded px-1 py-0.5 text-[11px]">
              border-b
            </code>
            换成绝对定位的 <code className="bg-muted rounded px-1 py-0.5 text-[11px]">TurnRule</code>
            （运行 1px + 扫光，结束同重静态线），keyframes 在 globals.css 的
            <code className="bg-muted mx-1 rounded px-1 py-0.5 text-[11px]">
              .aui-turn-rule-*
            </code>
            。行为、间距、折叠开关都不变。
          </p>
          <p>
            Windows 适配：动效只用 background + transform，不用 mask / filter /
            backdrop-filter（2px 细线进合成层在高 DPI 下容易发虚）；颜色不用
            color-mix(var())，避免构建期被展平；已补
            <code className="bg-muted mx-1 rounded px-1 py-0.5 text-[11px]">
              forced-colors
            </code>
            （Windows 高对比度）与 reduced-motion 回退。
          </p>
        </section>
      </div>
    </div>
  );
}
