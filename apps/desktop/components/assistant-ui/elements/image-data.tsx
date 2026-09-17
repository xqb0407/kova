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
import { type FC, useState } from "react";
import { DownloadIcon, ImageIcon, Maximize2Icon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/artifacts";
import type { PiImagePartData } from "@/lib/pi-bridge";

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
          <Maximize2Icon className="size-3" />
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
        <a
          href={src}
          download={fileName}
          title="保存图片到本地"
          className="hover:bg-muted hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5"
        >
          <DownloadIcon className="size-3.5" />
          保存
        </a>
      </div>
      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent className="max-w-[min(92vw,1100px)]">
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <img
            src={src}
            alt={label}
            className="mx-auto max-h-[82vh] max-w-full rounded-lg object-contain"
          />
          <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">
              {label}
              {typeof data.bytes === "number" && data.bytes > 0
                ? ` · ${formatBytes(data.bytes)}`
                : ""}
            </span>
            <a
              href={src}
              download={fileName}
              className="hover:text-foreground inline-flex shrink-0 items-center gap-1"
            >
              <DownloadIcon className="size-3.5" />
              保存
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/** 与 CompactionDataUI 同法挂载（thread.tsx 消息流根部），自身不占渲染位 */
export const ImageDataUI = makeAssistantDataUI<PiImagePartData>({
  name: "image",
  render: ImagePartCard,
});
