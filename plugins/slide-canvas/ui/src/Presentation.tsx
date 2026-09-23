/**
 * 放映模式：iframe 内 requestFullscreen（宿主已授予 allow="fullscreen"），
 * 当前页 contain 铺满；方向键/空格/点击翻页，末点击/末页右方向退出。
 * 全屏被拒（如非手势链路）时退化为覆盖层放映，功能不丢。
 */
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { XIcon } from "lucide-react";
import { SlideView } from "./render";
import { slideFrames } from "./doc";
import type { DeckStore } from "./state";

export const Presentation: FC<{ store: DeckStore; onClose: () => void }> = ({ store, onClose }) => {
  // 放映 = 页框（type:"slide"）按数组序；画布级 objects 不参与
  const slides = slideFrames(store.doc);
  const [idx, setIdx] = useState(() => {
    const i = slides.findIndex((s) => s.id === store.sel?.containerId);
    return i >= 0 ? i : 0;
  });
  const [box, setBox] = useState({ w: window.innerWidth, h: window.innerHeight });
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
    return () => {
      window.removeEventListener("resize", onRz);
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
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) {
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
  }, [advance, back, onClose]);

  const slide = slides[Math.min(idx, slides.length - 1)];
  if (!slide) {
    // 放映中被删空：直接收场
    setTimeout(onClose, 0);
    return null;
  }
  const scale = Math.min(box.w / slide.w, box.h / slide.h);
  return (
    <div
      ref={rootRef}
      className="bg-black fixed inset-0 z-50 flex cursor-default items-center justify-center select-none"
      onClick={advance}
    >
      <div style={{ width: slide.w * scale, height: slide.h * scale, position: "relative" }}>
        <SlideView slide={slide} scale={scale} />
      </div>
      <div
        className="glass-sm glass pointer-events-none absolute right-4 bottom-4 flex items-center gap-3 px-3 py-1.5 text-xs text-foreground/80"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="tabular-nums">
          {idx + 1} / {slides.length}
        </span>
        <span className="text-muted-foreground">←→/空格 翻页 · Esc 退出</span>
        <button
          type="button"
          aria-label="退出放映"
          className="pointer-events-auto text-foreground/70 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
};
