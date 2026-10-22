"use client";

/**
 * 分享预览与导出弹窗。
 *
 * 预览直接用最终产物 HTML（iframe srcDoc + sandbox），因此「看到什么就导出
 * 什么」；图片由主进程用同一份 HTML 渲染截图，网页则原样写盘。
 * 打开时冻结消息快照：分享是一份快照，不跟随流式更新变化。
 */
import { useAuiState, type ThreadMessageLike } from "@assistant-ui/react";
import { DownloadIcon, ImageIcon, LinkIcon } from "lucide-react";
import { useMemo, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { save as saveDialog } from "@/desktop-bridge/plugin-dialog";
import { writeTextFile } from "@/desktop-bridge/plugin-fs";
import { openSharePath, renderShareImage } from "@/desktop-bridge/share";
import { isDesktop } from "@/lib/desktop-env";
import { useThreadTitle } from "@/lib/pi/pi-thread-titles";
import { buildShareDoc } from "@/lib/share/share-doc";
import {
  buildShareHtml,
  collectShareTheme,
} from "@/lib/share/share-html";
import { docToMarkdown } from "@/lib/share/share-markdown";

type BusyKind = "image" | "copy-image" | "html" | "markdown" | null;

const pad2 = (n: number): string => String(n).padStart(2, "0");

const fileStem = (title: string): string => {
  const clean = title
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  const d = new Date();
  return `${clean || "对话"}-分享-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};

const ensureExtension = (path: string, extension: string): string =>
  path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;

const downloadBlob = (content: string, filename: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noreferrer";
    anchor.click();
  } finally {
    // 浏览器在 click 后异步取流，稍后再释放
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

export const ShareDialog: FC<{
  onClose: () => void;
  selected: ReadonlySet<string>;
}> = ({ onClose, selected }) => {
  // 弹窗只在打开时挂载：这里的首次快照就是分享内容
  const liveMessages = useAuiState((s) => s.thread.messages);
  const [messages] = useState<readonly ThreadMessageLike[]>(() => liveMessages);
  const [createdAt] = useState(() => Date.now());
  const [includeReasoning, setIncludeReasoning] = useState(false);
  // 工具调用默认带上：大折叠（轮过程）里纯工具的中间消息不带工具就整条消失，
  // 分享出来会缺掉一大段工作记录
  const [includeTools, setIncludeTools] = useState(true);
  const [busy, setBusy] = useState<BusyKind>(null);
  // 主题跟随应用当前外观（弹窗每次打开重新收集，深浅色/强调色即时生效）
  const theme = useMemo(() => collectShareTheme(), []);

  const mainThread = useAuiState((s) => {
    const id = s.threads.mainThreadId;
    return s.threads.threadItems.find((item) => item.id === id);
  });
  const liveTitle = useThreadTitle(mainThread?.remoteId);
  const title = liveTitle ?? mainThread?.title ?? "对话";

  const doc = useMemo(
    () =>
      buildShareDoc(messages, selected, {
        title,
        createdAt,
        includeReasoning,
        includeTools,
      }),
    [messages, selected, title, createdAt, includeReasoning, includeTools],
  );
  const html = useMemo(
    () => buildShareHtml(doc, { tokens: theme.tokens, colorScheme: theme.colorScheme }),
    [doc, theme],
  );
  const markdown = useMemo(() => docToMarkdown(doc), [doc]);
  const desktop = isDesktop();
  const hasContent = doc.messages.length > 0;

  const run = async (kind: Exclude<BusyKind, null>, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      toast.add({
        title: "分享失败",
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const saveImage = () =>
    run("image", async () => {
      const path = await saveDialog({
        title: "保存分享图片",
        defaultPath: `${fileStem(title)}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) return;
      const target = ensureExtension(path, "png");
      const result = await renderShareImage({
        html,
        width: 900,
        scale: 2,
        savePath: target,
      });
      toast.add({
        title: "已保存分享图片",
        description: `${result.width}×${result.height} · ${target}`,
        type: "success",
        action: {
          label: "打开",
          onClick: () => {
            void openSharePath(target).catch(() => undefined);
          },
        },
      });
    });

  const copyImage = () =>
    run("copy-image", async () => {
      await renderShareImage({ html, width: 900, scale: 2, copy: true });
      toast.add({ title: "分享图片已复制到剪贴板", type: "success" });
    });

  const saveHtml = () =>
    run("html", async () => {
      const filename = `${fileStem(title)}.html`;
      if (!desktop) {
        downloadBlob(html, filename, "text/html;charset=utf-8");
        toast.add({ title: "分享网页已下载", description: filename, type: "success" });
        return;
      }
      const path = await saveDialog({
        title: "保存分享网页",
        defaultPath: filename,
        filters: [{ name: "HTML 网页", extensions: ["html"] }],
      });
      if (!path) return;
      const target = ensureExtension(path, "html");
      await writeTextFile(target, html);
      toast.add({
        title: "已保存分享网页",
        description: target,
        type: "success",
        action: {
          label: "打开",
          onClick: () => {
            void openSharePath(target).catch(() => undefined);
          },
        },
      });
    });

  const copyMarkdown = () =>
    run("markdown", async () => {
      await navigator.clipboard.writeText(markdown);
      toast.add({ title: "Markdown 已复制", type: "success" });
    });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>分享对话</DialogTitle>
          <DialogDescription>
            预览即最终效果，只包含所选消息里可分享的正文。
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted/30 overflow-hidden rounded-xl border">
          <iframe
            title="分享预览"
            srcDoc={html}
            sandbox=""
            className="h-[48vh] min-h-64 w-full bg-white"
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
            <Switch
              size="sm"
              checked={includeReasoning}
              onCheckedChange={setIncludeReasoning}
            />
            包含思考过程
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
            <Switch
              size="sm"
              checked={includeTools}
              onCheckedChange={setIncludeTools}
            />
            包含工具调用
          </label>
          <span className="text-muted-foreground ml-auto text-xs">
            主题跟随应用当前外观
          </span>
        </div>

        <DialogFooter className="flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-auto text-xs">
            {hasContent
              ? `已选 ${selected.size} 条 · 导出 ${doc.messages.length} 条消息`
              : "这些消息没有可分享的正文"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasContent || busy !== null}
            onClick={() => void copyMarkdown()}
          >
            {busy === "markdown" ? "复制中…" : "复制 Markdown"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasContent || busy !== null}
            onClick={() => void saveHtml()}
          >
            <LinkIcon className="size-3.5" />
            {busy === "html" ? "导出中…" : desktop ? "保存网页" : "下载网页"}
          </Button>
          {desktop && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasContent || busy !== null}
                onClick={() => void copyImage()}
              >
                <ImageIcon className="size-3.5" />
                {busy === "copy-image" ? "生成中…" : "复制图片"}
              </Button>
              <Button
                size="sm"
                disabled={!hasContent || busy !== null}
                onClick={() => void saveImage()}
              >
                <DownloadIcon className="size-3.5" />
                {busy === "image" ? "生成中…" : "保存图片"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
