"use client";

import type { FC, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * 推荐卡片的插画。
 *
 * 不是线框占位图，也不是写实插画——走"浮起的内容卡片 + 软色团 + 少量装饰"：
 * 一张有厚度的小卡片（背后一层同形软影）托着可辨认的内容（带语法色的代码行、
 * 绿勾红叉的测试清单、带刻度的图表…），背后压一团分类色的柔光，角上点缀几颗
 * 星芒/圆点。近看是"这东西长什么样"，远看是一片有光的插画。
 *
 * 颜色三处来源：主题 token（fill-background / foreground / primary）、语法色
 * （sky/emerald/amber，带 dark: 变体）与各图自己的强调色——深浅色主题都成立。
 * 柔光用两圈同心低透明圆叠出来，不引入渐变，省掉 id 管理；useId 只为将来加
 * 渐变/裁剪时多个实例不打架。
 */

export type SuggestionArt =
  | "editor"
  | "diff"
  | "tests"
  | "bug"
  | "doc"
  | "mail"
  | "steps"
  | "sheet"
  | "slides"
  | "chart"
  | "api"
  | "ui"
  | "palette"
  | "plugin"
  | "idea";

type ArtProps = { uid: string };

/** 语法色：与编辑器主题同族，深色下换浅一档 */
const KEYWORD = "fill-sky-600/80 dark:fill-sky-400/70";
const STRING = "fill-emerald-600/75 dark:fill-emerald-400/70";
const NUMBER = "fill-amber-600/80 dark:fill-amber-400/70";

const Frame: FC<{ children: ReactNode }> = ({ children }) => (
  <svg
    viewBox="0 0 120 80"
    aria-hidden
    className="h-full w-full"
    fill="none"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

/** 柔光色团：同一圆心叠两圈低透明度，出来的是"打光"而不是硬边圆 */
const Glow: FC<{ cx: number; cy: number; r: number; className: string }> = ({
  cx,
  cy,
  r,
  className,
}) => (
  <>
    <circle cx={cx} cy={cy} r={r} className={className} fillOpacity={0.16} />
    <circle cx={cx} cy={cy} r={r * 0.66} className={className} fillOpacity={0.14} />
  </>
);

/** 托起内容的卡片：背后一层同形软影（偏移 2.5）+ 浮层正面 + 细描边 */
const Card: FC<{ x: number; y: number; w: number; h: number; r?: number }> = ({
  x,
  y,
  w,
  h,
  r = 6,
}) => (
  <>
    <rect x={x} y={y + 2.5} width={w} height={h} rx={r} className="fill-foreground" fillOpacity={0.08} />
    <rect x={x} y={y} width={w} height={h} rx={r} className="fill-background stroke-foreground" strokeOpacity={0.12} />
  </>
);

/** 星芒：四角星点缀 */
const Sparkle: FC<{ x: number; y: number; s?: number; className: string }> = ({
  x,
  y,
  s = 3,
  className,
}) => (
  <path
    d={`M${x} ${y - s}q0.55 ${s * 0.55} ${s} ${s}q-${s * 0.45} 0.45 -${s} ${s}q-0.55 -${s * 0.55} -${s} -${s}q${s * 0.45} -0.45 ${s} -${s}z`}
    className={className}
  />
);

/** 一行"内容"：圆角条 */
const Bar: FC<{ x: number; y: number; w: number; h?: number; className?: string }> = ({
  x,
  y,
  w,
  h = 5,
  className = "fill-foreground/25",
}) => <rect x={x} y={y} width={w} height={h} rx={h / 2} className={className} />;

/** 卡片顶部三个窗口点 */
const Dots: FC<{ x: number; y: number }> = ({ x, y }) => (
  <>
    <circle cx={x} cy={y} r="1.7" className="fill-destructive/45" />
    <circle cx={x + 5.5} cy={y} r="1.7" className="fill-amber-500/55" />
    <circle cx={x + 11} cy={y} r="1.7" className="fill-emerald-500/45" />
  </>
);

const ART: Record<SuggestionArt, FC<ArtProps>> = {
  // 代码：关键字 / 字符串 / 数字各一色
  editor: () => (
    <Frame>
      <Glow cx={78} cy={30} r={30} className="fill-sky-500" />
      <Card x={16} y={10} w={88} h={58} />
      <Dots x={23} y={17} />
      <path d="M16 22h88" className="stroke-foreground" strokeOpacity="0.09" />
      <Bar x={24} y={29} w={13} className={KEYWORD} />
      <Bar x={40} y={29} w={22} className="fill-foreground/30" />
      <Bar x={30} y={38} w={9} className={NUMBER} />
      <Bar x={42} y={38} w={26} className={STRING} />
      <Bar x={30} y={47} w={20} className="fill-foreground/22" />
      <Bar x={30} y={56} w={32} className={KEYWORD} />
      <Bar x={66} y={29} w={28} className="fill-foreground/10" />
      <Bar x={66} y={38} w={18} className="fill-foreground/10" />
      <Sparkle x={106} y={16} s={4} className="fill-sky-500/70" />
      <circle cx={12} cy={62} r="2.5" className="fill-sky-500/45" />
      <path d="M10 74q6-2 12 0" className="stroke-sky-500/40" strokeWidth="1.6" />
    </Frame>
  ),
  // 改动审查：+ 绿 / − 红
  diff: () => (
    <Frame>
      <Glow cx={34} cy={58} r={28} className="fill-emerald-500" />
      <Card x={16} y={10} w={88} h={58} />
      <Dots x={23} y={17} />
      <path d="M16 22h88" className="stroke-foreground" strokeOpacity="0.09" />
      <rect x="23" y="28" width="74" height="10" rx="3" className="fill-emerald-500/12" />
      <path d="M27 33h5M29.5 30.5v5" className="stroke-emerald-600/80 dark:stroke-emerald-400/70" strokeWidth="1.8" />
      <Bar x={37} y={31} w={40} className="fill-foreground/35" />
      <rect x="23" y="41" width="74" height="10" rx="3" className="fill-destructive/10" />
      <path d="M27 46h5" className="stroke-destructive/70" strokeWidth="1.8" />
      <Bar x={37} y={44} w={26} className="fill-foreground/25" />
      <rect x="23" y="54" width="74" height="10" rx="3" className="fill-emerald-500/12" />
      <path d="M27 59h5M29.5 56.5v5" className="stroke-emerald-600/80 dark:stroke-emerald-400/70" strokeWidth="1.8" />
      <Bar x={37} y={57} w={48} className="fill-foreground/35" />
      <Sparkle x={106} y={62} s={4} className="fill-emerald-500/70" />
    </Frame>
  ),
  // 测试：绿勾 + 红叉 + 覆盖率环
  tests: () => (
    <Frame>
      <Glow cx={24} cy={24} r={26} className="fill-emerald-500" />
      <Card x={16} y={10} w={88} h={58} />
      <Dots x={23} y={17} />
      <path d="M16 22h88" className="stroke-foreground" strokeOpacity="0.09" />
      <path d="M24 32l3.5 3.5L34 29" className="stroke-emerald-600/80 dark:stroke-emerald-400/70" strokeWidth="2.2" />
      <Bar x={40} y={30} w={26} className="fill-foreground/30" />
      <path d="M24 44l3.5 3.5L34 41" className="stroke-emerald-600/80 dark:stroke-emerald-400/70" strokeWidth="2.2" />
      <Bar x={40} y={42} w={20} className="fill-foreground/30" />
      <path d="M25.5 54l6 6M31.5 54l-6 6" className="stroke-destructive/70" strokeWidth="2.2" />
      <Bar x={40} y={57} w={22} className="fill-foreground/20" />
      <rect x="76" y="34" width="26" height="26" rx="13" className="fill-primary/10" />
      <circle cx="89" cy="47" r="13" className="stroke-foreground" strokeOpacity="0.16" />
      <path d="M89 34a13 13 0 0 1 11 19.5" className="stroke-primary" strokeOpacity="0.85" strokeWidth="2.4" />
      <Sparkle x={12} y={54} s={4} className="fill-primary/50" />
    </Frame>
  ),
  // 报错：首行红底 + 堆栈 + 警示
  bug: () => (
    <Frame>
      <Glow cx={86} cy={28} r={26} className="fill-destructive" />
      <Card x={16} y={10} w={88} h={58} />
      <Dots x={23} y={17} />
      <path d="M16 22h88" className="stroke-foreground" strokeOpacity="0.09" />
      <rect x="23" y="28" width="74" height="12" rx="3" className="fill-destructive/15" />
      <Bar x={28} y={32} w={46} className="fill-destructive/70" />
      <Bar x={34} y={48} w={36} className="fill-foreground/25" />
      <Bar x={38} y={56} w={42} className="fill-foreground/20" />
      <Bar x={76} y={48} w={16} className={NUMBER} />
      <circle cx="99" cy="60" r="6" className="fill-destructive/10" />
      <path d="M99 57v4M99 63.4v.2" className="stroke-destructive/80" strokeWidth="1.8" />
      <Sparkle x={10} y={30} s={4} className="fill-destructive/60" />
    </Frame>
  ),
  // 文档：标题主色 + 正文层次 + 签名块
  doc: () => (
    <Frame>
      <Glow cx={88} cy={54} r={28} className="fill-sky-500" />
      <Card x={24} y={8} w={70} h={64} />
      <Bar x={32} y={20} w={32} h={6} className="fill-sky-600/70 dark:fill-sky-400/60" />
      <Bar x={32} y={32} w={54} className="fill-foreground/22" />
      <Bar x={32} y={40} w={46} className="fill-foreground/22" />
      <Bar x={32} y={48} w={38} className="fill-primary/40" />
      <Bar x={32} y={56} w={50} className="fill-foreground/22" />
      <rect x="70" y="61" width="16" height="7" rx="3" className="fill-primary/70" />
      <Sparkle x={14} y={18} s={4} className="fill-sky-500/70" />
      <circle cx={106} cy={26} r="2.5" className="fill-sky-500/45" />
    </Frame>
  ),
  // 邮件：信封折线 + 主题行 + 附件
  mail: () => (
    <Frame>
      <Glow cx={26} cy={26} r={26} className="fill-teal-500" />
      <Card x={14} y={16} w={92} h={48} />
      <path d="M18 22l42 24 42-24" className="stroke-foreground" strokeOpacity="0.16" />
      <Bar x={22} y={26} w={28} h={6} className="fill-teal-600/70 dark:fill-teal-400/60" />
      <Bar x={22} y={40} w={44} className="fill-foreground/25" />
      <Bar x={22} y={48} w={34} className="fill-foreground/20" />
      <rect x="22" y="56" width="20" height="6" rx="3" className="fill-foreground/15" />
      <Sparkle x={104} y={16} s={4} className="fill-teal-500/70" />
      <Sparkle x={16} y={70} s={3} className="fill-teal-500/50" />
    </Frame>
  ),
  // 流程：三步各一色 + 箭头
  steps: () => (
    <Frame>
      <Glow cx={62} cy={40} r={32} className="fill-violet-500" />
      <rect x="14" y="12" width="30" height="18" rx="5" className="fill-sky-500/60 dark:fill-sky-400/50" />
      <rect x="45" y="30" width="30" height="18" rx="5" className="fill-violet-500/55 dark:fill-violet-400/45" />
      <rect x="76" y="48" width="30" height="18" rx="5" className="fill-emerald-500/55 dark:fill-emerald-400/45" />
      <path d="M44 21h9a4 4 0 0 1 4 4v3M75 39h9a4 4 0 0 1 4 4v3" className="stroke-foreground" strokeOpacity="0.22" strokeWidth="1.8" />
      <Bar x={20} y={19} w={18} className="fill-white/70" />
      <Bar x={51} y={37} w={18} className="fill-white/60 dark:fill-white/45" />
      <Bar x={82} y={55} w={18} className="fill-white/60 dark:fill-white/45" />
      <Sparkle x={112} y={22} s={4} className="fill-violet-500/70" />
      <circle cx={8} cy={44} r="2.5" className="fill-sky-500/45" />
    </Frame>
  ),
  // 表格：主色表头 + 琥珀数值 + 高亮格
  sheet: () => (
    <Frame>
      <Glow cx={90} cy={26} r={28} className="fill-indigo-500" />
      <Card x={12} y={14} w={96} h={52} />
      <rect x="14" y="16" width="92" height="11" rx="4" className="fill-indigo-500/45" />
      <path d="M46 27v39M78 27v39M14 38h92M14 50h92" className="stroke-foreground" strokeOpacity="0.12" />
      <Bar x={20} y={20} w={16} h={4} className="fill-white/75" />
      <Bar x={52} y={20} w={16} h={4} className="fill-white/75" />
      <Bar x={84} y={20} w={16} h={4} className="fill-white/75" />
      <Bar x={20} y={31} w={12} className="fill-foreground/25" />
      <Bar x={52} y={31} w={16} className={NUMBER} />
      <Bar x={52} y={43} w={20} className={NUMBER} />
      <rect x="80" y="41" width="22" height="8" rx="3" className="fill-indigo-500/25" />
      <Bar x={20} y={55} w={12} className="fill-foreground/20" />
      <Sparkle x={10} y={10} s={4} className="fill-indigo-500/70" />
    </Frame>
  ),
  // 幻灯片：主画面 + 叠影 + 页码
  slides: () => (
    <Frame>
      <Glow cx={40} cy={34} r={30} className="fill-rose-500" />
      <rect x="34" y="12" width="62" height="40" rx="5" className="stroke-foreground" strokeOpacity="0.16" transform="rotate(5 65 32)" />
      <Card x={26} y={14} w={68} h={42} />
      <Bar x={34} y={26} w={34} h={6} className="fill-rose-600/70 dark:fill-rose-400/60" />
      <Bar x={34} y={38} w={42} className="fill-foreground/20" />
      <Bar x={34} y={46} w={28} className="fill-foreground/14" />
      <rect x="52" y="64" width="16" height="3" rx="1.5" className="fill-foreground/22" />
      <rect x="44" y="70" width="32" height="3" rx="1.5" className="fill-foreground/12" />
      <Sparkle x={106} y={62} s={4} className="fill-rose-500/70" />
    </Frame>
  ),
  // 分析：刻度 + 柱 + 趋势线 + 高亮值
  chart: () => (
    <Frame>
      <Glow cx={78} cy={30} r={30} className="fill-indigo-500" />
      <Card x={14} y={10} w={92} h={60} />
      <path d="M26 18v44h74" className="stroke-foreground" strokeOpacity="0.22" />
      <path d="M26 30h74M26 44h74" className="stroke-foreground" strokeOpacity="0.08" />
      <rect x="34" y="44" width="11" height="18" rx="3" className="fill-foreground/16" />
      <rect x="51" y="36" width="11" height="26" rx="3" className="fill-foreground/22" />
      <rect x="68" y="26" width="11" height="36" rx="3" className="fill-indigo-500/75" />
      <rect x="85" y="40" width="11" height="22" rx="3" className="fill-foreground/16" />
      <path d="M34 39l17-7 17-9 17 6 11-9" className="stroke-foreground" strokeOpacity="0.35" strokeWidth="2" strokeDasharray="1 5" />
      <Bar x={62} y={20} w={20} h={4} className="fill-indigo-500/70" />
      <Sparkle x={110} y={16} s={4} className="fill-indigo-500/70" />
    </Frame>
  ),
  // 接口：请求 / 响应两栏 + 双向箭头
  api: () => (
    <Frame>
      <Glow cx={60} cy={40} r={30} className="fill-sky-500" />
      <Card x={10} y={22} w={40} h={34} />
      <Bar x={16} y={32} w={14} className={KEYWORD} />
      <Bar x={16} y={40} w={24} className="fill-foreground/25" />
      <Bar x={16} y={48} w={18} className="fill-foreground/18" />
      <rect x="70" y="22" width="40" height="34" rx="5" className="fill-sky-500/12 stroke-sky-600/40 dark:stroke-sky-400/40" />
      <Bar x={76} y={32} w={16} className="fill-sky-600/60 dark:fill-sky-400/60" />
      <Bar x={76} y={40} w={24} className="fill-foreground/25" />
      <Bar x={76} y={48} w={12} className={STRING} />
      <path d="M52 32h14M62 28l4 4-4 4" className="stroke-sky-600/60 dark:stroke-sky-400/60" strokeWidth="1.8" />
      <path d="M66 48H52M56 44l-4 4 4 4" className="stroke-foreground" strokeOpacity="0.22" strokeWidth="1.8" />
      <Sparkle x={112} y={62} s={4} className="fill-sky-500/70" />
      <circle cx={8} cy={14} r="2.5" className="fill-sky-500/45" />
    </Frame>
  ),
  // 界面稿：侧栏 + 主区 + 主色按钮
  ui: () => (
    <Frame>
      <Glow cx={84} cy={56} r={30} className="fill-violet-500" />
      <Card x={12} y={10} w={96} h={58} />
      <Dots x={19} y={17} />
      <path d="M12 22h96" className="stroke-foreground" strokeOpacity="0.09" />
      <rect x="18" y="27" width="20" height="36" rx="4" className="fill-violet-500/12" />
      <Bar x={22} y={33} w={11} h={4} className="fill-violet-600/50 dark:fill-violet-400/50" />
      <Bar x={22} y={41} w={9} h={4} className="fill-foreground/16" />
      <Bar x={22} y={49} w={11} h={4} className="fill-foreground/16" />
      <rect x="44" y="27" width="58" height="36" rx="5" className="fill-foreground/5" />
      <Bar x={50} y={34} w={26} h={6} className="fill-foreground/45" />
      <Bar x={50} y={45} w={40} className="fill-foreground/16" />
      <rect x="50" y="52" width="22" height="8" rx="4" className="fill-violet-500/75" />
      <rect x="80" y="34" width="16" height="9" rx="3" className="fill-violet-500/25" />
      <Sparkle x={112} y={16} s={4} className="fill-violet-500/70" />
    </Frame>
  ),
  // 配色：三色板 + 命名条
  palette: () => (
    <Frame>
      <Glow cx={60} cy={40} r={32} className="fill-violet-500" />
      <rect x="14" y="14" width="28" height="44" rx="7" className="fill-sky-500/80 dark:fill-sky-400/70" />
      <rect x="46" y="14" width="28" height="44" rx="7" className="fill-violet-500/70 dark:fill-violet-400/60" />
      <rect x="78" y="14" width="28" height="44" rx="7" className="fill-amber-400/85 dark:fill-amber-300/70" />
      <Bar x={18} y={63} w={20} h={4} className="fill-foreground/22" />
      <Bar x={50} y={63} w={20} h={4} className="fill-foreground/22" />
      <Bar x={82} y={63} w={20} h={4} className="fill-foreground/22" />
      <Sparkle x={110} y={10} s={5} className="fill-violet-500/70" />
      <Sparkle x={10} y={66} s={4} className="fill-amber-500/60" />
    </Frame>
  ),
  // 插件：主色已装 + 虚线待插
  plugin: () => (
    <Frame>
      <Glow cx={40} cy={36} r={30} className="fill-emerald-500" />
      <rect x="18" y="16" width="36" height="36" rx="9" className="fill-emerald-500/55 stroke-emerald-600/60 dark:stroke-emerald-400/60" />
      <path d="M36 16v-6a4 4 0 0 1 8 0v6" className="stroke-emerald-600/60 dark:stroke-emerald-400/60" strokeWidth="2" />
      <rect x="66" y="16" width="36" height="36" rx="9" className="stroke-foreground" strokeOpacity="0.22" strokeDasharray="4 4" />
      <path d="M84 34h-6a4 4 0 0 1 0-8h6" className="stroke-foreground" strokeOpacity="0.22" strokeWidth="2" />
      <Bar x={26} y={62} w={68} className="fill-foreground/12" />
      <Sparkle x={110} y={58} s={5} className="fill-emerald-500/70" />
      <circle cx={10} cy={20} r="2.5" className="fill-emerald-500/45" />
    </Frame>
  ),
  // 灵感：琥珀灯泡 + 光点
  idea: () => (
    <Frame>
      <Glow cx={60} cy={38} r={32} className="fill-amber-400" />
      <path
        d="M60 14c-12 0-20 8-20 19 0 7 4 10 6 13 1.5 2.5 2 4.5 2 6.5h24c0-2 .5-4 2-6.5 2-3 6-6 6-13 0-11-8-19-20-19z"
        className="fill-amber-400/30 stroke-amber-500/70 dark:stroke-amber-400/70"
        strokeWidth="1.6"
      />
      <path d="M52 60h16M54 66h12" className="stroke-foreground" strokeOpacity="0.28" strokeWidth="2.4" />
      <path d="M60 28v10M56 33h8" className="stroke-amber-500/80 dark:stroke-amber-400/80" strokeWidth="1.8" />
      <path d="M96 16v-6M104 24h6M24 18h-6M34 10l4-4" className="stroke-amber-500/50 dark:stroke-amber-400/50" strokeWidth="1.8" />
      <Sparkle x={100} y={58} s={5} className="fill-amber-500/70" />
      <Sparkle x={18} y={64} s={4} className="fill-amber-500/60" />
    </Frame>
  ),
};

/** 推荐卡片的插画；未知值回落到 idea，避免漏标时开天窗 */
export const SuggestionArtwork: FC<{
  kind: SuggestionArt;
  className?: string;
}> = ({ kind, className }) => {
  // 每张图一个实例 id：将来若给图里加渐变/裁剪，多个实例同 id 会在 DOM 里打架
  const uid = useId();
  const Art = ART[kind] ?? ART.idea;
  return (
    <div
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-lg",
        className,
      )}
    >
      <Art uid={uid} />
    </div>
  );
};
