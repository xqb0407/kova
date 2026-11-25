"use client";

/**
 * 代码行评论浮层（文件视图与 Git diff 共用）。
 *
 * 由「行号槽悬停 +」或 diff 的 gutter utility 触发：挂在 body 的 fixed
 * portal 上（面板里若有 transform 动画，fixed 的定位基准会漂），锚点为
 * 点击/拖动结束时的视口坐标，挂载后按实际尺寸夹取进视口。
 *
 * 提交失败（输入框未就绪）时由宿主返回 false：这里不关浮层、不清输入，
 * 避免用户刚写的评论被 toast 吞掉。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type CodeCommentAnchor = { x: number; y: number };

export type CodeCommentEditorProps = {
  /** 浮层标题里的文件展示名（通常 basename；可省） */
  pathLabel?: string;
  startLine: number;
  endLine: number;
  /** diff 删除侧：行号对应旧文件，标题明确标出来 */
  deleted?: boolean;
  /** 视口坐标：点击/拖动结束点 */
  anchor: CodeCommentAnchor;
  /** 返回 false = 插入失败（输入框未就绪），浮层保持打开 */
  onSubmit: (comment: string) => boolean;
  onCancel: () => void;
};

const EDITOR_WIDTH = 340;
/** 估算高度只在首帧夹取时用；挂载后按真实 rect 再校正一次 */
const EDITOR_ESTIMATED_HEIGHT = 196;
const VIEWPORT_GAP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 锚点 → 首帧位置：优先打开在点击点右下方，放不下就翻到上方/左侧 */
function initialPosition(anchor: CodeCommentAnchor) {
  if (typeof window === "undefined") {
    return { left: VIEWPORT_GAP, top: VIEWPORT_GAP };
  }
  const left = clamp(
    anchor.x + 10,
    VIEWPORT_GAP,
    window.innerWidth - EDITOR_WIDTH - VIEWPORT_GAP,
  );
  const below = anchor.y + 10;
  const top =
    below + EDITOR_ESTIMATED_HEIGHT <= window.innerHeight - VIEWPORT_GAP
      ? below
      : clamp(
          anchor.y - EDITOR_ESTIMATED_HEIGHT - 10,
          VIEWPORT_GAP,
          window.innerHeight - EDITOR_ESTIMATED_HEIGHT - VIEWPORT_GAP,
        );
  return { left, top };
}

export const CodeCommentEditor: FC<CodeCommentEditorProps> = ({
  pathLabel,
  startLine,
  endLine,
  deleted = false,
  anchor,
  onSubmit,
  onCancel,
}) => {
  const t = useT();
  const [value, setValue] = useState("");
  const [position, setPosition] = useState(() => initialPosition(anchor));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 首帧已由 useState/useLayoutEffect 定位；仅锚点变化时重新计算 */
  const anchorKeyRef = useRef(`${anchor.x}:${anchor.y}`);

  const rangeLabel =
    startLine === endLine
      ? t("chat.codeComment.line", { line: startLine })
      : t("chat.codeComment.range", { start: startLine, end: endLine });

  const submit = useCallback(() => {
    const comment = value.trim();
    if (!comment) return;
    // 宿主 false = 插入失败：保留浮层与草稿
    if (onSubmit(comment)) setValue("");
  }, [onSubmit, value]);

  // 挂载后按真实尺寸夹进视口（首帧估算可能偏小/偏大）
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const left = clamp(
      rect.left,
      VIEWPORT_GAP,
      window.innerWidth - rect.width - VIEWPORT_GAP,
    );
    const top = clamp(
      rect.top,
      VIEWPORT_GAP,
      window.innerHeight - rect.height - VIEWPORT_GAP,
    );
    if (left !== rect.left || top !== rect.top) setPosition({ left, top });
  }, []);

  // 焦点落到输入框（rAF：portal 首帧布局完成后再 focus）
  useEffect(() => {
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // 同一实例被复用到新锚点（不经过卸载）时也要挪位置；首帧跳过，
  // 避免覆盖 useLayoutEffect 按真实尺寸做的夹取结果。
  useEffect(() => {
    const key = `${anchor.x}:${anchor.y}`;
    if (anchorKeyRef.current === key) return;
    anchorKeyRef.current = key;
    setPosition(initialPosition(anchor));
  }, [anchor.x, anchor.y]);

  // Esc 取消 / 浮层外按下取消 / 面板滚动或窗口缩放时收起——
  // 浮层是 fixed 坐标，不跟随代码滚动，继续挂着会指向错误位置。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      onCancel();
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      // 输入框内部滚动不关（长评论换行滚动很常见）
      if (target && rootRef.current?.contains(target)) return;
      onCancel();
    };
    const onResize = () => onCancel();

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onCancel]);

  const overlay = (
    <div
      ref={rootRef}
      data-slot="code-comment-editor"
      role="dialog"
      aria-label={t("chat.codeComment.add")}
      className={cn(
        "bg-popover text-popover-foreground fixed z-[60] flex flex-col gap-2 rounded-xl border p-3 shadow-xl",
      )}
      style={{ left: position.left, top: position.top, width: EDITOR_WIDTH }}
      // 浮层内的 mousedown 不应被外层（CodeMirror / diff）当成点击
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquarePlus className="size-3.5 shrink-0" />
        {pathLabel ? (
          <span className="min-w-0 truncate font-medium" title={pathLabel}>
            {pathLabel}
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums">{rangeLabel}</span>
        {deleted ? (
          <span className="shrink-0 text-amber-600 dark:text-amber-400">
            · {t("chat.codeComment.deleted")}
          </span>
        ) : null}
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        placeholder={t("chat.codeComment.placeholder")}
        rows={3}
        className="max-h-40 min-h-20 resize-none text-sm"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
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
          className="h-7 px-2.5 text-xs"
          disabled={!value.trim()}
          onClick={submit}
        >
          {t("chat.codeComment.submit")}
        </Button>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};

export default CodeCommentEditor;
