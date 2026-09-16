import { cn } from "@/lib/utils";

/**
 * 睡眠云宝的 CSS 占位（与 BootSplash 的 Mood Mates 引擎云同位同形）：
 * 随静态导出的预渲染 HTML 直接输出（无 JS 即可见），消除开屏
 * "磨砂空底 → 引擎云出现"的跳变；引擎就绪后整层淡出，由动画云接管。
 *
 * 仅 transform/opacity 动画（合成器驱动）——启动期主线程被 JS bundle
 * 求值阻塞时动画仍能播放（wandering-eyes 同款教训）。
 * hidden 时整层 opacity 0，引擎云在其下方接管视觉。
 */
function SleepingCloud({
  className,
  hidden,
}: {
  className?: string;
  hidden?: boolean;
}) {
  return (
    <>
      <style>{`
        @keyframes boot-cloud-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.045); }
        }
        @keyframes boot-cloud-zzz {
          0%, 100% { transform: translate(0, 4px); opacity: 0; }
          35%, 70% { transform: translate(0, -2px); opacity: 1; }
          85% { transform: translate(0, -6px); opacity: 0; }
        }
      `}</style>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-300",
          hidden && "opacity-0",
          className,
        )}
      >
        <span
          className="relative block h-24 w-34"
          style={{ animation: "boot-cloud-breathe 3.2s ease-in-out infinite" }}
        >
          {/* 云体：底部胶囊 + 两个凸起圆 */}
          <span className="absolute bottom-0 left-1/2 h-12 w-34 -translate-x-1/2 rounded-full bg-white shadow-[0_2px_12px_rgba(15,23,42,0.10)] dark:bg-zinc-700 dark:shadow-none dark:ring-1 dark:ring-white/15" />
          <span className="absolute bottom-7 left-5.5 size-11.5 rounded-full bg-white shadow-[0_2px_10px_rgba(15,23,42,0.08)] dark:bg-zinc-700 dark:shadow-none dark:ring-1 dark:ring-white/15" />
          <span className="absolute bottom-6 right-4.5 size-9 rounded-full bg-white shadow-[0_2px_8px_rgba(15,23,42,0.08)] dark:bg-zinc-700 dark:shadow-none dark:ring-1 dark:ring-white/15" />
          {/* 闭眼：两条下弯弧线 */}
          <span className="absolute left-11 top-13 h-1.75 w-3.75 rounded-b-full border-b-2 border-zinc-400 dark:border-zinc-300" />
          <span className="absolute right-11 top-13 h-1.75 w-3.75 rounded-b-full border-b-2 border-zinc-400 dark:border-zinc-300" />
          {/* zzz：右上漂浮，两枚错拍 */}
          <span
            className="absolute -top-1 right-3 text-[13px] font-semibold text-zinc-400 dark:text-zinc-300"
            style={{ animation: "boot-cloud-zzz 3.6s ease-in-out infinite" }}
          >
            z
          </span>
          <span
            className="absolute -top-5 right-7 text-[10px] font-semibold text-zinc-300 dark:text-zinc-400"
            style={{ animation: "boot-cloud-zzz 3.6s ease-in-out 1.8s infinite" }}
          >
            z
          </span>
        </span>
      </span>
    </>
  );
}

export { SleepingCloud };
