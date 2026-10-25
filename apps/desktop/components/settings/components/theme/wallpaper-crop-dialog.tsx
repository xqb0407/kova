"use client";

import {
  useEffect,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import {
  clampOffsets,
  coverScale,
  cropViewSize,
  sourceRect,
} from "@/lib/theme/crop";
import { getChatSurfaceSize } from "@/lib/theme/chat-surface";
import { bitmapToDataUrl, bitmapToSource } from "@/lib/theme/wallpaper";
import { RotateCcwIcon } from "lucide-react";

export type WallpaperCropResult = { display: string; source: string };

/** 预览框按聊天卡片比例；设置页里卡片已卸载时回落到窗口比例 */
function measureView() {
  if (typeof window === "undefined") return cropViewSize(1440, 900, 780);
  const surface = getChatSurfaceSize();
  // 扣掉标题、缩放行、底部按钮与内边距，短窗口时预览自动收高，footer 始终可见
  const maxHeight = Math.max(200, Math.round(window.innerHeight * 0.92) - 250);
  return cropViewSize(
    surface?.width ?? window.innerWidth,
    surface?.height ?? window.innerHeight,
    780,
    maxHeight,
  );
}

/**
 * 壁纸裁剪编辑器：预览框按聊天窗口比例，拖动平移 + 滚轮/滑杆缩放，
 * 应用时把预览中看到的区域绘制成压缩后的图片。
 */
export const WallpaperCropDialog: FC<{
  open: boolean;
  /** 预览用 object URL（ImageBitmap 不能直接给 <img>） */
  url: string | null;
  bitmap: ImageBitmap | null;
  onOpenChange: (open: boolean) => void;
  onApply: (result: WallpaperCropResult) => void;
}> = ({ open, url, bitmap, onOpenChange, onApply }) => {
  const [view, setView] = useState(measureView);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );
  const previewRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    if (!open) {
      drag.current = null;
      return;
    }
    setView(measureView());
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError(null);
  }, [open, bitmap]);

  // 滚轮缩放：React 的 wheel 是 passive 的，preventDefault 无效，这里用原生监听
  useEffect(() => {
    const el = previewRef.current;
    if (!open || !el || !bitmap) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = Math.min(
        3,
        Math.max(1, zoomRef.current * Math.exp(-event.deltaY * 0.0015)),
      );
      if (Math.abs(next - zoomRef.current) < 0.001) return;
      setZoom(next);
      setOffset((current) => {
        const clamped = clampOffsets(
          bitmap.width,
          bitmap.height,
          view.width,
          view.height,
          { zoom: next, offsetX: current.x, offsetY: current.y },
        );
        return { x: clamped.offsetX, y: clamped.offsetY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, bitmap, view]);

  if (!bitmap) return null;

  const zoomed = (nextZoom: number) => {
    const z = Math.min(3, Math.max(1, nextZoom));
    setZoom(z);
    setOffset((current) => {
      const clamped = clampOffsets(
        bitmap.width,
        bitmap.height,
        view.width,
        view.height,
        { zoom: z, offsetX: current.x, offsetY: current.y },
      );
      return { x: clamped.offsetX, y: clamped.offsetY };
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const raw = {
      zoom,
      offsetX: drag.current.ox + (event.clientX - drag.current.x),
      offsetY: drag.current.oy + (event.clientY - drag.current.y),
    };
    const clamped = clampOffsets(
      bitmap.width,
      bitmap.height,
      view.width,
      view.height,
      raw,
    );
    setOffset({ x: clamped.offsetX, y: clamped.offsetY });
  };

  const endDrag = () => {
    drag.current = null;
  };

  const resetView = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const apply = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const rect = sourceRect(
        bitmap.width,
        bitmap.height,
        view.width,
        view.height,
        { zoom, offsetX: offset.x, offsetY: offset.y },
      );
      onApply({
        display: bitmapToDataUrl(bitmap, rect, 2560),
        source: bitmapToSource(bitmap),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片处理失败");
    } finally {
      setBusy(false);
    }
  };

  const scale =
    coverScale(bitmap.width, bitmap.height, view.width, view.height) * zoom;
  const ratio = (view.width / view.height).toFixed(2);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 基础 DialogContent 带 sm:max-w-sm（384px），必须显式覆盖，
          否则大预览会溢出并把标题/底部按钮裁掉 */}
      <DialogContent className="flex max-h-[92vh] w-[min(87vw,980px)] max-w-[min(87vw,980px)] flex-col gap-4 overflow-y-auto p-6 sm:max-w-[min(87vw,980px)]">
        <DialogHeader className="gap-2">
          <DialogTitle className="text-lg font-semibold">
            调整壁纸构图
          </DialogTitle>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <DialogDescription className="max-w-[60ch] text-sm">
              拖动图片调整位置，滚动或拖动滑杆缩放。框内区域将用作壁纸。
            </DialogDescription>
            <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-3 py-1 text-xs tabular-nums">
              窗口比例 {ratio}:1
            </span>
          </div>
        </DialogHeader>

        <div
          ref={previewRef}
          className="relative mx-auto touch-none overflow-hidden rounded-xl bg-black/80 ring-1 ring-black/10 select-none"
          style={{ width: view.width, height: view.height, cursor: "grab" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetView}
        >
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              className="pointer-events-none absolute top-1/2 left-1/2 max-w-none select-none"
              style={{
                width: bitmap.width * scale,
                height: bitmap.height * scale,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              }}
            />
          )}
          {/* 三分构图参考线 */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
            <div className="absolute inset-0 ring-1 ring-white/15 ring-inset" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-8 shrink-0 text-xs">
            缩放
          </span>
          <Slider
            min={100}
            max={300}
            step={1}
            value={[Math.round(zoom * 100)]}
            onValueChange={(value) => {
              const first = Array.isArray(value) ? value[0] : value;
              if (typeof first === "number") zoomed(first / 100);
            }}
            className="flex-1"
          />
          <span className="w-12 shrink-0 text-right text-xs tabular-nums">
            {zoom.toFixed(1)}×
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={resetView}
          >
            <RotateCcwIcon className="size-3.5" />
            复位
          </Button>
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}
          
        <DialogFooter className="border-border/60 flex w-full flex-wrap items-center justify-between gap-3  pt-4">
          <span className="text-muted-foreground text-xs">
            原图 {bitmap.width} × {bitmap.height} 像素
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={apply} disabled={busy}>
              {busy ? "处理中…" : "应用壁纸"}
            </Button>
          </div>
        </DialogFooter>
       
      </DialogContent>
    </Dialog>
  );
};
