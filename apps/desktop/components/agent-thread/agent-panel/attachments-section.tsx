"use client";

import dynamic from "next/dynamic";
import { type FC, type RefObject } from "react";
import { FileIcon, PaperclipIcon } from "lucide-react";
import { extOf } from "@/lib/artifacts";
import { useThreadAttachments, type ThreadAttachment } from "@/lib/thread-attachments";
import { focusPanelTab } from "@/lib/panel-tabs";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CountPill, PanelSection } from "./section-shell";

/** 彩色文件图标（material-file-icons ~1.5MB）按需加载，别拉进面板主 chunk */
const FileTypeIcon = dynamic(
  () => import("./file-type-icon").then((m) => m.FileTypeIcon),
  {
    ssr: false,
    loading: () => <FileIcon className="text-muted-foreground size-8 shrink-0" />,
  },
);

/** 行尾类型小字：扩展名优先，退化取 mediaType 子类型（image/png → PNG） */
function typeLabel(item: ThreadAttachment): string {
  const ext = extOf(item.name);
  if (ext) return ext.toUpperCase();
  return item.mediaType.split("/")[1]?.toUpperCase() || "FILE";
}

/**
 * 引用文件行：文件图标/图片缩略图 + 名称 + 类型小字。
 * - file://（dialog 直选）：点击开浏览器 tab 预览（normalizeUrl 放行 file:）
 * - data: 图片（粘贴）：行内缩略图直接可见，点击灯箱放大
 * - data: 其他（粘贴文档）：内容随会话转录取存，仅展示不可打开
 */
const AttachmentRow: FC<{ item: ThreadAttachment }> = ({ item }) => {
  const isDataImage = item.kind === "image" && item.url.startsWith("data:");
  const isLocal = item.url.startsWith("file://");

  const thumb = isDataImage ? (
    <img
      src={item.url}
      alt={item.name}
      className="border-border/40 size-8 shrink-0 rounded-md border object-cover"
    />
  ) : (
    <FileTypeIcon path={item.name} className="size-8 shrink-0" />
  );

  const body = (
    <>
      {thumb}
      <div className="min-w-0 flex-1">
        <div className="text-foreground/90 truncate text-sm leading-snug">
          {item.name}
        </div>
        <div className="text-muted-foreground/70 mt-0.5 text-[11px]">
          {typeLabel(item)}
          {isDataImage ? " · 点击放大" : isLocal ? " · 点击预览" : ""}
        </div>
      </div>
    </>
  );

  if (isDataImage) {
    return (
      <Dialog>
        <DialogTrigger
          render={
            <button
              type="button"
              className="hover:bg-muted/40 block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors"
              title={item.name}
            >
              {body}
            </button>
          }
        />
        <DialogContent className="w-auto max-w-[90vw] p-2 sm:max-w-3xl">
          <DialogTitle className="sr-only">{item.name}</DialogTitle>
          <img
            src={item.url}
            alt={item.name}
            className="max-h-[80vh] max-w-full rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    );
  }

  if (isLocal) {
    return (
      <button
        type="button"
        title={item.url}
        onClick={() => {
          focusPanelTab("browser", { url: item.url, title: item.name });
          window.dispatchEvent(new Event("agent-panel:open"));
        }}
        className="hover:bg-muted/40 block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors"
      >
        {body}
      </button>
    );
  }

  return (
    <div
      className="block w-full rounded-lg px-2.5 py-1.5"
      title="内容随会话转录取存，可在设置中调整保留策略"
    >
      {body}
    </div>
  );
};

/** 活动面板「引用文件」：当前会话用户上传的图片与文档汇总（按 url 去重）。
 *  无附件时整个 section 不渲染（与 ReferencesSection 的空态语义一致） */
export const AttachmentsSection: FC<{
  /** 外层滚动容器 ref：PanelSection 吸顶判定（IntersectionObserver root） */
  scrollRoot?: RefObject<HTMLElement | null>;
}> = ({ scrollRoot }) => {
  const items = useThreadAttachments();
  if (items.length === 0) return null;
  return (
    <PanelSection
      scrollRoot={scrollRoot}
      icon={<PaperclipIcon className="size-4" />}
      title="引用文件"
      trailing={<CountPill>{items.length}</CountPill>}
    >
      <div className="flex flex-col gap-1.5">
        {items.map((a) => (
          <AttachmentRow key={a.url} item={a} />
        ))}
      </div>
    </PanelSection>
  );
};
