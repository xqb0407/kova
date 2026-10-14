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
import { blobUrlFor, ensureThumb, getThumb } from "@/lib/pi/image-blob-url";
import { type FC, useEffect, useMemo, useState } from "react";
import { ImageIcon, ZoomInIcon } from "lucide-react";
import { ImageQuickLook } from "@/components/assistant-ui/elements/image-quick-look";
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

/**
 * 导出供图廊复用：assistant-message.tsx 的并发成图平铺直接渲染本卡片。
 * compact=画廊瓦片模式：图撑满格宽、外边距归零、题注行不渲染
 * （信息并入画廊自绘的 headline，别用后代选择器去压——Tailwind 会把
 * 任意选择器里 data-slot 值的下划线转成空格，产出非法 CSS）。
 */
export const ImagePartCard: FC<{ data: PiImagePartData; compact?: boolean }> = ({
  data,
  compact,
}) => {
  const [zoomed, setZoomed] = useState(false);

  const src = typeof data?.src === "string" ? data.src : "";
  // DOM 里不挂 base64：data URL → Blob URL（实测 DOM 上曾驻留 6.5MB base64，
  // 换来 fps 6.0。见 lib/pi/image-blob-url.ts 的说明）
  const blobSrc = useMemo(() => blobUrlFor(src), [src]);
  // 瓦片用缩略图：只显示一两百像素却在解码全尺寸图，实测绘制段 258ms、fps 9-18
  // ——换成缩略图后绘制像素量差上百倍，解码那一次也在主线程外且只做一次。
  // 拿不到就继续用原图：优化绝不允许把图弄没。
  const [thumbSrc, setThumbSrc] = useState<string | undefined>(() => getThumb(src));
  useEffect(() => {
    setThumbSrc(getThumb(src));
    let alive = true;
    void ensureThumb(src).then((url) => {
      if (alive && url) setThumbSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [src]);
  const tileSrc = thumbSrc ?? blobSrc;
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
    <div
      data-slot="aui_image-part"
      className={cn("flex max-w-full flex-col gap-1", !compact && "my-1.5")}
    >
      <button
        type="button"
        onClick={() => setZoomed(true)}
        title="点击查看大图"
        className={cn(
          " group relative block cursor-zoom-in  rounded-xl  focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
          compact ? "w-full  max-h-64" : "w-fit max-h-64",
        )}
      >
        {/* lazy：长会话多图的解码压力推入视口再说；大图放大态挂在 Dialog 里延迟加载 */}
        <img
          src={tileSrc}
          // decoding="async"：把解码挪出主线程（WebKit 会照做）——这是 Chrome 在这类
          // 页面上比 WKWebView 快的核心差别之一，而不是什么 GPU 开关
          decoding="async"
          loading="lazy"
          alt={label}
          className={cn(
            "block max-h-64 max-w-full object-cover",
            compact && "h-auto w-full",
          )}
        />
        <span className="absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <ZoomInIcon className="size-3" />
          {typeof data.bytes === "number" && data.bytes > 0
            ? formatBytes(data.bytes)
            : "放大"}
        </span>
      </button>
      {!compact && (
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          <span className="max-w-[28rem] truncate" title={label}>
            {label}
          </span>
          {data.toolName ? (
            <span className="shrink-0 font-mono opacity-70">{data.toolName}</span>
          ) : null}
        </div>
      )}
      {/* Apple「快速查看」式预览：与附件预览共用 image-quick-look.tsx */}
      <ImageQuickLook
        open={zoomed}
        onOpenChange={setZoomed}
        src={blobSrc}
        alt={label}
        downloadName={fileName}
      />
    </div>
  );
};

/** 与 CompactionDataUI 同法挂载（thread.tsx 消息流根部），自身不占渲染位 */
export const ImageDataUI = makeAssistantDataUI<PiImagePartData>({
  name: "image",
  render: ImagePartCard,
});
