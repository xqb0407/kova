"use client";

/**
 * Plate 斜杠菜单（Notion 式 `/` 唤起）。
 *
 * 与资料库斜杠菜单共用过滤/最近使用逻辑和 i18n 文案，块操作走 Plate API：
 * 删除 `/query` 后对当前块做类型转换/列表切换，或插入分割线、表格、图片。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { createPortal } from "react-dom";
import {
  KEYS,
  PathApi,
  type Path,
  type Point,
  type TRange,
} from "platejs";
import {
  type PlateEditor,
  useEditorRef,
  useEditorVersion,
  useSelectionVersion,
} from "platejs/react";
import { ListStyleType, toggleList } from "@platejs/list";
import { toggleCodeBlock } from "@platejs/code-block";
import { TablePlugin } from "@platejs/table/react";
import {
  Code2Icon,
  Columns2Icon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  LightbulbIcon,
  ListChecksIcon,
  ListCollapseIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  QuoteIcon,
  Table2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  filterSlashItems,
  readRecentSlashIds,
  rememberSlashId,
  SLASH_ITEM_DEFS,
  SLASH_SECTIONS,
  type SlashItemDef,
  type SlashItemId,
  type SlashSection,
} from "@/lib/markdown/slash-items";
import type { InsertedImage } from "./image-upload";
import { usePlateEditorBridge } from "./editor-context";

const ICONS: Record<SlashItemId, typeof PilcrowIcon> = {
  paragraph: PilcrowIcon,
  heading1: Heading1Icon,
  heading2: Heading2Icon,
  heading3: Heading3Icon,
  bulletList: ListIcon,
  orderedList: ListOrderedIcon,
  taskList: ListChecksIcon,
  blockquote: QuoteIcon,
  codeBlock: Code2Icon,
  divider: MinusIcon,
  table: Table2Icon,
  image: ImageIcon,
  callout: LightbulbIcon,
  toggle: ListCollapseIcon,
  columns: Columns2Icon,
};

const SECTION_LABEL_KEY: Record<SlashSection, string> = {
  basic: "library.editor.slash.sections.basic",
  media: "library.editor.slash.sections.media",
  advanced: "library.editor.slash.sections.advanced",
};

interface SlashContext {
  range: TRange;
  path: Path;
  query: string;
  left: number;
  top: number;
  bottom: number;
}

/** 读取当前光标前的 `/query`；不在可编辑文本块/不在触发位置返回 null */
function readSlashContext(editor: PlateEditor): SlashContext | null {
  if (!editor.selection) return null;
  if (!editor.api.isCollapsed()) return null;

  const blockEntry = editor.api.block();
  if (!blockEntry) return null;

  const [block, path] = blockEntry;
  if (block.type === editor.getType(KEYS.codeBlock)) return null;

  const anchor = editor.selection.anchor;

  // block() 返回的 path 是块路径（如 [12]），而 anchor.path 指向文本节点
  // （如 [12, 0]）。这里直接按文本节点累计出光标前的纯文本，避免把父级
  // path 当成 Point 导致漏掉刚输入的 `/`。
  const anchorTextIndex = anchor.path[path.length] ?? 0;
  let before = "";
  for (let index = 0; index < block.children.length; index += 1) {
    const child = block.children[index];
    const text =
      "text" in child && typeof child.text === "string" ? child.text : "";
    if (index < anchorTextIndex) {
      before += text;
    } else if (index === anchorTextIndex) {
      before += text.slice(0, anchor.offset);
      break;
    } else {
      break;
    }
  }

  const match =
    /(?:^|[\s\u3000-\u303f\u4e00-\u9fff])\/([^\s/]*)$/.exec(before);
  if (!match) return null;

  const query = match[1] ?? "";
  const slashOffset = anchor.offset - query.length - 1;
  if (slashOffset < 0) return null;
  const from: Point = {
    path: anchor.path,
    offset: slashOffset,
  };

  const range: TRange = { anchor: from, focus: anchor };
  let rect: DOMRect | undefined;
  // 折叠选区用 DOM Selection 取光标坐标最可靠；Slate 的 toDOMRange
  // 在部分输入法/组合输入后可能拿不到节点，作为兜底。
  try {
    const domSelection = window.getSelection();
    if (domSelection && domSelection.rangeCount > 0) {
      rect = domSelection.getRangeAt(0).getBoundingClientRect();
    }
  } catch {
    // ignore
  }
  if (!rect || (rect.width === 0 && rect.height === 0 && !rect.left)) {
    try {
      rect = editor.api.toDOMRange(range)?.getBoundingClientRect();
    } catch {
      return null;
    }
  }
  if (!rect) return null;

  return {
    range,
    path,
    query,
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
  };
}

/** 删除 `/query` 并把当前块转成目标类型 */
function runSlashItem(
  editor: PlateEditor,
  context: SlashContext,
  id: SlashItemId,
  pickImage?: () => Promise<InsertedImage | null>,
): void {
  const { range, path } = context;

  if (id === "image") {
    void pickImage?.().then((image) => {
      if (!image) return;
      editor.tf.insertNodes(
        {
          type: KEYS.img,
          url: image.src,
          caption: [{ text: image.alt }],
          children: [{ text: "" }],
        },
        { at: PathApi.next(path), select: true },
      );
      editor.tf.focus();
    });
    // 图片块独立插入，原来的空段落保留作为可继续输入的位置
    editor.tf.delete({ at: range });
    editor.tf.focus();
    return;
  }

  editor.tf.delete({ at: range });

  switch (id) {
    case "paragraph":
      editor.tf.setNodes({ type: KEYS.p }, { at: path });
      break;
    case "heading1":
      editor.tf.setNodes({ type: KEYS.h1 }, { at: path });
      break;
    case "heading2":
      editor.tf.setNodes({ type: KEYS.h2 }, { at: path });
      break;
    case "heading3":
      editor.tf.setNodes({ type: KEYS.h3 }, { at: path });
      break;
    case "bulletList":
      toggleList(editor, { listStyleType: ListStyleType.Disc });
      break;
    case "orderedList":
      toggleList(editor, { listStyleType: ListStyleType.Decimal });
      break;
    case "taskList":
      toggleList(editor, { listStyleType: KEYS.listTodo });
      break;
    case "blockquote": {
      const entry = editor.api.block();
      if (entry) {
        editor.tf.wrapNodes(
          { type: KEYS.blockquote, children: [] },
          { at: entry[1] },
        );
      }
      break;
    }
    case "codeBlock":
      toggleCodeBlock(editor);
      break;
    case "divider": {
      const next = PathApi.next(path);
      editor.tf.insertNodes(
        { type: KEYS.hr, children: [{ text: "" }] },
        { at: next },
      );
      editor.tf.insertNodes(editor.api.create.block(), {
        at: PathApi.next(next),
        select: true,
      });
      break;
    }
    case "table":
      editor.getTransforms(TablePlugin).insert.table(
        { rowCount: 3, colCount: 3, header: true },
        { select: true },
      );
      break;
    case "callout": {
      const entry = editor.api.block();
      if (entry) {
        editor.tf.wrapNodes(
          {
            type: KEYS.callout,
            icon: "💡",
            children: [],
          } as never,
          { at: entry[1] },
        );
      }
      break;
    }
    case "toggle": {
      const entry = editor.api.block();
      if (entry) {
        editor.tf.removeNodes({ at: entry[1] });
        editor.tf.insertNodes(
          {
            type: KEYS.toggle,
            title: "Toggle",
            open: true,
            children: [{ type: KEYS.p, children: [{ text: "" }] }],
          } as never,
          { at: entry[1], select: true },
        );
      }
      break;
    }
    case "columns": {
      const entry = editor.api.block();
      if (entry) {
        editor.tf.removeNodes({ at: entry[1] });
        const at: Path = [
          Math.min(entry[1][0] ?? 0, editor.children.length),
        ];
        editor.tf.insertNodes(
          {
            type: KEYS.columnGroup,
            children: [
              {
                type: KEYS.column,
                children: [{ type: KEYS.p, children: [{ text: "" }] }],
              },
              {
                type: KEYS.column,
                children: [{ type: KEYS.p, children: [{ text: "" }] }],
              },
            ],
          } as never,
          { at },
        );
        const start = editor.api.start([...at, 0, 0]);
        if (start) editor.tf.select(start);
      }
      break;
    }
    default:
      break;
  }

  editor.tf.focus();
}

interface SlashRow extends SlashItemDef {
  label: string;
  description: string;
}

interface SlashGroup {
  key: string;
  label: string;
  rows: SlashRow[];
}

export const PlateSlashMenu: FC<{ allowNativeBlocks?: boolean }> = ({
  allowNativeBlocks = false,
}) => {
  const editor = useEditorRef();
  const t = useT();
  const { pickImage } = usePlateEditorBridge();
  const version = useEditorVersion();
  const selectionVersion = useSelectionVersion();
  const [context, setContext] = useState<SlashContext | null>(null);
  const [selected, setSelected] = useState(0);
  const [recent, setRecent] = useState<SlashItemId[]>(() =>
    readRecentSlashIds(),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  /** Esc 收起后，同一段 `/query` 继续输入不再弹 */
  const dismissedRef = useRef<{ path: string; query: string } | null>(null);

  const labeled = useMemo(
    () =>
      SLASH_ITEM_DEFS.filter(
        (item) =>
          (item.id !== "image" || Boolean(pickImage)) &&
          (!item.nativeOnly || allowNativeBlocks),
      ).map((item) => ({
        ...item,
        label: t(item.labelKey),
        description: t(item.descriptionKey),
      })),
    [allowNativeBlocks, pickImage, t],
  );

  const filtered = useMemo(
    () => (context ? filterSlashItems(labeled, context.query) : []),
    [context, labeled],
  );

  const groups = useMemo<SlashGroup[]>(() => {
    const query = context?.query.trim() ?? "";
    const result: SlashGroup[] = [];
    const recentSet = new Set(query ? [] : recent);

    if (!query && recent.length > 0) {
      const rows = recent
        .map((id) => labeled.find((item) => item.id === id))
        .filter((item): item is SlashRow => Boolean(item));
      if (rows.length > 0) {
        result.push({
          key: "recent",
          label: t("library.editor.slash.recent"),
          rows,
        });
      }
    }

    for (const section of SLASH_SECTIONS) {
      const rows = filtered.filter(
        (item) => item.section === section && !recentSet.has(item.id),
      );
      if (rows.length > 0) {
        result.push({
          key: section,
          label: t(SECTION_LABEL_KEY[section]),
          rows,
        });
      }
    }
    return result;
  }, [context?.query, filtered, labeled, recent, t]);

  const flatRows = useMemo(
    () => groups.flatMap((group) => group.rows),
    [groups],
  );

  // 编辑/选区变化 → 重算触发上下文；文档版本变化也覆盖外部替换
  useEffect(() => {
    const sync = () => {
      const next = readSlashContext(editor);
      if (!next) {
        dismissedRef.current = null;
        setContext(null);
        return;
      }
      const dismissed = dismissedRef.current;
      const pathKey = next.path.join(",");
      if (
        dismissed &&
        dismissed.path === pathKey &&
        next.query.startsWith(dismissed.query)
      ) {
        setContext(null);
        return;
      }
      dismissedRef.current = null;
      setContext((prev) =>
        prev &&
        prev.path.join(",") === pathKey &&
        prev.query === next.query &&
        prev.range.anchor.offset === next.range.anchor.offset &&
        prev.top === next.top &&
        prev.left === next.left
          ? prev
          : next,
      );
    };
    const onWindowBlur = () => setContext(null);
    sync();
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [editor, selectionVersion, version]);

  useEffect(() => {
    setSelected(0);
  }, [context?.query, context?.range.anchor.offset]);

  useEffect(() => {
    if (selected < 0) return;
    const el = menuRef.current?.querySelector<HTMLElement>(
      `[data-index="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const close = useCallback(() => {
    if (context) {
      dismissedRef.current = {
        path: context.path.join(","),
        query: context.query,
      };
    }
    setContext(null);
  }, [context]);

  const choose = useCallback(
    (index: number) => {
      if (!context) return;
      const row = flatRows[index];
      if (!row) return;
      const current = context;
      setContext(null);
      setRecent((prev) => {
        const next = rememberSlashId(row.id);
        return next.length > 0 ? next : prev;
      });
      runSlashItem(editor, current, row.id, pickImage);
    },
    [context, editor, flatRows, pickImage],
  );

  useEffect(() => {
    if (!context) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        if (flatRows.length > 0) {
          setSelected((prev) => (prev + 1) % flatRows.length);
        }
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (flatRows.length > 0) {
          setSelected((prev) => (prev - 1 + flatRows.length) % flatRows.length);
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (flatRows.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        choose(selected < 0 ? 0 : selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [choose, close, context, flatRows.length, selected]);

  useEffect(() => {
    if (!context) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setContext(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [context]);

  if (!context || typeof document === "undefined") return null;

  const width = 320;
  const left = Math.min(
    Math.max(8, context.left),
    Math.max(8, window.innerWidth - width - 8),
  );
  const openUp = context.bottom > window.innerHeight * 0.62;

  let flatIndex = -1;

  return createPortal(
    <div
      ref={menuRef}
      data-kova-slash-menu="true"
      style={{
        position: "fixed",
        left,
        top: openUp ? context.top - 6 : context.bottom + 6,
        transform: openUp ? "translateY(-100%)" : undefined,
        width,
        zIndex: 80,
      }}
      className="bg-popover text-popover-foreground border-border overflow-hidden rounded-lg border shadow-lg"
    >
      <div
        role="listbox"
        aria-label={t("library.editor.slash.menuAria")}
        className="max-h-96 overflow-y-auto p-1"
      >
        {flatRows.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">
            {t("library.editor.slash.empty")}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <div className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium">
                {group.label}
              </div>
              {group.rows.map((row) => {
                flatIndex += 1;
                const index = flatIndex;
                const Icon = ICONS[row.id];
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    data-index={index}
                    onMouseEnter={() => setSelected(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(index)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      index === selected
                        ? "bg-selected text-foreground"
                        : "text-foreground/90 hover:bg-hover",
                    )}
                  >
                    <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {row.label}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {row.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
      <div className="border-border/60 text-muted-foreground flex items-center justify-between border-t px-2 py-1 text-xs">
        <span>{t("library.editor.slash.hint")}</span>
        <span className="tabular-nums">↑↓ ↵</span>
      </div>
    </div>,
    document.body,
  );
};
