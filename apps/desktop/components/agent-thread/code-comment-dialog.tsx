"use client";

/**
 * 评论芯片详情 Dialog（挂在 composer 树里）：监听芯片派发的
 * kova:code-comment-open，从 code-comment-store 取完整评论展示。
 * 芯片本身只显示路径/行号 + 预览，完整正文只在这里出现。
 */
import { useEffect, useState, type FC } from "react";
import { CopyIcon, MessageSquareTextIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import {
  OPEN_CODE_COMMENT_EVENT,
  getCodeComment,
  type CodeCommentEntry,
} from "@/lib/composer/code-comment-store";

function copyText(text: string): void {
  const done = () => toast.add({ title: "已复制评论", type: "success" });
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) done();
    } catch {
      /* 静默失败 */
    }
  };
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

export const CodeCommentDialogHost: FC = () => {
  const t = useT();
  const [entry, setEntry] = useState<CodeCommentEntry | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = String((event as CustomEvent<unknown>).detail ?? "");
      if (!id) return;
      const found = getCodeComment(id);
      if (!found) return;
      setEntry(found);
      setOpen(true);
    };
    window.addEventListener(OPEN_CODE_COMMENT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CODE_COMMENT_EVENT, onOpen);
  }, []);

  const rangeLabel = entry
    ? entry.startLine === entry.endLine
      ? t("chat.codeComment.line", { line: entry.startLine })
      : t("chat.codeComment.range", {
          start: entry.startLine,
          end: entry.endLine,
        })
    : "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg" data-slot="code-comment-dialog">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 font-mono text-sm">
            <MessageSquareTextIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate" title={entry?.path}>
              {entry?.path}
            </span>
          </DialogTitle>
          <DialogDescription>
            {rangeLabel}
            {entry?.deleted
              ? ` · ${t("chat.codeComment.deleted")}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted/30 max-h-72 overflow-auto rounded-lg border px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
          {entry?.comment}
        </div>

        <div className="flex items-center justify-end gap-2">
          {entry?.comment ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={() => copyText(entry.comment)}
            >
              <CopyIcon className="size-3.5" />
              复制
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => setOpen(false)}
          >
            {t("chat.codeComment.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
