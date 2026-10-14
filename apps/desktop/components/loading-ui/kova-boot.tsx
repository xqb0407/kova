import Image from "next/image";
import logo from "@/public/favicon/icon.png";
import { cn } from "@/lib/utils";

type KovaBootProps = React.ComponentProps<"div"> & {
  /** 猫图标边长（px）：字标字号、图标-字标间距、左右展开位移都按它派生 */
  size?: number;
};

/** 整组进场的静默：窗口出现先稳一拍，品牌再从中缝展开 */
const PART_DELAY_MS = 100;
/** 展开时长：中央一团失焦字 → 图标左移、字标右移，边走边聚焦 */
const TRAVEL_MS = 900;

/**
 * 开屏品牌动画（替换原 WanderingEyes 眼睛）：logo 与「扣瓦」字标整组
 * 从屏中心左右展开——起手两者叠在中缝，字标是一团失焦大字，随后图标
 * 滑向左位、字标拉焦滑向右位，落成宣传视频结尾的横排版式（像镜头
 * 拉焦，不是淡入）。
 *
 * 纯 CSS 合成器动画（opacity/filter/transform），随静态导出的预渲染
 * HTML 首帧即播，不依赖水合与 JS 时序；fill-mode both 让两组元素在
 * 延迟期停在 0% 帧（不可见），主线程被启动期求值阻塞时动画照常走完。
 * reduced-motion 下跳过动画，整版直接可见。
 *
 * 滤镜纪律：只有字标 span 带 filter 动画；图标全程清晰（视频里也是），
 * 投影是 img 上的静态 drop-shadow。动画的 filter 一旦叠加在任何
 * 带投影的祖先/后代上，WKWebView 会按图层矩形而非 alpha 轮廓投影，
 * 落定后在图标下方的透明留白区投出一条硬边阴影带（2026-10-05 修复）。
 */
function KovaBoot({ className, size = 128, style, ...props }: KovaBootProps) {
  // 位移按组宽推：图标从组中心到左位 ≈ 0.94×边长，字标到右位 ≈ 0.64×
  const iconShift = Math.round(size * 0.94);
  const wordShift = Math.round(size * 0.64);

  return (
    <div
      className={cn("flex select-none items-center", className)}
      style={{ gap: `${Math.round(size * 0.28)}px`, ...style }}
      {...props}
    >
      <style>{`
        @keyframes kova-boot-icon {
          0% {
            opacity: 0;
            transform: translateX(var(--kova-boot-from));
          }

          100% {
            opacity: 1;
            transform: translateX(0);
          }
        }

        @keyframes kova-boot-word {
          0% {
            opacity: 0;
            filter: blur(16px);
            transform: translateX(var(--kova-boot-from)) scale(1.12);
          }

          100% {
            opacity: 1;
            filter: blur(0);
            transform: translateX(0) scale(1);
          }
        }

        .kova-boot-icon {
          animation: kova-boot-icon ${TRAVEL_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${PART_DELAY_MS}ms both;
        }

        .kova-boot-word {
          animation: kova-boot-word ${TRAVEL_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${PART_DELAY_MS}ms both;
        }

        @media (prefers-reduced-motion: reduce) {
          .kova-boot-icon,
          .kova-boot-word {
            animation: none;
          }
        }
      `}</style>
      <Image
        src={logo}
        alt=""
        width={size}
        height={size}
        priority
        draggable={false}
        className="kova-boot-icon "
        style={{ "--kova-boot-from": `${iconShift}px` } as React.CSSProperties}
      />
      <span
        className="kova-boot-word flex items-center gap-[0.12em] font-bold leading-none"
        style={
          {
            fontSize: `${Math.round(size * 0.76)}px`,
            "--kova-boot-from": `${-wordShift}px`,
          } as React.CSSProperties
        }
      >
        {["扣", "瓦"].map((char) => (
          <span key={char} className="inline-block">
            {char}
          </span>
        ))}
      </span>
    </div>
  );
}

export { KovaBoot };
