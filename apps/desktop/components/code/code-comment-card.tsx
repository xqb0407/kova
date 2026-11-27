"use client";

/**
 * 已提交、待发送的代码评论卡片：挂在评论范围末行下方（CodeMirror block
 * widget / diff annotation）。与输入框芯片共用 code-comment-store，删除
 * 卡片时会同步移除芯片。
 */
import type { FC } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { CodeCommentEntry } from "@/lib/composer/code-comment-store";
import { useCodeCommentMaxWidth } from "./use-code-comment-width";

export const CodeCommentCard: FC<{
  entry: CodeCommentEntry;
  onDelete: (id: string) => void;
}> = ({ entry, onDelete }) => {
  const t = useT();
  // 长行不换行时注解容器会被撑到整条横向滚动宽度，卡片按可见宽度收住
  const { ref, maxWidth } = useCodeCommentMaxWidth<HTMLDivElement>();
  const rangeLabel =
    entry.startLine === entry.endLine
      ? t("chat.codeComment.cardLine", { line: entry.startLine })
      : t("chat.codeComment.cardRange", {
          start: entry.startLine,
          end: entry.endLine,
        });

  return (
    <div
      ref={ref}
      data-slot="code-comment-card"
      data-comment-id={entry.id}
      className="bg-background/70 my-1.5 rounded-lg border border-border/50 p-3"
      style={maxWidth ? { maxWidth } : undefined}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{rangeLabel}</span>
        {entry.deleted ? (
          <span className="text-amber-600 dark:text-amber-400">
            · {t("chat.codeComment.deleted")}
          </span>
        ) : null}
      </div>
      {entry.comment ? (
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {entry.comment}
        </div>
      ) : null}
      <div className="mt-1 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
          onClick={() => onDelete(entry.id)}
        >
          <Trash2Icon className="size-3.5" />
          {t("chat.codeComment.delete")}
        </Button>
      </div>
    </div>
  );
};
