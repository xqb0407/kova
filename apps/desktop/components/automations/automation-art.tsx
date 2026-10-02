/**
 * 自动化页的插画集：纯内联 SVG，不引任何外部资源。
 *
 * 画法走"实心几何 + 分层透明"，不是线描。
 * 前两版都不对：第一版是 56 视口的单物件小图（主体居中、无环境），放大后只是
 * 大号图标；第二版加了山丘飞鸟，但仍是 2.4 细描边 + 虚线 + 波浪线，眼睛读到的
 * 是"手绘简笔"，不是设计过的图形 —— 那套语汇跟苹果那种质感正好相反。
 *
 * 现在这套只有四条规矩：
 *   1. 分层造纵深，不靠描边：同一色相压四档不透明度 —— 底衬 .06 / 衬形 .16 /
 *      主体 .85 / 点睛 1.0。前后关系全部由不透明度台阶说，明度就是深度。
 *   2. 形只出圆、圆角矩形、胶囊、圆弧四种，全部实心。没有三角形、没有自由曲线、
 *      没有虚线、没有波浪线、没有描边小装饰 —— 那些都是"简笔画"的信号。
 *   3. 需要一条线时（心电波），用大圆头粗描边当实心带来画，不用细线。
 *   4. 尺寸拉开档次：一帧里只有一个主体，别的都得明显更小或更淡。
 *
 * 图元只吃 currentColor，色相由外层 text-* 决定，深浅主题与强调色主题自动跟随，
 * 不维护两套资产。
 */

import type { FC, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ArtProps = { className?: string };

/** 不透明度四档：写死成常量而不是散在 JSX 里，是为了让"同一个台阶"
 *  在七张图里始终是同一个值 —— 台阶一乱，分层就不是一套语言了 */
const BACKDROP = 0.06;
const PLATE = 0.16;
const SUBJECT = 0.85;
const ACCENT = 1;

const Art: FC<ArtProps & { viewBox: string; children: ReactNode }> = ({
  className,
  viewBox,
  children,
}) => (
  <svg
    viewBox={viewBox}
    fill="none"
    aria-hidden="true"
    className={cn("block", className)}
  >
    {children}
  </svg>
);

/** 场景底：整幅最淡的一档，先把"纸"垫上，主体才不会浮在空白里 */
const Wash: FC<{ w: number; h: number }> = ({ w, h }) => (
  <rect width={w} height={h} fill="currentColor" fillOpacity={BACKDROP} />
);

/* ────────────────────────── 模板头图（320×100 通栏） ────────────────────────── */

/** 每日晨报：太阳从地平线升起。地平线是两条不同落点的胶囊带（近的低、远的
 *  高的），太阳是压在地平线上的实心半圆 —— 三块色阶就把"清晨 + 山谷"说完，
 *  没有一条描边。右侧那张便签是今天的清单 */
export const DailyBriefingArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 100" className={className}>
    <Wash w={320} h={100} />

    {/* 云：两枚胶囊，不讲形状只讲体积。
        这里原来还有一圈"天光"淡圆，但它没有模糊、边缘是硬的，读出来是一个
        多余的圆圈而不是光晕 —— 没有高斯模糊就别画光晕，直接去掉 */}
    <rect x={44} y={22} width={46} height={12} rx={6} fill="currentColor" fillOpacity={PLATE} />
    <rect x={70} y={42} width={30} height={10} rx={5} fill="currentColor" fillOpacity={0.11} />

    {/* 远山 / 近山 */}
    <rect x={-30} y={70} width={240} height={46} rx={23} fill="currentColor" fillOpacity={0.15} />
    <rect x={140} y={64} width={240} height={52} rx={26} fill="currentColor" fillOpacity={0.28} />

    {/* 太阳：半圆压在地平线上，全帧唯一的实心主体 */}
    <path d="M100 70a26 26 0 0 1 52 0Z" fill="currentColor" fillOpacity={SUBJECT} />

    {/* 晨报便签：三条清单，末条留短 */}
    <rect x={228} y={14} width={58} height={46} rx={15} fill="currentColor" fillOpacity={PLATE} />
    <g fill="currentColor" fillOpacity={0.55}>
      <rect x={240} y={27} width={34} height={4.5} rx={2.25} />
      <rect x={240} y={39} width={34} height={4.5} rx={2.25} />
      <rect x={240} y={51} width={20} height={4.5} rx={2.25} />
    </g>
  </Art>
);

/** 每周周报草稿：一张稿纸，上半是七格周历（周五实心），下半是柱状图。
 *  两段共用同一张纸 —— 周格是"哪一周"，柱图是"这一周干了多少" */
export const WeeklyReportArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 100" className={className}>
    <Wash w={320} h={100} />

    {/* 稿纸 */}
    <rect x={54} y={8} width={212} height={88} rx={22} fill="currentColor" fillOpacity={0.1} />

    {/* 周历七格：第五格（周五）点亮 —— 模板跑在周五傍晚 */}
    {[78, 102, 126, 150, 174, 198, 222].map((x, i) => (
      <rect
        key={x}
        x={x}
        y={20}
        width={20}
        height={20}
        rx={6.5}
        fill="currentColor"
        fillOpacity={i === 4 ? SUBJECT : 0.2}
      />
    ))}

    {/* 柱状图：五根胶囊，最高那根是实心主体，其余退成衬形。
        最矮的一根也不能低到 2×rx —— 22×22 配 rx=11 就是个正圆，
        整排会忽然冒出一个圆点 */}
    <g fill="currentColor">
      <rect x={81} y={58} width={22} height={26} rx={11} fillOpacity={0.24} />
      <rect x={115} y={46} width={22} height={38} rx={11} fillOpacity={SUBJECT} />
      <rect x={149} y={60} width={22} height={24} rx={11} fillOpacity={0.24} />
      <rect x={183} y={54} width={22} height={30} rx={11} fillOpacity={0.24} />
      <rect x={217} y={57} width={22} height={27} rx={11} fillOpacity={0.24} />
    </g>
  </Art>
);

/** 仓库每日体检：一枚大盾衬在背后，心电波横穿整个画面。
 *  波用大圆头粗描边当实心带画（圆头圆角让折点不出现尖角），
 *  盾退成最淡的衬形 —— 一眼是"在跑体检"，不是"一个盾牌图标" */
export const RepoCheckArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 100" className={className}>
    <Wash w={320} h={100} />

    {/* 盾：整幅的衬形，只负责"体检"这个语义底。
        顶边做平并把两只上角收圆（盾是平顶圆肩收圆底）—— 尖顶会读成一块
        切开的多边形，直角顶会读成一个"下面带尖的矩形" */}
    <path
      d="M112 26h96a8 8 0 0 1 8 8v28c0 15-24 24-56 28-32-4-56-13-56-28V34a8 8 0 0 1 8-8Z"
      fill="currentColor"
      fillOpacity={PLATE}
    />

    {/* 心电波：一低一高两个峰，全帧唯一实心主体。
        尾端收在 278 而不是贴到 320 —— 收笔的点离边太近会被卡片圆角切掉 */}
    <path
      d="M32 54h64l16-28 16 54 14-34 12 8h124"
      stroke="currentColor"
      strokeWidth={7}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity={SUBJECT}
    />
    <circle cx={278} cy={54} r={7} fill="currentColor" fillOpacity={ACCENT} />
  </Art>
);

/** 定期信息巡检：左下角一个信号源向外播三道粗弧，右侧是被盯着的清单卡。
 *  弧用大圆头粗描边画成实心带，由近及远三档透明 —— 距离感就是透明度台阶 */
export const WatchScanArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 100" className={className}>
    <Wash w={320} h={100} />

    <g
      stroke="currentColor"
      strokeWidth={8}
      strokeLinecap="round"
      fill="none"
    >
      {/* 半径 34/53/72：最外那道原来给 82，端点落在 y=-4，圆头再往外 4px，
          会被 SVG 的 overflow:hidden 在上边缘切掉一截。三道等距 19 */}
      <path d="M114 78a34 34 0 0 0-34-34" strokeOpacity={SUBJECT} />
      <path d="M133 78a53 53 0 0 0-53-53" strokeOpacity={0.4} />
      <path d="M152 78a72 72 0 0 0-72-72" strokeOpacity={0.18} />
    </g>
    <circle cx={80} cy={78} r={12} fill="currentColor" fillOpacity={ACCENT} />

    {/* 被巡检的清单：三行，中间那行是新的 */}
    <rect x={212} y={18} width={84} height={64} rx={18} fill="currentColor" fillOpacity={0.1} />
    <g fill="currentColor">
      <circle cx={232} cy={36} r={4} fillOpacity={0.3} />
      <rect x={244} y={32.5} width={38} height={7} rx={3.5} fillOpacity={0.3} />
      <circle cx={232} cy={50} r={4} fillOpacity={SUBJECT} />
      <rect x={244} y={46.5} width={38} height={7} rx={3.5} fillOpacity={SUBJECT} />
      <circle cx={232} cy={64} r={4} fillOpacity={0.3} />
      <rect x={244} y={60.5} width={24} height={7} rx={3.5} fillOpacity={0.3} />
    </g>
  </Art>
);

/** 稍后提醒：夜里的一座钟。表盘是粗圆环 + 极淡的盘面，月亮和星点定下"稍后"
 *  的时间感。
 *  上面两只铃去掉了 —— 圆环 + 左右两个实心圆在正视角下读成两只耳朵，
 *  整张图会变成一张熊脸；去掉后是一枚干净的环，更接近设计图形而不是卡通 */
export const OneOffArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 100" className={className}>
    <Wash w={320} h={100} />

    {/* 月牙：外弧走左边长路、内弧短弧回程，缺口方向由此定 */}
    <path
      d="M62 16a18 18 0 1 0 0 36 34 34 0 0 1 0-36Z"
      fill="currentColor"
      fillOpacity={0.22}
    />
    <g fill="currentColor">
      <circle cx={232} cy={28} r={3.5} fillOpacity={0.3} />
      <circle cx={268} cy={48} r={2.5} fillOpacity={0.2} />
      <circle cx={44} cy={72} r={2.5} fillOpacity={0.18} />
    </g>

    <ellipse cx={160} cy={86} rx={46} ry={5} fill="currentColor" fillOpacity={0.1} />

    {/* 表盘：粗圆环 + 淡盘面，两档不透明度分出"壳"和"面" */}
    <circle cx={160} cy={50} r={34} fill="currentColor" fillOpacity={0.1} />
    <circle
      cx={160}
      cy={50}
      r={34}
      stroke="currentColor"
      strokeWidth={8}
      strokeOpacity={SUBJECT}
    />

    {/* 指针 + 轴心 */}
    <path
      d="M160 32v18l11 7"
      stroke="currentColor"
      strokeWidth={6}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity={SUBJECT}
    />
    <circle cx={160} cy={50} r={4} fill="currentColor" fillOpacity={ACCENT} />
  </Art>
);

/* ────────────────────────── 空态（320×200 / 320×120） ────────────────────────── */

/** 任务空态：两张同心柔圆托底，一条倾斜轨道绕着中央的任务卡。
 *  上一版是两条点线轨道 + 四个带图标的节点 —— 21px 的节点里塞一个文档/时钟，
 *  读出来是一团深灰脏点，整张图像技术示意图而不是插画；而且元素一多、
 *  每件又都小，画面就灰。
 *  现在按"一屏只讲一件事"收：轨道收成一条，节点去掉图标只留大小与明度，
 *  中央卡和表放大到整幅的主视觉。远近由直径和明度一起说，不用细节 */
export const AutomationEmptyArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 200" className={className}>
    {/* 底盘只给一层圆。两层同心圆叠在一起时，内层的外缘会显出一道可见的
        圆圈边（同 每日晨报 里去掉的那圈光晕）—— 没有模糊就别指望柔边 */}
    <circle cx={160} cy={100} r={92} fill="currentColor" fillOpacity={0.07} />

    {/* 轨道：一条实心细环，压扁并倾斜后才有俯视感。
        这里原先画成点列（短划 + 圆头），但行星是半透明的，轨道的小圆点从
        行星背面透出来，每颗行星正中就多一个深点，读成"瞳孔"——
        半透明叠半透明不会遮挡。换成实线后线不再打断行星，但线从行星身上
        穿过去仍然读不出前后，所以轨道环干脆断成三段弧：每颗行星处留一个
        略宽于自身的缺口，行星才真正"骑"在轨道上。
        椭圆参数 t 上的缺口按各处的弧长速度反推（t=0 与 180 处每度 0.91px，
        t=90 处每度 2.34px），半径大的行星配大缺口 */}
    <g transform="rotate(-14 160 100)">
      <path
        d="M285.1 118.64A134 52 0 0 1 171.68 151.8"
        stroke="currentColor"
        strokeWidth={4}
        strokeOpacity={0.15}
      />
      <path
        d="M148.32 151.8A134 52 0 0 1 32.55 116.07"
        stroke="currentColor"
        strokeWidth={4}
        strokeOpacity={0.15}
      />
      <path
        d="M32.55 83.93A134 52 0 0 1 285.1 81.36"
        stroke="currentColor"
        strokeWidth={4}
        strokeOpacity={0.15}
      />
      {/* 三颗行星：直径与明度一起递降，纵深就是这两条一起给的 */}
      <circle cx={294} cy={100} r={13} fill="currentColor" fillOpacity={0.8} />
      <circle cx={26} cy={100} r={10} fill="currentColor" fillOpacity={0.6} />
      <circle cx={160} cy={152} r={8} fill="currentColor" fillOpacity={0.45} />
    </g>

    {/* 中央那张卡：形状直接借用任务卡本身，插画与页面自指 */}
    <rect x={116} y={56} width={88} height={88} rx={28} fill="currentColor" fillOpacity={0.16} />
    <circle
      cx={160}
      cy={100}
      r={26}
      stroke="currentColor"
      strokeWidth={7}
      strokeOpacity={0.92}
    />
    <path
      d="M160 86v14l9.5 6"
      stroke="currentColor"
      strokeWidth={7}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeOpacity={0.92}
    />
  </Art>
);

/** 运行记录空态：一条时间轴，三个节点由深到浅、各挑一张记录卡。
 *  明度递降就是"记录越积越多"这件事。
 *  这里不铺整幅色块 —— 空态是漂在白底上的，一块硬边灰底会读成"多出来的
 *  一个方框"（第一版就是这样，很脏）；底只给轨道和节点 */
export const HistoryEmptyArt: FC<ArtProps> = ({ className }) => (
  <Art viewBox="0 0 320 120" className={className}>
    <rect x={30} y={63} width={260} height={6} rx={3} fill="currentColor" fillOpacity={0.16} />

    {[
      { cx: 76, card: 46, on: 1 },
      { cx: 160, card: 130, on: 0.5 },
      { cx: 244, card: 214, on: 0.24 },
    ].map((n) => (
      <g key={n.cx}>
        <rect
          x={n.card}
          y={8}
          width={60}
          height={38}
          rx={13}
          fill="currentColor"
          fillOpacity={0.11 * n.on}
        />
        <g fill="currentColor" fillOpacity={0.6 * n.on}>
          <rect x={n.card + 12} y={21} width={36} height={5.5} rx={2.75} />
          <rect x={n.card + 12} y={31} width={20} height={5.5} rx={2.75} />
        </g>
        <path
          d={`M${n.cx} 46v13`}
          stroke="currentColor"
          strokeWidth={5}
          strokeLinecap="round"
          strokeOpacity={0.28 * n.on}
        />
        <circle cx={n.cx} cy={66} r={10} fill="currentColor" fillOpacity={0.85 * n.on} />
      </g>
    ))}
  </Art>
);

/* ────────────────────────── 模板 id → 插画 ────────────────────────── */

/** 模板 id 是事实源（sidecar templates.ts）里的稳定标识，新增模板时在这里补
 *  一张；没登记的按 type 落兜底，不会开天窗 */
const TEMPLATE_ART: Record<string, FC<ArtProps>> = {
  "tpl-daily-briefing": DailyBriefingArt,
  "tpl-weekly-report": WeeklyReportArt,
  "tpl-repo-check": RepoCheckArt,
  "tpl-watch-scan": WatchScanArt,
  "tpl-one-off": OneOffArt,
};

const TYPE_FALLBACK_ART: Record<"cron" | "interval" | "once", FC<ArtProps>> = {
  cron: RepoCheckArt,
  interval: WatchScanArt,
  once: OneOffArt,
};

/** 只吃 {id,type} 两个字段：插画集因此不依赖 automations 类型定义，
 *  哪天模板结构改了这里不用跟着动 */
export function templateArtFor(template: {
  id: string;
  type: "cron" | "interval" | "once";
}): FC<ArtProps> {
  return TEMPLATE_ART[template.id] ?? TYPE_FALLBACK_ART[template.type];
}
