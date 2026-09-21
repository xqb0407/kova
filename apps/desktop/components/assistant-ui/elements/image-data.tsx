"use client";

/**
 * 对话内工具图片渲染（设计：docs/image-part-design.md）。
 * sidecar 把工具结果的 image 块投影为 data-image part（直播 chunk / get_history
 * 同构，闸门单点在 image-parts.ts），这里按名认领渲染：
 * 与 data-compaction 同款机制——makeAssistantDataUI 注册、assistant-message.tsx
 * 的 case "data" 转发 dataRendererUI，本组件崩了不允许带走整条 thread，
 * 一切非预期形状（脏历史/伪造 src/白名单外类型）都降级为占位行。
 */
import { makeAssistantDataUI } from "@assistant-ui/react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { type FC, useEffect, useRef, useState } from "react";
import {
  DownloadIcon,
  ImageIcon,
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
import { formatBytes } from "@/lib/panels/artifacts";
import type { PiImagePartData } from "@/lib/pi/pi-bridge";

/**
 * 与 sidecar image-parts.ts 白名单同步的展示侧护栏。双保险：投影侧已过滤，
 * 但历史脏数据/旧转录不经过新代码，这里再挡一道（svg 等矢量格式可含外链，
 * 拒绝内联上屏）。
 */
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 保存文件名：alt/toolName 清洗成安全串 + mime 对应扩展名 */
function fileNameFor(data: Partial<PiImagePartData>): string {
  const base =
    (data.alt || data.toolName || "image")
      .replace(/[\\/:*?"<>|\n\r]/g, "_")
      .slice(0, 48)
      .trim() || "image";
  return `${base}.${EXT_BY_MIME[data.mimeType ?? ""] ?? "img"}`;
}

const ImagePartCard: FC<{ data: PiImagePartData }> = ({ data }) => {
  const [zoomed, setZoomed] = useState(false);
  // Quick Look 式预览状态:zoom=1 适配视口，>1 可拖拽平移；rotate 90°步进，
  // 旋转时自动重新适配让整图始终可见（Apple 行为）
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(
    null,
  );

  useEffect(() => {
    // 每次打开回到适配态:上一张的缩放/旋转不带到下一张
    if (zoomed) {
      setZoom(1);
      setRotate(0);
      setOffset({ x: 0, y: 0 });
    }
  }, [zoomed]);

  const applyZoom = (z: number) => {
    const clamped = Math.min(8, Math.max(1, z));
    setZoom(clamped);
    // 回到适配态时平移复位
    if (clamped === 1) setOffset({ x: 0, y: 0 });
  };

  // 滚轮缩放(以 1.2 倍步进,向上滚放大)
  const onPreviewWheel = (e: React.WheelEvent) => {
    applyZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  };

  // 旋转后重新适配:90°/270° 时旋转包围盒与视口互换,需要补一个缩小系数。
  // 用自然尺寸 + 视口估算 zoom=1 时的适配宽高(与 max-h-[86vh]/max-w-[90vw]
  // 的 contain 结果一致),再算旋转后包围盒放得下的额外 scale
  const rotated = rotate % 180 !== 0;
  const extraFit = (() => {
    if (!rotated || !natural || zoom !== 1) return 1;
    const vw = window.innerWidth * 0.9;
    const vh = window.innerHeight * 0.86;
    const fitW = Math.min(vw, (vh * natural.w) / natural.h);
    const fitH = Math.min(vh, (vw * natural.h) / natural.w);
    return Math.min(1, vh / fitW, vw / fitH);
  })();

  const onImgPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
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

  const onImgPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const st = dragRef.current;
    if (!st) return;
    setOffset({
      x: st.ox + (e.clientX - st.px),
      y: st.oy + (e.clientY - st.py),
    });
  };

  const onImgPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const src = typeof data?.src === "string" ? data.src : "";
  const mime = typeof data?.mimeType === "string" ? data?.mimeType : "";
  // 只认投影侧产生的内联 data URL（P1 引用式上屏时在此扩展前缀分支）
  const ok = src.startsWith("data:") && ALLOWED_MIME.has(mime);
  const label = data?.alt || data?.toolName || "图片";
  if (!ok) {
    return (
      <div
        data-slot="aui_image-part-invalid"
        className="text-muted-foreground my-1.5 inline-flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs"
      >
        <ImageIcon className="size-3.5 shrink-0" />
        图片无法显示
        {mime ? <span className="font-mono">（{mime}）</span> : null}
      </div>
    );
  }
  const fileName = fileNameFor(data);
  return (
    <div data-slot="aui_image-part" className="my-1.5 flex max-w-full flex-col gap-1">
      <button
        type="button"
        onClick={() => setZoomed(true)}
        title="点击查看大图"
        className="bg-muted/40 group relative block w-fit cursor-zoom-in overflow-hidden rounded-xl border focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
      >
        {/* lazy：长会话多图的解码压力推入视口再说；大图放大态挂在 Dialog 里延迟加载 */}
        <img
          src={src}
          alt={label}
          loading="lazy"
          className="block max-h-64 max-w-full object-contain"
        />
        <span className="absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <ZoomInIcon className="size-3" />
          {typeof data.bytes === "number" && data.bytes > 0
            ? formatBytes(data.bytes)
            : "放大"}
        </span>
      </button>
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
        <span className="max-w-[28rem] truncate" title={label}>
          {label}
        </span>
        {data.toolName ? (
          <span className="shrink-0 font-mono opacity-70">{data.toolName}</span>
        ) : null}
      </div>
      {/* Apple「快速查看」式预览：全屏遮罩（与 Dialog 同款 bg-black/10）+
          透明 Popup，无卡片壳。滚轮/按钮缩放、拖拽平移、90° 旋转（自动
          重新适配），双击在适配与 2× 间切换，点空白关闭。transform 实现
          缩放旋转（不改布局），Popup 用 overflow-hidden 防止 transform
          溢出产生滚动条，平移靠 translate 不靠滚动 */}
      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Popup
            className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 flex overflow-hidden p-8 duration-150 outline-none"
            onWheel={onPreviewWheel}
            onClick={(e) => {
              // 点空白关闭：落在图片/工具栏上的点击不关
              if (!(e.target as HTMLElement).closest("img,button,a"))
                setZoomed(false);
            }}
          >
         
            <DialogTitle className="sr-only">{label}
            </DialogTitle>
            <img
              src={src}
              alt={label}
              draggable={false}
              onLoad={(e) =>
                setNatural({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
              }
              onPointerDown={onImgPointerDown}
              onPointerMove={onImgPointerMove}
              onPointerUp={onImgPointerUp}
              onDoubleClick={() => applyZoom(zoom === 1 ? 2 : 1)}
              className={cn(
                "m-auto max-h-[86vh] max-w-[90vw] select-none rounded-lg object-contain shadow-2xl",
                dragging ? "" : "transition-transform duration-200 ease-out",
              )}
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
              <div className="mx-1 h-4 w-px bg-white/25" />
              <a
                href={src}
                download={fileName}
                title="存储到本地"
                className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-white/15"
              >
                <DownloadIcon className="size-4" />
              </a>
            </div>
            {/* 关闭钮放右上角：左上角是 macOS 悬浮红绿灯的位置，放左会被挡住 */}
            <button
              type="button"
              onClick={() => setZoomed(false)}
              title="关闭预览"
              className="bg-black/55 hover:bg-black/75 fixed top-4 right-4 z-10 flex size-9 items-center justify-center rounded-full text-white transition-colors"
            >
              <XIcon className="size-4" />
            </button>
          </DialogPrimitive.Popup>
        </DialogPortal>
      </Dialog>
    </div>
  );
};

/** 与 CompactionDataUI 同法挂载（thread.tsx 消息流根部），自身不占渲染位 */
export const ImageDataUI = makeAssistantDataUI<PiImagePartData>({
  name: "image",
  render: ImagePartCard,
});
