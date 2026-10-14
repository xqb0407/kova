"use client";

/**
 * Apple「快速查看」式全屏图片预览，工具产图（image-data.tsx）与消息附件
 * （attachment.aui.tsx）共用一套：滚轮/按钮缩放、拖拽平移、90° 旋转（自动
 * 重新适配）、双击在适配与 2× 间切换、点空白关闭、存本地。
 *
 * transform 实现缩放旋转（不改布局），Popup 用 overflow-hidden 防止 transform
 * 溢出产生滚动条，平移靠 translate 不靠滚动。
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { type FC, useEffect, useRef, useState } from "react";
import {
  DownloadIcon,
  RotateCwIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type ImageQuickLookProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 直接可展示的图片 URL（blob:/http(s):/data: 都行） */
  src: string;
  alt: string;
  /** 下载文件名，省略时不渲染「存本地」按钮 */
  downloadName?: string;
};

export const ImageQuickLook: FC<ImageQuickLookProps> = ({
  open,
  onOpenChange,
  src,
  alt,
  downloadName,
}) => {
  // zoom=1 适配视口，>1 可拖拽平移；rotate 90°步进，旋转时自动重新适配
  // 让整图始终可见（Apple 行为）
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(
    null,
  );

  useEffect(() => {
    // 每次打开回到适配态：上一张的缩放/旋转不带到下一张
    if (open) {
      setZoom(1);
      setRotate(0);
      setOffset({ x: 0, y: 0 });
      setNatural(null);
      setLoaded(false);
    }
  }, [open]);

  const applyZoom = (z: number) => {
    const clamped = Math.min(8, Math.max(1, z));
    setZoom(clamped);
    // 回到适配态时平移复位
    if (clamped === 1) setOffset({ x: 0, y: 0 });
  };

  // 滚轮缩放（以 1.2 倍步进，向上滚放大）
  const onWheel = (e: React.WheelEvent) => {
    applyZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  };

  // 旋转后重新适配：90°/270° 时旋转包围盒与视口互换，需要补一个缩小系数。
  // 用自然尺寸 + 视口估算 zoom=1 时的适配宽高（与 max-h-[86vh]/max-w-[90vw]
  // 的 contain 结果一致），再算旋转后包围盒放得下的额外 scale
  const rotated = rotate % 180 !== 0;
  const extraFit = (() => {
    if (!open || !rotated || !natural || zoom !== 1) return 1;
    const vw = window.innerWidth * 0.9;
    const vh = window.innerHeight * 0.86;
    const fitW = Math.min(vw, (vh * natural.w) / natural.h);
    const fitH = Math.min(vh, (vw * natural.h) / natural.w);
    return Math.min(1, vh / fitW, vw / fitH);
  })();

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0 || zoom <= 1) return;
    dragRef.current = {
      px: e.clientX,
      py: e.clientY,
      ox: offset.x,
      oy: offset.y,
    };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const st = dragRef.current;
    if (!st) return;
    setOffset({
      x: st.ox + (e.clientX - st.px),
      y: st.oy + (e.clientY - st.py),
    });
  };

  const onPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Popup
          className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 flex overflow-hidden p-8 duration-150 outline-none"
          onWheel={onWheel}
          onClick={(e) => {
            // 点空白关闭：落在图片/工具栏上的点击不关
            if (!(e.target as HTMLElement).closest("img,button,a")) {
              onOpenChange(false);
            }
          }}
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img
            src={src}
            // 大图也异步解码，但不 lazy——用户正等着看它
            decoding="async"
            alt={alt}
            draggable={false}
            className={cn(
              "m-auto max-h-[86vh] max-w-[90vw] select-none rounded-lg object-contain shadow-2xl transition-opacity duration-200",
              loaded ? "opacity-100" : "opacity-0",
              dragging ? "" : "transition-transform duration-200 ease-out",
            )}
            onLoad={(e) => {
              setLoaded(true);
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              });
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => applyZoom(zoom === 1 ? 2 : 1)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) rotate(${rotate}deg) scale(${zoom * extraFit})`,
              cursor:
                zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
          />
          <div className="bg-black/55 fixed bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full px-1.5 py-1 text-white">
            <button
              type="button"
              onClick={() => applyZoom(zoom / 1.5)}
              disabled={zoom <= 1}
              title="缩小"
              className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/15 disabled:opacity-40"
            >
              <ZoomOutIcon className="size-4" />
            </button>
            <span className="w-12 text-center text-xs tabular-nums opacity-80">
              {Math.round(zoom * extraFit * 100)}%
            </span>
            <button
              type="button"
              onClick={() => applyZoom(zoom * 1.5)}
              disabled={zoom >= 8}
              title="放大"
              className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/15 disabled:opacity-40"
            >
              <ZoomInIcon className="size-4" />
            </button>
            <div className="mx-1 h-4 w-px bg-white/25" />
            {/* 旋转时回到适配态并自动补缩小系数，整图始终完整可见 */}
            <button
              type="button"
              onClick={() => {
                applyZoom(1);
                setRotate((r) => (r + 90) % 360);
              }}
              title="向右旋转 90°"
              className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/15"
            >
              <RotateCwIcon className="size-4" />
            </button>
            {downloadName ? (
              <>
                <div className="mx-1 h-4 w-px bg-white/25" />
                <a
                  href={src}
                  download={downloadName}
                  title="存储到本地"
                  className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/15"
                >
                  <DownloadIcon className="size-4" />
                </a>
              </>
            ) : null}
          </div>
          {/* 关闭钮放右上角：左上角是 macOS 悬浮红绿灯的位置，放左会被挡住 */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="关闭预览"
            className="bg-black/55 hover:bg-black/75 fixed top-4 right-4 z-10 flex size-9 items-center justify-center rounded-full text-white transition-colors"
          >
            <XIcon className="size-4" />
          </button>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
};