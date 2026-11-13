"use client";

import { useEffect, useRef, type FC } from "react";
import { useReducedMotion } from "motion/react";

/**
 * 空面板背景：一片星点组成的网格，鼠标碰到哪颗星，它就被"唤醒"——
 * 微微放大、旋转 45°、提亮，并荡开一圈涟漪；离开后缓缓落回原样。
 *
 * 星图只铺在空态内容块大小的中央区域里（约 440×460），边缘径向淡出，
 * 不覆盖整个面板背景。用 canvas 而不是 DOM：空态卡片居中、面板拖宽/开合
 * 时容器尺寸频繁变化，数百个 DOM 节点的布局与合成成本远高于一次逐帧重绘；
 * 星点只在 resize 时重建，每帧只画形状。颜色读 `--foreground`（浅色=墨星、
 * 深色=白星），跟随主题切换。整片星板还带一层按深度分配的极轻视差，鼠标
 * 扫过时有微弱的纵深感，但主要反馈仍在"碰到的那颗星"上。
 *
 * 尊重 `prefers-reduced-motion`：只画一帧静态星图，不挂鼠标监听、不跑动画。
 */

/** 网格步长（CSS px）：星与星之间留出呼吸，又保证每个格子里都能碰到 */
const GRID = 34;
/** 星图区域尺寸：只铺在空态内容块大小的中央区域，不盖满整个面板背景 */
const FIELD_W = 440;
const FIELD_H = 460;
/** 单颗星的唤醒半径：只对"手摸到"的星生效（格子对角线约 24px） */
const TOUCH_RADIUS = 30;
/** 整片星板的最大视差位移 */
const PARALLAX = 7;
/** 唤醒后的额外亮度 */
const WAKE_ALPHA = 0.6;
/** 涟漪寿命（ms） */
const RING_MS = 700;
/** 连续扫过星点时两圈涟漪的最小间隔，避免叠成一团 */
const RING_GAP_MS = 380;
const TAU = Math.PI * 2;

interface Star {
  x: number;
  y: number;
  /** 星芒半径（CSS px） */
  r: number;
  /** 基础亮度 */
  alpha: number;
  /** 呼吸相位/速度，避免整片星图同频闪 */
  phase: number;
  speed: number;
  /** 视差系数：0.45–1.35，形成一层有厚度的星板 */
  depth: number;
  /** 0–1 的唤醒程度：缩放/旋转/亮度都由它驱动 */
  wake: number;
}

interface Ring {
  x: number;
  y: number;
  at: number;
}

/** 四角星（凹边菱形）：两条长轴 + 四个内凹顶点，小尺寸下也认得出是"星" */
const drawStar = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  rot: number,
) => {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const k = r * 0.28;
  const pts: Array<[number, number]> = [
    [0, -r],
    [k, -k],
    [r, 0],
    [k, k],
    [0, r],
    [-k, k],
    [-r, 0],
    [-k, -k],
  ];
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i]!;
    const X = x + px * c - py * s;
    const Y = y + px * s + py * c;
    if (i === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  }
  ctx.closePath();
  ctx.fill();
};

export const PanelStarfield: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let stars: Star[] = [];
    const rings: Ring[] = [];
    let width = 0;
    let height = 0;
    /** 星图中央区域的尺寸/圆心（build 时按画布尺寸收缩） */
    let fieldW = 0;
    let fieldH = 0;
    let fieldCx = 0;
    let fieldCy = 0;
    /** 椭圆淡出半径：星图边缘由 alpha *= fade 兜底，不留生硬截断 */
    let fadeRx = 1;
    let fadeRy = 1;
    let dpr = 1;
    let needsBuild = true;
    let raf = 0;
    /** 主题切换时重读前景色（每帧只比一次 className，几乎零成本） */
    let themeClass: string | null = null;
    let color = "#8a8a8a";
    /** 上一帧最近的星与涟漪节流：只在"换了一颗星"时溅一圈 */
    let lastStar: Star | null = null;
    let lastRingAt = -Infinity;

    // 指针：active=false 表示指针在面板外，视差回落到中心、所有星落回原样
    const pointer = { x: 0, y: 0, active: false };
    // 视差用的平滑指针：鼠标瞬移时星板是"跟过去"，不是"跳过去"
    const eased = { x: 0, y: 0 };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      // 星图只铺中央区域（FIELD_W×FIELD_H，随视口收缩）：行列多算一格，
      // 区域边缘由径向淡出兜底，不出现半截星
      fieldW = Math.min(FIELD_W, width);
      fieldH = Math.min(FIELD_H, height);
      fieldCx = width / 2;
      fieldCy = height / 2;
      fadeRx = fieldW / 2 + 24;
      fadeRy = fieldH / 2 + 24;
      const cols = Math.ceil(fieldW / GRID) + 1;
      const rows = Math.ceil(fieldH / GRID) + 1;
      const startX = fieldCx - fieldW / 2 - ((fieldW % GRID) - GRID) / 2;
      const startY = fieldCy - fieldH / 2 - ((fieldH % GRID) - GRID) / 2;
      stars = [];
      rings.length = 0;
      lastStar = null;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const rand = Math.random();
          stars.push({
            x: startX + col * GRID,
            y: startY + row * GRID,
            // 大多数是小星芒，少数稍大，整片网格才有疏密层次
            r: rand > 0.93 ? 3.1 : 1.4 + Math.random() * 1.0,
            alpha: 0.1 + Math.random() * 0.07,
            phase: Math.random() * TAU,
            speed: 0.35 + Math.random() * 0.55,
            depth: 0.45 + Math.random() * 0.9,
            wake: 0,
          });
        }
      }
      // 重建后过渡值先落到中心，避免 resize 瞬间星板翘起
      eased.x = pointer.active ? pointer.x : width / 2;
      eased.y = pointer.active ? pointer.y : height / 2;
      needsBuild = false;
    };

    const paint = (now: number, animate: boolean) => {
      if (needsBuild) build();

      const cls = document.documentElement.className;
      if (cls !== themeClass) {
        themeClass = cls;
        // 画布挂 text-foreground：计算值即当前主题的前景色
        color = getComputedStyle(canvas).color || color;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;

      const t = now / 1000;
      const tx = pointer.active ? pointer.x : width / 2;
      const ty = pointer.active ? pointer.y : height / 2;
      eased.x += (tx - eased.x) * (animate ? (pointer.active ? 0.09 : 0.045) : 1);
      eased.y += (ty - eased.y) * (animate ? (pointer.active ? 0.09 : 0.045) : 1);

      // 归一化指针偏移 → 整片星板的视差位移（以画布中心为原点）
      const ox = ((eased.x - width / 2) / Math.max(1, width / 2)) * PARALLAX;
      const oy = ((eased.y - height / 2) / Math.max(1, height / 2)) * PARALLAX;

      // 逐星更新唤醒度，同时找出离指针最近的那颗（涟漪落点）
      let nearest: Star | null = null;
      let nearestDist = Infinity;
      for (const star of stars) {
        const sx = star.x - ox * star.depth;
        const sy = star.y - oy * star.depth;
        let target = 0;
        if (animate && pointer.active) {
          const dx = sx - pointer.x;
          const dy = sy - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < TOUCH_RADIUS) {
            const f = 1 - dist / TOUCH_RADIUS;
            target = f * f * (3 - 2 * f); // smoothstep：接触边缘不跳变
          }
          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = star;
          }
        }
        // 碰到就亮起来，手移开慢慢熄回去
        star.wake += (target - star.wake) * (animate ? 0.14 : 1);
      }

      // 指针移到一颗新星上：溅起一圈涟漪（只在星图区域内生效）
      if (
        animate &&
        nearest &&
        nearest !== lastStar &&
        nearestDist < TOUCH_RADIUS * 0.85
      ) {
        if (now - lastRingAt > RING_GAP_MS) {
          rings.push({
            x: nearest.x - ox * nearest.depth,
            y: nearest.y - oy * nearest.depth,
            at: now,
          });
          lastRingAt = now;
        }
        lastStar = nearest;
      } else if (!pointer.active) {
        lastStar = null;
      }

      // 涟漪：向外扩散、淡出，画在星点之下
      ctx.strokeStyle = color;
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i]!;
        const p = (now - ring.at) / RING_MS;
        if (p >= 1) {
          rings.splice(i, 1);
          continue;
        }
        const easeOut = 1 - Math.pow(1 - p, 3);
        ctx.globalAlpha = (1 - p) * 0.32;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, 3 + easeOut * 26, 0, TAU);
        ctx.stroke();
      }

      // 星点本体：唤醒 = 放大 + 旋转 45° + 提亮；星图只在中央区域，
      // 越靠区域边缘越淡（椭圆归一化距离的 smoothstep），四周是干净的底色
      for (const star of stars) {
        const sx = star.x - ox * star.depth;
        const sy = star.y - oy * star.depth;
        const wake = star.wake;
        const twinkle = animate
          ? 0.7 + 0.3 * Math.sin(t * star.speed + star.phase)
          : 1;
        const dx = (sx - fieldCx) / fadeRx;
        const dy = (sy - fieldCy) / fadeRy;
        const edge = Math.hypot(dx, dy);
        const fade =
          edge >= 1
            ? 0
            : Math.min(1, (1 - edge) / 0.35); // 外圈 35% 线性淡出
        if (fade <= 0) continue;
        const alpha = Math.min(
          0.82,
          (star.alpha * twinkle * fade) + wake * WAKE_ALPHA * fade,
        );
        if (alpha < 0.01) continue;

        ctx.globalAlpha = alpha;
        const r = star.r * (1 + wake * 0.95);
        const rot =
          wake * (Math.PI / 4) +
          (animate ? wake * 0.1 * Math.sin(t * 2.2 + star.phase) : 0);
        drawStar(ctx, sx, sy, r, rot);
      }
      ctx.globalAlpha = 1;
    };

    // 主题/外观切换可能只改 html 属性（.dark、data-window-effect）：
    // 变化时把缓存作废，下一帧重读前景色（静态分支则立即重画一帧）
    const themeObserver = new MutationObserver(() => {
      themeClass = null;
      if (reduceMotion) paint(performance.now(), false);
    });
    themeObserver.observe(document.documentElement, { attributes: true });

    // —— 无动画分支：一帧静态星图（resize 时重画） ——
    if (reduceMotion) {
      paint(performance.now(), false);
      const ro = new ResizeObserver(() => {
        needsBuild = true;
        paint(performance.now(), false);
      });
      ro.observe(canvas);
      return () => {
        ro.disconnect();
        themeObserver.disconnect();
      };
    }

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // 留 16px 余量：贴边移动时视差不至于骤然中断
      pointer.active =
        x >= -16 && y >= -16 && x <= rect.width + 16 && y <= rect.height + 16;
      pointer.x = Math.min(Math.max(x, 0), rect.width);
      pointer.y = Math.min(Math.max(y, 0), rect.height);
    };
    const onPointerLeave = () => {
      pointer.active = false;
    };

    let lastDraw = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // 空闲（指针离开、涟漪散尽、星点全熄）时降到约 30fps：
      // 呼吸本来就慢，肉眼无差
      const idle =
        !pointer.active &&
        rings.length === 0 &&
        stars.every((star) => star.wake < 0.01);
      if (idle && now - lastDraw < 32) return;
      lastDraw = now;
      paint(now, true);
    };

    const ro = new ResizeObserver(() => {
      needsBuild = true;
    });
    ro.observe(canvas);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    // pointerleave 不冒泡：必须挂在 document 捕获阶段才能收到（指针移出窗口
    // 且窗口仍保持焦点时，否则星点会一直停在窗口边缘亮着）；blur 兜住切应用
    document.addEventListener("pointerleave", onPointerLeave, true);
    window.addEventListener("blur", onPointerLeave);

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave, true);
      window.removeEventListener("blur", onPointerLeave);
    };
  }, [reduceMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="text-foreground pointer-events-none absolute inset-0 size-full"
      // 面板顶栏与内容同为底色：星图从顶栏下缘淡入，不留一条生硬的截断
      style={{ maskImage: "linear-gradient(to bottom, transparent, #000 56px)" }}
    />
  );
};
