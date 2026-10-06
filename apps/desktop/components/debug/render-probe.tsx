"use client";

/**
 * 渲染耗时自检：把子树挂到 React <Profiler> 下，把「贵的那一帧」打进 console。
 *
 * 为什么要它：定位卡顿先要分清「贵在消息流还是贵在右侧面板」，而 React DevTools
 * 的火焰图不是人人会看。这个只要开着控制台就可能读到结论——流式跑一遍，看
 * [perf] 行里哪个 label 在刷大数字。
 *
 * 只在开发构建生效：React 的 <Profiler> onRender 在生产构建里不会被调用（要用
 * profiling 构建才行），所以打包版是空转，不产生任何开销与日志。
 *
 * 用法：`bun run tauri:dev`（或 next dev + 浏览器），复现卡顿，把 [perf] 开头的
 * 几行贴出来即可——不需要看火焰图。
 */

import {
  Profiler,
  useCallback,
  useEffect,
  useRef,
  type FC,
  type ReactNode,
} from "react";
import { noteRender } from "./perf-store";

/** 超过这个耗时才算「贵的一帧」，低于它的提交不记（避免日志本身成负担） */
const SLOW_COMMIT_MS = 30;
/** 同一个 label 的日志间隔下限，避免连续卡帧刷屏 */
const LOG_INTERVAL_MS = 500;

const enabled = process.env.NODE_ENV !== "production";

/** 每 3s 的实时帧率行：定位阶段很有用，但它每 3 秒给每个探针各刷一行
 *  （消息流 + 右侧面板 = 每分钟约 40 行），开控制台就是一堵墙。
 *  窗口化帧率已折进 HUD 汇总行的「近况最差fps」，信息等价 → 默认关掉。 */
const REPORT_FPS = false;

export const RenderProbe: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => {
  const lastLogRef = useRef(0);
  const framesRef = useRef({ count: 0, since: 0, worst: 0 });

  const onRender = useCallback(
    (_id: string, phase: string, actualDuration: number, base: number) => {
      // 屏上 HUD 看这个（取每窗口最慢一次）；console 那份留给愿意开 devtools 的时候
      noteRender(label, actualDuration);
      // 再量一段「渲染完到真正出帧」：提交 + 布局 + 绘制 + 合成。这一段是 React
      // Profiler 看不到的（它只算 render 阶段），而实测里最长帧 365ms 减去渲染
      // 118ms 还剩约 250ms 就落在这里——不把它和渲染分开，就分不清该修哪边。
      if (actualDuration >= 16) {
        const t0 = performance.now();
        requestAnimationFrame(() => {
          noteRender(`${label}-绘制`, performance.now() - t0);
        });
      }
      const now = performance.now();
      if (actualDuration >= SLOW_COMMIT_MS && now - lastLogRef.current > LOG_INTERVAL_MS) {
        lastLogRef.current = now;
        console.warn(
          `[perf] ${label} 慢帧：渲染 ${actualDuration.toFixed(1)}ms（基准 ${base.toFixed(1)}ms，phase=${phase}）`,
        );
      }
    },
    [label],
  );

  // 顺带统计实际帧间隔：React 渲染不贵但帧率仍低，说明瓶颈在布局/绘制，
  // 而不是组件重渲——这两者的修法完全不同，必须先分清。
  // 只在开发构建刷这条（每 3s 两个探针各一行 = 生产日志里每分钟 ~40 行噪声）；
  // 打包版要帧率就看 HUD 汇总行里的「近况最差fps」，信息等价而不刷屏。
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const f = framesRef.current;
      const dt = now - last;
      last = now;
      if (f.since === 0) f.since = now;
      f.count += 1;
      if (dt > f.worst) f.worst = dt;
      if (REPORT_FPS && now - f.since >= 3000) {
        console.warn(
          `[perf] ${label} 帧率：近 3s ${(f.count / ((now - f.since) / 1000)).toFixed(1)} fps，最长帧间隔 ${f.worst.toFixed(0)}ms`,
        );
        f.count = 0;
        f.since = now;
        f.worst = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [label]);

  if (!enabled) return <>{children}</>;
  return (
    <Profiler id={label} onRender={onRender}>
      {children}
    </Profiler>
  );
};
