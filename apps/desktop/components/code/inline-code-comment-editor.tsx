"use client";

/**
 * 行下内联评论编辑器（GitHub review 同款）：由 CodeMirror block widget /
 * @pierre/diffs line annotation 渲染在目标行下方，随代码一起滚动，不再用
 * fixed 浮层。提交失败（composer 未就绪）时保持输入与编辑器。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { CornerDownLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/desktop-env";

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
  const submitKey = isMacPlatform() ? "⌘" : "Ctrl";
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const rangeLabel =
    startLine === endLine
      ? t("chat.codeComment.line", { line: startLine })
      : t("chat.codeComment.range", { start: startLine, end: endLine });
  const heading = deleted
    ? `${t("chat.codeComment.deleted")} · ${rangeLabel}`
    : startLine === endLine
      ? t("chat.codeComment.cardLine", { line: startLine })
      : t("chat.codeComment.cardRange", { start: startLine, end: endLine });

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
      aria-label={`${pathLabel ? `${pathLabel} · ` : ""}${heading}`}
      // 编辑器在 CodeMirror content / diff 行内：别让外层把点击当成选区操作
      onMouseDown={(event) => event.stopPropagation()}
      className="bg-muted relative z-10 my-1.5 w-full rounded-lg border border-border/70 p-2 shadow-none"
    >
      <div className="text-foreground mb-2 px-0.5 text-sm font-medium">{heading}</div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder={deleted ? `${t("chat.codeComment.deleted")} · ${rangeLabel}` : rangeLabel}
        rows={3}
        className="max-h-48 min-h-24 resize-none border-border/60 bg-background text-sm focus-visible:border-border focus-visible:ring-0"
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
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-xs hover:bg-foreground/10 dark:hover:bg-foreground/15"
          onClick={onCancel}
        >
          {t("chat.codeComment.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1.5 px-3 text-xs"
          disabled={!value.trim()}
          onClick={submit}
        >
          {t("chat.codeComment.submit")}
          <span
            className="flex items-center gap-0.5 text-[10px] opacity-70"
            // 服务端不知道平台，先按 Ctrl 渲染；单字符差异交给 hydration 吸收
            suppressHydrationWarning
          >
            {submitKey}
            <CornerDownLeftIcon className="size-3" />
          </span>
        </Button>
      </div>
    </div>
  );
};

export default InlineCodeCommentEditor;
