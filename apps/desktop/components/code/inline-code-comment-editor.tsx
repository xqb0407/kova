"use client";

/**
 * 行下内联评论编辑器（GitHub review 同款）：由 CodeMirror block widget /
 * @pierre/diffs line annotation 渲染在目标行下方，随代码一起滚动，不再用
 * fixed 浮层。提交失败（composer 未就绪）时保持输入与编辑器。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";

export type InlineCodeCommentEditorProps = {
  pathLabel?: string;
  startLine: number;
  endLine: number;
  deleted?: boolean;
  /** 返回 false = 插入失败，编辑器保持打开 */
  onSubmit: (comment: string) => boolean;
  onCancel: () => void;
};

export const InlineCodeCommentEditor: FC<InlineCodeCommentEditorProps> = ({
  pathLabel,
  startLine,
  endLine,
  deleted = false,
  onSubmit,
  onCancel,
}) => {
  const t = useT();
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rangeLabel =
    startLine === endLine
      ? t("chat.codeComment.line", { line: startLine })
      : t("chat.codeComment.range", { start: startLine, end: endLine });

  useEffect(() => {
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = () => {
    const comment = value.trim();
    if (!comment) return;
    if (onSubmit(comment)) setValue("");
  };

  return (
    <div
      data-slot="inline-code-comment-editor"
      role="dialog"
      aria-label={`${pathLabel ? `${pathLabel} · ` : ""}${rangeLabel}`}
      // 编辑器在 CodeMirror content / diff 行内：别让外层把点击当成选区操作
      onMouseDown={(event) => event.stopPropagation()}
      className="bg-background relative z-10 my-1.5 w-full rounded-lg border p-2 shadow-sm"
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder={deleted ? `${t("chat.codeComment.deleted")} · ${rangeLabel}` : rangeLabel}
        rows={3}
        className="max-h-48 min-h-24 resize-none text-sm"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {t("chat.codeComment.submitHint")}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={onCancel}
          >
            {t("chat.codeComment.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={!value.trim()}
            onClick={submit}
          >
            {t("chat.codeComment.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default InlineCodeCommentEditor;
