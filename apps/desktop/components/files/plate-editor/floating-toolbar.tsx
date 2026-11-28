"use client";

/**
 * Plate 选中文字浮动工具栏（Notion 式）：
 * 加粗/斜体/下划线/删除线/行内代码 + 链接输入。
 * 链接输入框在工具栏内部展开，编辑期间强制保持工具栏可见。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  flip,
  offset,
  useFloatingToolbar,
  useFloatingToolbarState,
} from "@platejs/floating";
import { KEYS } from "platejs";
import {
  useEditorId,
  useEditorRef,
  useEditorSelector,
  useEventEditorValue,
  useMarkToolbarButton,
  useMarkToolbarButtonState,
  useSelectionVersion,
} from "platejs/react";
import { unwrapLink, upsertLink, validateUrl } from "@platejs/link";
import {
  BoldIcon,
  Code2Icon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  UnlinkIcon,
} from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BlockTypePicker } from "./pickers";

/** 链接归一化：裸域名补 https，相对路径/锚点原样 */
export function normalizeHref(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (/^(?:[a-z][a-z0-9+.-]*:|\.{0,2}\/)/i.test(value)) return value;
  if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) {
    return value;
  }
  return `https://${value}`;
}

function ToolButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={Boolean(pressed)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
            className={cn(
              "text-muted-foreground hover:bg-hover hover:text-foreground inline-flex size-7 items-center justify-center rounded-md transition-colors",
              pressed && "bg-selected text-foreground",
            )}
          >
            {children}
          </button>
        }
      />
      {/* 浮动工具栏悬在选区上方：气泡朝上，不盖住选中的文字 */}
      <TooltipContent side="top">
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function MarkButton({
  nodeType,
  label,
  children,
}: {
  nodeType: string;
  label: string;
  children: ReactNode;
}) {
  const state = useMarkToolbarButtonState({ nodeType });
  const { props } = useMarkToolbarButton(state);
  return (
    <ToolButton
      label={label}
      pressed={props.pressed}
      onClick={() => props.onClick()}
    >
      {children}
    </ToolButton>
  );
}

export function PlateFloatingToolbar({ searching }: { searching?: boolean }) {
  const editor = useEditorRef();
  const t = useT();
  const editorId = useEditorId();
  const focusedEditorId = useEventEditorValue("focus");
  const selectionVersion = useSelectionVersion();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const floatingState = useFloatingToolbarState({
    editorId,
    // 链接输入框获得焦点时编辑器会失焦，这里保持工具栏可见
    focusedEditorId: linkOpen ? editorId : focusedEditorId,
    hideToolbar: searching,
    floatingOptions: {
      middleware: [offset(10), flip({ padding: 12 })],
      placement: "top",
    },
  });
  const { hidden, props, ref, clickOutsideRef } =
    useFloatingToolbar(floatingState);

  const linkedUrl = useMemo(() => {
    if (!editor.selection) return "";
    const entry = editor.api.node({
      match: { type: editor.getType(KEYS.link) },
    });
    if (!entry) return "";
    const [node] = entry;
    return typeof node.url === "string" ? node.url : "";
  }, [editor, selectionVersion]);

  const blockType = useEditorSelector((current) => {
    const entry = current.api.block();
    return (entry?.[0].type as string) ?? KEYS.p;
  }, []);

  const changeBlock = (type: string) => {
    if (!editor.selection) return;
    const entry = editor.api.block();
    if (!entry) return;
    editor.tf.setNodes({ type }, { at: entry[1] });
    editor.tf.focus();
  };

  useEffect(() => {
    setLinkOpen(false);
  }, [selectionVersion]);

  useEffect(() => {
    if (!linkOpen) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [linkOpen]);

  const openLink = () => {
    setLinkValue(linkedUrl);
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = normalizeHref(linkValue);
    if (!url) return;
    if (!validateUrl(editor, url)) {
      toast.error(t("library.editor.bubble.linkInvalid"));
      return;
    }
    editor.tf.focus();
    upsertLink(editor, { url });
    setLinkOpen(false);
  };

  const removeLink = () => {
    if (!linkedUrl) return;
    unwrapLink(editor);
    editor.tf.focus();
    setLinkOpen(false);
  };

  if (hidden) return null;

  return (
    <div ref={clickOutsideRef}>
      <div
        {...props}
        ref={ref}
        data-kova-plate-floating="true"
        className="bg-popover text-popover-foreground border-border absolute z-50 flex max-w-[80vw] items-center gap-0.5 overflow-x-auto rounded-lg border p-1 whitespace-nowrap shadow-md print:hidden"
      >
        {linkOpen ? (
          <div className="flex items-center gap-1 px-1">
            <input
              ref={inputRef}
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setLinkOpen(false);
                }
              }}
              placeholder={t("library.editor.bubble.linkPlaceholder")}
              className="border-border bg-background h-7 w-56 rounded-md border px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
            <button
              type="button"
              onClick={applyLink}
              className="text-primary hover:bg-hover h-7 rounded-md px-2 text-xs font-medium"
            >
              {t("library.editor.bubble.linkApply")}
            </button>
            {linkedUrl ? (
              <ToolButton
                label={t("library.editor.bubble.linkRemove")}
                onClick={removeLink}
              >
                <UnlinkIcon className="size-3.5" />
              </ToolButton>
            ) : null}
          </div>
        ) : (
          <>
            <BlockTypePicker value={blockType} onChange={changeBlock} />
            <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
            <MarkButton nodeType={KEYS.bold} label={t("library.editor.bubble.bold")}>
              <BoldIcon className="size-3.5" />
            </MarkButton>
            <MarkButton
              nodeType={KEYS.italic}
              label={t("library.editor.bubble.italic")}
            >
              <ItalicIcon className="size-3.5" />
            </MarkButton>
            <MarkButton
              nodeType={KEYS.strikethrough}
              label={t("library.editor.bubble.strike")}
            >
              <StrikethroughIcon className="size-3.5" />
            </MarkButton>
            <MarkButton
              nodeType={KEYS.code}
              label={t("library.editor.bubble.code")}
            >
              <Code2Icon className="size-3.5" />
            </MarkButton>
            <span className="bg-border mx-0.5 h-4 w-px" aria-hidden />
            <ToolButton
              label={t("library.editor.bubble.link")}
              pressed={Boolean(linkedUrl)}
              onClick={openLink}
            >
              <LinkIcon className="size-3.5" />
            </ToolButton>
          </>
        )}
      </div>
    </div>
  );
}
