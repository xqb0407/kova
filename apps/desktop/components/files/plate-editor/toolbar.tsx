"use client";

/**
 * Plate 编辑器顶部工具栏：
 * 块类型、常用 marks、列表、引用、代码块、表格、分割线、图片、撤销/重做。
 * 对齐官方 plate-ui 的 ToolbarButton 语义：按下鼠标不丢选区。
 */

import type { ReactNode } from "react";
import {
  BoldIcon,
  Code2Icon,
  ImageIcon,
  ItalicIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  QuoteIcon,
  Redo2Icon,
  StrikethroughIcon,
  Table2Icon,
  Undo2Icon,
} from "lucide-react";
import { KEYS, PathApi } from "platejs";
import {
  useEditorRef,
  useEditorSelector,
  useMarkToolbarButton,
  useMarkToolbarButtonState,
} from "platejs/react";
import { ListStyleType, toggleList } from "@platejs/list";
import { insertEmptyCodeBlock } from "@platejs/code-block";
import { TablePlugin } from "@platejs/table/react";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { usePlateEditorBridge } from "./editor-context";
import { BlockTypePicker } from "./pickers";

function ToolButton({
  label,
  pressed,
  onClick,
  children,
  className,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={Boolean(pressed)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "text-muted-foreground hover:bg-hover hover:text-foreground inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs whitespace-nowrap transition-colors",
        pressed && "bg-selected text-foreground",
        className,
      )}
    >
      {children}
    </button>
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

export function PlateToolbar() {
  const editor = useEditorRef();
  const t = useT();
  const { pickImage } = usePlateEditorBridge();
  const blockType = useEditorSelector((current) => {
    const entry = current.api.block();
    return (entry?.[0].type as string) ?? KEYS.p;
  }, []);

  const setBlock = (type: string) => {
    const blockEntry = editor.api.block();
    if (!blockEntry) return;
    const [block, path] = blockEntry;
    const quoteType = editor.getType(KEYS.blockquote);
    const parentEntry = editor.api.parent(path);
    const inQuote = parentEntry?.[0].type === quoteType;

    if (type === quoteType) {
      if (inQuote && parentEntry) {
        // 已在引用里再点引用 = 退出引用
        editor.tf.unwrapNodes({
          at: parentEntry[1],
          match: { type: quoteType },
        });
      } else if (block.type !== quoteType) {
        // 把当前块包进 blockquote，保留 p 子节点（结构合法，markdown 序列化为 >）
        editor.tf.wrapNodes(
          { type: quoteType, children: [] },
          { at: path },
        );
      }
      editor.tf.focus();
      return;
    }

    // 引用里的段落/标题：先脱掉 blockquote，再改成目标块
    if (inQuote && parentEntry) {
      editor.tf.unwrapNodes({
        at: parentEntry[1],
        match: { type: quoteType },
      });
      editor.tf.setNodes({ type }, { at: parentEntry[1] });
      editor.tf.focus();
      return;
    }

    if (block.type !== type) editor.tf.setNodes({ type }, { at: path });
    editor.tf.focus();
  };

  const insertImage = () => {
    if (!pickImage) return;
    void pickImage().then((image) => {
      if (!image) return;
      editor.tf.insertNodes(
        {
          type: KEYS.img,
          url: image.src,
          caption: [{ text: image.alt }],
          children: [{ text: "" }],
        },
        { select: true },
      );
      editor.tf.insertNodes(editor.api.create.block(), {
        select: true,
      });
      editor.tf.focus();
    });
  };

  return (
    <div className="border-border/60 border-b">
      <div className="kova-toolbar-scroll mx-auto flex max-w-[calc(64rem+6rem)] flex-nowrap items-center gap-0.5 overflow-x-auto px-12 py-1.5">
      <BlockTypePicker value={blockType} onChange={setBlock} />
      <span className="bg-border mx-1 h-4 w-px" aria-hidden />
      <MarkButton nodeType={KEYS.bold} label={t("library.editor.bubble.bold")}>
        <BoldIcon className="size-4" />
      </MarkButton>
      <MarkButton nodeType={KEYS.italic} label={t("library.editor.bubble.italic")}>
        <ItalicIcon className="size-4" />
      </MarkButton>
      <MarkButton
        nodeType={KEYS.strikethrough}
        label={t("library.editor.bubble.strike")}
      >
        <StrikethroughIcon className="size-4" />
      </MarkButton>
      <MarkButton nodeType={KEYS.code} label={t("library.editor.bubble.code")}>
        <Code2Icon className="size-4" />
      </MarkButton>
      <span className="bg-border mx-1 h-4 w-px" aria-hidden />
      <ToolButton
        label={t("library.editor.block.bulletList")}
        onClick={() => toggleList(editor, { listStyleType: ListStyleType.Disc })}
      >
        <ListIcon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.block.orderedList")}
        onClick={() =>
          toggleList(editor, { listStyleType: ListStyleType.Decimal })
        }
      >
        <ListOrderedIcon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.block.taskList")}
        onClick={() => toggleList(editor, { listStyleType: KEYS.listTodo })}
      >
        <ListChecksIcon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.block.blockquote")}
        onClick={() => setBlock(KEYS.blockquote)}
      >
        <QuoteIcon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.block.codeBlock")}
        onClick={() => {
          insertEmptyCodeBlock(editor);
          editor.tf.focus();
        }}
      >
        <Code2Icon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.block.table")}
        onClick={() => {
          editor.getTransforms(TablePlugin).insert.table({
            rowCount: 3,
            colCount: 3,
            header: true,
          });
          editor.tf.focus();
        }}
      >
        <Table2Icon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.block.divider")}
        onClick={() => {
          const block = editor.api.block();
          if (!block) return;
          const [, path] = block;
          editor.tf.insertNodes(
            { type: KEYS.hr, children: [{ text: "" }] },
            { at: PathApi.next(path) },
          );
          editor.tf.insertNodes(editor.api.create.block(), {
            at: PathApi.next(PathApi.next(path)),
            select: true,
          });
          editor.tf.focus();
        }}
      >
        <MinusIcon className="size-4" />
      </ToolButton>
      {pickImage ? (
        <ToolButton label={t("library.editor.block.image")} onClick={insertImage}>
          <ImageIcon className="size-4" />
        </ToolButton>
      ) : null}
      <span className="bg-border mx-1 h-4 w-px" aria-hidden />
      <ToolButton
        label={t("library.editor.undo")}
        onClick={() => {
          editor.tf.undo();
          editor.tf.focus();
        }}
      >
        <Undo2Icon className="size-4" />
      </ToolButton>
      <ToolButton
        label={t("library.editor.redo")}
        onClick={() => {
          editor.tf.redo();
          editor.tf.focus();
        }}
      >
        <Redo2Icon className="size-4" />
      </ToolButton>
      </div>
    </div>
  );
}
