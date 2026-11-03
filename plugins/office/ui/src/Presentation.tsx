/**
 * 放映模式：iframe 内 requestFullscreen（宿主已授予 allow="fullscreen"），
 * 当前页 contain 铺满；方向键/空格/点击翻页，末页右方向退出。
 * 全屏被拒（如非手势链路）时退化为覆盖层放映，功能不丢。
 *
 * 演讲者视图（WPS/PowerPoint 式，S 键切换）：右侧栏 = 下一页预览 + 备注（可直接编辑，
 * 落到 frame.notes）+ 计时器；B/W 键黑屏/白屏（任意键或点击恢复）。
 */
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, MonitorPlayIcon, PenLineIcon, XIcon } from "lucide-react";
import { SlideView } from "./render";
import { slideFrames } from "./doc";
import type { DeckStore } from "./state";

const fmtTime = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

export const Presentation: FC<{ store: DeckStore; onClose: () => void }> = ({ store, onClose }) => {
  // 放映 = 页框（type:"slide"）按数组序；画布级 objects 不参与
  const slides = slideFrames(store.doc);
  const [idx, setIdx] = useState(() => {
    const i = slides.findIndex((s) => s.id === store.sel?.containerId);
    return i >= 0 ? i : 0;
  });
  const [box, setBox] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [presenter, setPresenter] = useState(false);
  const [blackout, setBlackout] = useState<"black" | "white" | null>(null);
  const [startAt, setStartAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const idxRef = useRef(idx);
  idxRef.current = idx;

  const advance = useCallback(() => {
    if (idxRef.current >= slides.length - 1) {
      onClose();
      return;
    }
    setIdx((i) => Math.min(i + 1, slides.length - 1));
  }, [slides.length, onClose]);
  const back = useCallback(() => setIdx((i) => Math.max(i - 1, 0)), []);

  useEffect(() => {
    const onRz = () => setBox({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onRz);
    void rootRef.current?.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener("resize", onRz);
      window.clearInterval(tick);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  // 用户按 Esc 退出全屏 → 结束放映
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) onClose();
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 备注输入框里的按键不接管
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      if (blackout) {
        if (e.key === "Escape") {
          onClose();
          return;
        }
        e.preventDefault();
        setBlackout(null);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        setBlackout("black");
      } else if (key === "w") {
        e.preventDefault();
        setBlackout("white");
      } else if (key === "s") {
        e.preventDefault();
        setPresenter((v) => !v);
      } else if (key === "r") {
        e.preventDefault();
        setStartAt(Date.now());
        setNow(Date.now());
      } else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) {
        e.preventDefault();
        advance();
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) {
        e.preventDefault();
        back();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, back, onClose, blackout]);

  const slide = slides[Math.min(idx, slides.length - 1)];
  if (!slide) {
    // 放映中被删空：直接收场
    setTimeout(onClose, 0);
    return null;
  }
  const nextSlide = slides[Math.min(idx + 1, slides.length - 1)];
  const panelW = presenter ? Math.min(380, Math.round(box.w * 0.3)) : 0;
  const mainW = box.w - panelW;
  const scale = Math.min(mainW / slide.w, box.h / slide.h);
  const nextScale = panelW > 0 ? Math.min((panelW - 32) / nextSlide.w, 180 / nextSlide.h) : 1;
  // 按页转场：key 换页重挂触发入场动画（none 不挂类）
  const tr = slide.transition ?? "slide";
  const chrome =
    store.doc.meta.pageNumber || store.doc.meta.footer
      ? { index: idx + 1, total: slides.length, showNumber: store.doc.meta.pageNumber, footer: store.doc.meta.footer }
      : undefined;

  return (
    <div ref={rootRef} className="bg-black fixed inset-0 z-50 flex cursor-default select-none">
      <div className="relative flex min-w-0 flex-1 items-center justify-center" onClick={advance}>
        <div
          key={slide.id}
          className={tr === "none" ? undefined : tr === "slide" ? "sc-present-slide" : tr === "fade" ? "sc-present-fade" : "sc-present-zoom"}
          style={{ width: slide.w * scale, height: slide.h * scale, position: "relative" }}
        >
          <SlideView slide={slide} scale={scale} chrome={chrome} />
        </div>
      </div>

      {presenter && (
        <aside
          className="flex shrink-0 flex-col gap-3 border-l border-white/10 bg-[#0f1115] p-4 text-gray-200"
          style={{ width: panelW }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between text-[11px] text-gray-400">
            <span className="inline-flex items-center gap-1.5">
              <ClockIcon className="size-3.5" /> {fmtTime(now - startAt)}
            </span>
            <span className="tabular-nums">
              {idx + 1} / {slides.length}
            </span>
            <button
              type="button"
              className="hover:text-gray-200"
              title="重置计时（R）"
              onClick={() => {
                setStartAt(Date.now());
                setNow(Date.now());
              }}
            >
              重置
            </button>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-gray-400">下一页</div>
            <div className="overflow-hidden rounded-md border border-white/10 bg-white" style={{ width: panelW - 32, height: Math.round(nextSlide.h * nextScale) }}>
              <SlideView slide={nextSlide} scale={nextScale} />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <PenLineIcon className="size-3.5" /> 备注（自动保存到本页）
            </div>
            <textarea
              key={slide.id}
              value={slide.notes ?? ""}
              placeholder="演讲者备注：只在这里和演讲者视图可见，不进页面/导出"
              onChange={(e) => store.setFrameNotes(slide.id, e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="min-h-0 flex-1 resize-none rounded-md border border-white/10 bg-black/30 p-2.5 text-[12.5px] leading-relaxed text-gray-200 outline-none focus:border-white/25"
            />
          </div>
        </aside>
      )}

      {blackout && (
        <div
          className="absolute inset-0 z-20 cursor-pointer"
          style={{ background: blackout === "black" ? "#000" : "#fff" }}
          onClick={(e) => {
            e.stopPropagation();
            setBlackout(null);
          }}
          title="点击或按任意键恢复"
        />
      )}

      <div
        className="glass-sm glass absolute right-4 bottom-4 flex items-center gap-1.5 px-2 py-1.5 text-xs text-foreground/80"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="rounded p-1 hover:bg-white/10" aria-label="上一页" onClick={back}>
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="min-w-[52px] text-center tabular-nums">
          {idx + 1} / {slides.length}
        </span>
        <button type="button" className="rounded p-1 hover:bg-white/10" aria-label="下一页" onClick={advance}>
          <ChevronRightIcon className="size-4" />
        </button>
        <span className="mx-1 h-4 w-px bg-black/10" />
        <button
          type="button"
          aria-pressed={presenter}
          title="演讲者视图（S）"
          className={`rounded p-1 hover:bg-white/10 ${presenter ? "bg-white/15" : ""}`}
          onClick={() => setPresenter((v) => !v)}
        >
          <MonitorPlayIcon className="size-4" />
        </button>
        <span className="text-muted-foreground hidden text-[10px] sm:inline">B 黑屏 · W 白屏 · S 演讲者 · R 重置</span>
        <button
          type="button"
          aria-label="退出放映"
          className="rounded p-1 text-foreground/70 hover:bg-white/10 hover:text-foreground"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
};
