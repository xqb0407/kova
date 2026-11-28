"use client";

/**
 * Plate 基础元素组件（最小集）：段落/标题/引用/分割线/代码块/链接/表格/图片。
 * 交互型 UI（拖拽手柄、斜杠菜单、浮动工具栏）后续接入官方 plate-ui 模板。
 */

import type { TElement, TImageElement, TLinkElement } from "platejs";
import { KEYS, NodeApi, PathApi } from "platejs";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  PlateElement,
  PlateLeaf,
  useEditorRef,
  useEditorSelector,
  useReadOnly,
  useSelected,
  withHOC,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";
import { Caption, CaptionTextarea, showCaption } from "@platejs/caption/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GripVertical,
  ImageOffIcon,
  PlusIcon,
  Table2Icon,
  Trash2Icon,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  getColSpan,
  getRowSpan,
  getSelectedCells,
  insertTableColumn,
  insertTableRow,
  mergeTableCells,
  setCellBackground,
  splitTableCell,
} from "@platejs/table";
import {
  TableProvider,
  useCellIndices,
  useIsCellSelected,
  useOverrideColSize,
  useSelectedCells,
  useTableColSizes,
  useTableMergeState,
} from "@platejs/table/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePlateEditorBridge } from "./editor-context";
import { CodeLanguagePicker } from "./pickers";

export function ParagraphElement(props: PlateElementProps) {
  const t = useT();
  // 空段落获得焦点时显示引导文案；空白新文档即使未聚焦也显示。
  const showPlaceholder = useEditorSelector((editor) => {
    if (NodeApi.string(props.element) !== "") return false;
    const path = editor.api.findPath(props.element);
    // 只在页面顶层段落显示；表格单元格、引用/列表里的空段落不弹整页引导
    if (!path || path.length !== 1) return false;
    if (editor.children.length === 1) return true;
    const selection = editor.selection;
    if (!selection) return false;
    return selection.anchor.path[0] === path[0];
  }, [props.element]);

  return (
    <PlateElement {...props} className="relative m-0 py-1">
      {showPlaceholder ? (
        <span
          contentEditable={false}
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1 left-0 text-ui-lg leading-7 select-none"
        >
          {t("library.editor.placeholder")}
        </span>
      ) : null}
      {props.children}
    </PlateElement>
  );
}

const headingClass: Record<string, string> = {
  h1: "mt-8 mb-3 text-3xl font-bold tracking-tight",
  h2: "mt-7 mb-2 text-2xl font-semibold tracking-tight",
  h3: "mt-5 mb-2 text-xl font-semibold",
  h4: "mt-4 mb-1 text-lg font-semibold",
  h5: "mt-3 mb-1 text-base font-semibold",
  h6: "mt-3 mb-1 text-sm font-semibold text-muted-foreground",
};

function HeadingElement({
  as,
  ...props
}: PlateElementProps & { as: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" }) {
  return (
    <PlateElement
      as={as}
      {...props}
      className={cn("scroll-mt-6 leading-snug", headingClass[as])}
    >
      {props.children}
    </PlateElement>
  );
}

export const H1Element = (props: PlateElementProps) => (
  <HeadingElement as="h1" {...props} />
);
export const H2Element = (props: PlateElementProps) => (
  <HeadingElement as="h2" {...props} />
);
export const H3Element = (props: PlateElementProps) => (
  <HeadingElement as="h3" {...props} />
);
export const H4Element = (props: PlateElementProps) => (
  <HeadingElement as="h4" {...props} />
);
export const H5Element = (props: PlateElementProps) => (
  <HeadingElement as="h5" {...props} />
);
export const H6Element = (props: PlateElementProps) => (
  <HeadingElement as="h6" {...props} />
);

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      {...props}
      className="border-border text-muted-foreground my-2 border-l-2 pl-4"
    >
      {props.children}
    </PlateElement>
  );
}

export function HrElement(props: PlateElementProps) {
  return (
    <PlateElement {...props}>
      <div className="py-4" contentEditable={false}>
        <hr className="border-border border-t" />
      </div>
      {props.children}
    </PlateElement>
  );
}

export function CodeBlockElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const t = useT();
  const [copied, setCopied] = useState(false);
  const lang = typeof props.element.lang === "string" ? props.element.lang : "";
  const code = NodeApi.string(props.element);

  const changeLang = (value: string) => {
    const path = editor.api.findPath(props.element);
    if (!path) return;
    editor.tf.setNodes({ lang: value || null }, { at: path });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  return (
    <PlateElement
      {...props}
      className="kova-codeblock border-border bg-muted/40 my-3 overflow-hidden rounded-lg border font-mono text-ui leading-relaxed"
    >
      <div
        contentEditable={false}
        className="border-border/60 text-muted-foreground flex items-center justify-between border-b px-3 py-1"
      >
        <CodeLanguagePicker value={lang} onChange={changeLang} />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void copy()}
          className="hover:text-foreground text-xs"
        >
          {copied
            ? t("library.editor.code.copied")
            : t("library.editor.code.copy")}
        </button>
      </div>
      <div className="overflow-x-auto px-4 py-3">{props.children}</div>
    </PlateElement>
  );
}

export function CodeLineElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} className="block whitespace-pre">
      {props.children}
    </PlateElement>
  );
}

export function CodeSyntaxLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="span"
      className={cn("text-foreground", props.leaf.className as string)}
    >
      {props.children}
    </PlateLeaf>
  );
}

export function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="code"
      className="bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]"
    >
      {props.children}
    </PlateLeaf>
  );
}

/** 查找命中高亮（FindReplacePlugin 的 search_highlight 叶子） */
export function SearchHighlightLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="mark"
      className="rounded bg-amber-200/70 text-inherit dark:bg-amber-400/30"
    >
      {props.children}
    </PlateLeaf>
  );
}

export function LinkElement(props: PlateElementProps) {
  const element = props.element as TLinkElement;
  const editor = useEditorRef();

  /** 点击链接不跳走：选中链接文字，交给浮动工具栏改地址/移除 */
  const selectLink = () => {
    const path = editor.api.findPath(props.element);
    if (!path) return;
    const start = editor.api.start(path);
    const end = editor.api.end(path);
    if (start && end) editor.tf.select({ anchor: start, focus: end });
    editor.tf.focus();
  };

  return (
    <PlateElement
      {...props}
      as="a"
      className="text-primary cursor-pointer underline underline-offset-3"
      attributes={{
        ...props.attributes,
        href: element.url,
        target: element.target,
        rel: element.target === "_blank" ? "noopener noreferrer" : undefined,
        onClick: (event) => {
          event.preventDefault();
          selectLink();
        },
      }}
    >
      {props.children}
    </PlateElement>
  );
}

/** Notion 式 callout：图标 + 可编辑正文。类型用标准 `callout`，Markdown 导出
 *  会降级成引用块（见 lib/notes/native-markdown.ts）。 */
export function CalloutElement(props: PlateElementProps) {
  const element = props.element as TElement & {
    icon?: unknown;
    color?: unknown;
  };
  const icon = typeof element.icon === "string" ? element.icon : "💡";
  return (
    <PlateElement
      {...props}
      className={cn(
        "my-3 rounded-lg border border-border/60 px-4 py-3",
        cellBackgroundClass(element.color) || "bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          contentEditable={false}
          className="mt-0.5 shrink-0 text-base select-none"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </PlateElement>
  );
}

/** Notion 式折叠块：标题是节点字段（不占正文），正文 blocks 在展开时显示。 */
export function ToggleElement(props: PlateElementProps) {
  const editor = useEditorRef();
  const t = useT();
  const element = props.element as TElement & {
    title?: unknown;
    open?: unknown;
  };
  const open = element.open !== false;
  const title = typeof element.title === "string" ? element.title : "";
  const path = editor.api.findPath(props.element);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <PlateElement {...props} className="my-1">
      <div className="flex items-start gap-1">
        <button
          type="button"
          contentEditable={false}
          aria-label={t("library.editor.block.toggle")}
          aria-expanded={open}
          onClick={() => {
            if (!path) return;
            editor.tf.setNodes({ open: !open }, { at: path });
            // 收起后光标不能留在被隐藏的正文里
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="text-muted-foreground hover:bg-hover hover:text-foreground mt-1 grid size-5 shrink-0 place-items-center rounded"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </button>
        <input
          ref={inputRef}
          value={title}
          onChange={(event) => {
            if (!path) return;
            editor.tf.setNodes({ title: event.target.value }, { at: path });
          }}
          placeholder={t("library.editor.block.togglePlaceholder")}
          aria-label={t("library.editor.block.toggle")}
          spellCheck={false}
          className="min-w-0 flex-1 border-none bg-transparent py-0.5 text-ui-lg font-medium outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      <div className={cn("ml-6 min-w-0", !open && "hidden")}>
        {props.children}
      </div>
    </PlateElement>
  );
}

/** 分栏容器/列：只负责布局，内容仍是普通 blocks。 */
export function ColumnGroupElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      className="my-3 flex flex-col gap-4 sm:flex-row"
    />
  );
}

export function ColumnElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      className="min-w-0 flex-1 rounded-md border border-dashed border-border/40 px-3 py-2"
    />
  );
}

/** 单元格背景色：只存 token（"yellow" 等），渲染时映射到明暗两套 class，
 *  不把 hex 写进文档——换主题/导出 Markdown 都不受影响。 */
const CELL_BACKGROUNDS = [
  { key: null, labelKey: "library.editor.table.colorDefault", className: "bg-background" },
  { key: "gray", labelKey: "library.editor.table.colorGray", className: "bg-muted" },
  { key: "yellow", labelKey: "library.editor.table.colorYellow", className: "bg-amber-100 dark:bg-amber-900/35" },
  { key: "green", labelKey: "library.editor.table.colorGreen", className: "bg-green-100 dark:bg-green-900/35" },
  { key: "blue", labelKey: "library.editor.table.colorBlue", className: "bg-sky-100 dark:bg-sky-900/35" },
  { key: "purple", labelKey: "library.editor.table.colorPurple", className: "bg-purple-100 dark:bg-purple-900/35" },
  { key: "pink", labelKey: "library.editor.table.colorPink", className: "bg-pink-100 dark:bg-pink-900/35" },
  { key: "red", labelKey: "library.editor.table.colorRed", className: "bg-red-100 dark:bg-red-900/35" },
] as const;

function cellBackgroundClass(value: unknown): string {
  if (typeof value !== "string") return "";
  return (
    CELL_BACKGROUNDS.find((color) => color.key === value)?.className ?? ""
  );
}

/** colSizes 可能为空/全 0（旧数据或新表）：按列数均分 100%，保证表格铺满。 */
function normalizeColSizes(sizes: readonly number[]): number[] {
  if (sizes.length === 0) return [];
  const round = (value: number) => Math.round(value * 100) / 100;
  const sum = sizes.reduce((acc, size) => acc + (size > 0 ? size : 0), 0);
  if (sum <= 0) return sizes.map(() => round(100 / sizes.length));
  return sizes.map((size) =>
    round(size > 0 ? (size / sum) * 100 : 100 / sizes.length),
  );
}

/** 表格布局上下文：TableElement 统一算好的列宽/路径，单元格手柄直接用，
 *  避免在单元格里再次解析最近 table 上下文（嵌套元素下不可靠）。 */
const TableLayoutContext = createContext<{
  tablePath: number[] | null;
  colSizes: number[];
  setOverride: (col: number, size: number | null) => void;
} | null>(null);

function selectTableRowStart(editor: ReturnType<typeof useEditorRef>, element: TElement) {
  const path = editor.api.findPath(element);
  if (!path) return;
  const start = editor.api.start([...path, 0]);
  if (start) editor.tf.select(start);
}

function selectTableCellStart(
  editor: ReturnType<typeof useEditorRef>,
  element: TElement,
) {
  const path = editor.api.findPath(element);
  if (!path) return;
  const start = editor.api.start(path);
  if (start) editor.tf.select(start);
}

/** 行首 grip：悬停行时出现，菜单只影响当前行 */
function RowHandle({ element }: { element: TElement }) {
  const editor = useEditorRef();
  const t = useT();
  const { nativeNote } = usePlateEditorBridge();
  const cellPath = editor.api.findPath(element);
  const rowPath = cellPath ? PathApi.parent(cellPath) : null;
  const setRowHeight = (height: number) => {
    if (!rowPath) return;
    editor.tf.setNodes({ size: height }, { at: rowPath });
    editor.tf.focus();
  };

  return (
    <div
      contentEditable={false}
      className="absolute top-1/2 -left-9 z-30 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("library.editor.table.rowMenu")}
              onPointerDown={() => selectTableRowStart(editor, element)}
              className="text-muted-foreground hover:bg-hover hover:text-foreground grid size-6 cursor-grab place-items-center rounded-md active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuItem
            onClick={() => {
              if (rowPath) {
                insertTableRow(editor, { fromRow: rowPath, before: true });
              }
              editor.tf.focus();
            }}
          >
            {t("library.editor.table.insertRowAbove")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (rowPath) insertTableRow(editor, { fromRow: rowPath });
              editor.tf.focus();
            }}
          >
            {t("library.editor.table.insertRowBelow")}
          </DropdownMenuItem>
          {nativeNote ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {t("library.editor.table.rowHeight")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => setRowHeight(32)}>
                  {t("library.editor.table.rowCompact")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRowHeight(48)}>
                  {t("library.editor.table.rowDefault")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRowHeight(72)}>
                  {t("library.editor.table.rowTall")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              selectTableRowStart(editor, element);
              deleteRow(editor);
              editor.tf.focus();
            }}
          >
            {t("library.editor.table.deleteRow")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 表头列 grip：悬停表头单元格时出现 */
function ColumnHandle({ element }: { element: TElement }) {
  const editor = useEditorRef();
  const t = useT();
  const cellPath = editor.api.findPath(element);

  return (
    <div
      contentEditable={false}
      className="absolute -top-9 left-1/2 z-30 -translate-x-1/2 opacity-0 transition-opacity group-hover/cell:opacity-100"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("library.editor.table.columnMenu")}
              onPointerDown={() => selectTableCellStart(editor, element)}
              className="text-muted-foreground hover:bg-hover hover:text-foreground grid size-6 cursor-grab place-items-center rounded-md active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="center" className="w-40">
          <DropdownMenuItem
            onClick={() => {
              if (cellPath) {
                insertTableColumn(editor, {
                  fromCell: cellPath,
                  before: true,
                });
              }
              editor.tf.focus();
            }}
          >
            {t("library.editor.table.insertColumnLeft")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (cellPath) {
                insertTableColumn(editor, { fromCell: cellPath });
              }
              editor.tf.focus();
            }}
          >
            {t("library.editor.table.insertColumnRight")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => {
              selectTableCellStart(editor, element);
              deleteColumn(editor);
              editor.tf.focus();
            }}
          >
            {t("library.editor.table.deleteColumn")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 列宽拖拽：拖动时用 table store 的 override 实时预览，松手才写回 colSizes。
 *  colSizes 存百分比（总和 100），表格始终铺满正文宽度；只调当前列与右邻列。 */
function ColumnResizeHandle({ colIndex }: { colIndex: number }) {
  const editor = useEditorRef();
  const t = useT();
  const layout = useContext(TableLayoutContext);
  const normalized = layout?.colSizes ?? [];
  const tablePath = layout?.tablePath ?? null;
  const overrideColSize = layout?.setOverride;
  const neighbor = colIndex + 1;
  const canResize =
    Boolean(tablePath && overrideColSize) && neighbor < normalized.length;

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const targetPath = tablePath;
    if (!targetPath || !overrideColSize) return;
    event.preventDefault();
    event.stopPropagation();
    const tableWidth =
      event.currentTarget.closest("table")?.getBoundingClientRect().width ?? 0;
    if (tableWidth <= 0) return;
    const startX = event.clientX;
    const leftStart = normalized[colIndex]!;
    const rightStart = normalized[neighbor]!;
    const pair = leftStart + rightStart;
    const min = 6;
    let left = leftStart;
    let right = rightStart;

    const onMove = (moveEvent: MouseEvent) => {
      const delta = ((moveEvent.clientX - startX) / tableWidth) * 100;
      left = Math.min(Math.max(leftStart + delta, min), pair - min);
      right = pair - left;
      overrideColSize!(colIndex, left);
      overrideColSize!(neighbor, right);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const round = (value: number) => Math.round(value * 100) / 100;
      const next = normalized.map((size, index) =>
        round(index === colIndex ? left : index === neighbor ? right : size),
      );
      editor.tf.setNodes({ colSizes: next }, { at: targetPath });
      window.setTimeout(() => {
        overrideColSize!(colIndex, null);
        overrideColSize!(neighbor, null);
      }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      contentEditable={false}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("library.editor.table.resizeColumn")}
      onMouseDown={canResize ? onMouseDown : undefined}
      style={canResize ? undefined : { display: "none" }}
      className="absolute top-0 -right-1 z-20 h-full w-2 cursor-col-resize touch-none select-none"
    >
      <span className="bg-border hover:bg-primary absolute top-0 left-1/2 h-full w-px -translate-x-1/2 opacity-0 transition-colors group-hover/cell:opacity-100" />
    </div>
  );
}

export const TableElement = withHOC(
  TableProvider,
  function TableElement(props: PlateElementProps) {
    const editor = useEditorRef();
    const { nativeNote } = usePlateEditorBridge();
    useSelectedCells();
    const t = useT();
    const selectionInTable = useEditorSelector((current) => {
      const selection = current.selection;
      if (!selection) return false;
      const tablePath = current.api.findPath(props.element);
      if (!tablePath) return false;
      return tablePath.every(
        (segment, index) => selection.anchor.path[index] === segment,
      );
    }, []);
    const tablePath = editor.api.findPath(props.element);
    const rawColSizes = useTableColSizes();
    const colSizes = normalizeColSizes(rawColSizes);
    const setOverride = useOverrideColSize();
    const { canMerge } = useTableMergeState();
    // 拆分能力按当前单元格 span 自行判断：插件 store 的 canSplit 依赖
    // 选区同步时序，菜单打开时偶尔仍是 false，导致合并后拆不回去。
    const cellSpan = useEditorSelector((current) => {
      const entry = current.api.above({
        match: (node) =>
          (node as TElement).type === KEYS.td ||
          (node as TElement).type === KEYS.th,
      });
      if (!entry) return 0;
      const cell = entry[0] as Parameters<typeof getColSpan>[0];
      return Math.max(getColSpan(cell), getRowSpan(cell));
    }, []);
    const readOnly = useReadOnly();
    const canSplit = !readOnly && cellSpan > 1;
    const firstRow = props.element.children[0] as TElement | undefined;
    const hasHeaderRow = Boolean(
      firstRow?.children.length &&
        firstRow.children.every((cell) => (cell as TElement).type === KEYS.th),
    );

    const applyCellColor = (color: string | null) => {
      setCellBackground(editor, {
        color,
        selectedCells: getSelectedCells(editor) ?? undefined,
      });
      editor.tf.focus();
    };

    const toggleHeaderRow = () => {
      if (!tablePath || !firstRow) return;
      const type = hasHeaderRow ? KEYS.td : KEYS.th;
      editor.tf.withoutNormalizing(() => {
        firstRow.children.forEach((_, index) => {
          editor.tf.setNodes({ type }, { at: [...tablePath, 0, index] });
        });
      });
      editor.tf.focus();
    };

    return (
      <PlateElement {...props} className="group/table relative my-4">
        <div
          contentEditable={false}
          className={cn(
            "absolute -top-9 right-0 z-20 transition-opacity",
            selectionInTable
              ? "opacity-100"
              : "opacity-0 group-hover/table:opacity-100",
          )}
        >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("library.editor.table.toolbarAria")}
                    className="border-border bg-popover text-muted-foreground hover:text-foreground inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs shadow-sm"
                  >
                    <Table2Icon className="size-3.5" />
                    <ChevronDownIcon className="size-3" />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onClick={() => {
                    editor.tf.focus();
                    insertTableRow(editor, { before: true });
                  }}
                >
                  {t("library.editor.table.insertRowAbove")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    editor.tf.focus();
                    insertTableRow(editor);
                  }}
                >
                  {t("library.editor.table.insertRowBelow")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    editor.tf.focus();
                    insertTableColumn(editor, { before: true });
                  }}
                >
                  {t("library.editor.table.insertColumnLeft")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    editor.tf.focus();
                    insertTableColumn(editor);
                  }}
                >
                  {t("library.editor.table.insertColumnRight")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    editor.tf.focus();
                    deleteRow(editor);
                  }}
                >
                  {t("library.editor.table.deleteRow")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    editor.tf.focus();
                    deleteColumn(editor);
                  }}
                >
                  {t("library.editor.table.deleteColumn")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {nativeNote ? (
                  <>
                  <DropdownMenuItem
                    disabled={!canMerge}
                    onClick={() => {
                      mergeTableCells(editor);
                      editor.tf.focus();
                    }}
                  >
                    {t("library.editor.table.mergeCells")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canSplit}
                    onClick={() => {
                      splitTableCell(editor);
                      editor.tf.focus();
                    }}
                  >
                    {t("library.editor.table.splitCell")}
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      {t("library.editor.table.cellBackground")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-auto">
                      <div className="grid grid-cols-4 gap-1 p-1">
                        {CELL_BACKGROUNDS.map((color) => (
                          <button
                            key={color.key ?? "default"}
                            type="button"
                            title={t(color.labelKey)}
                            aria-label={t(color.labelKey)}
                            onClick={() => applyCellColor(color.key)}
                            className={cn(
                              "border-border hover:ring-ring size-6 rounded-md border transition-shadow hover:ring-2",
                              color.className,
                              color.key === null &&
                                "text-muted-foreground grid place-items-center text-xs",
                            )}
                          >
                            {color.key === null ? "∅" : null}
                          </button>
                        ))}
                      </div>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem onClick={toggleHeaderRow}>
                    {hasHeaderRow
                      ? t("library.editor.table.unsetHeaderRow")
                      : t("library.editor.table.setHeaderRow")}
                  </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    editor.tf.focus();
                    deleteTable(editor);
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                  {t("library.editor.table.deleteTable")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
        </div>
        <TableLayoutContext.Provider
          value={{ tablePath: tablePath ?? null, colSizes, setOverride }}
        >
          <table className="w-full table-fixed border-collapse">
            {colSizes.length > 0 ? (
              <colgroup>
                {colSizes.map((size, index) => (
                  <col key={index} style={{ width: `${size}%` }} />
                ))}
              </colgroup>
            ) : null}
            <tbody>{props.children}</tbody>
          </table>
        </TableLayoutContext.Provider>
        {tablePath ? (
          <button
            type="button"
            contentEditable={false}
            aria-label={t("library.editor.table.addRow")}
            onClick={() => {
              insertTableRow(editor, { at: tablePath });
              editor.tf.focus();
            }}
            className="text-muted-foreground hover:bg-hover hover:text-foreground absolute -bottom-7 left-0 grid size-6 place-items-center rounded-md opacity-0 transition-opacity group-hover/table:opacity-100"
          >
            <PlusIcon className="size-4" />
          </button>
        ) : null}
        {tablePath ? (
          <button
            type="button"
            contentEditable={false}
            aria-label={t("library.editor.table.addColumn")}
            onClick={() => {
              insertTableColumn(editor, { at: tablePath });
              editor.tf.focus();
            }}
            className="text-muted-foreground hover:bg-hover hover:text-foreground absolute top-1/2 -right-7 grid size-6 -translate-y-1/2 place-items-center rounded-md opacity-0 transition-opacity group-hover/table:opacity-100"
          >
            <PlusIcon className="size-4" />
          </button>
        ) : null}
      </PlateElement>
    );
  },
);

export function TableRowElement(props: PlateElementProps) {
  const size = (props.element as { size?: number }).size;
  return (
    <PlateElement
      {...props}
      as="tr"
      className="group/row"
      style={size && size > 0 ? { height: size } : undefined}
    />
  );
}

function TableCell({
  isHeader,
  ...props
}: PlateElementProps & { isHeader?: boolean }) {
  const { col = 0, row = 0, colSpan = 1 } = (useCellIndices() ?? {}) as {
    col?: number;
    row?: number;
    colSpan?: number;
  };
  const selected = useIsCellSelected(props.element);
  const { nativeNote } = usePlateEditorBridge();
  const background = cellBackgroundClass(
    (props.element as { background?: unknown }).background,
  );
  return (
    <PlateElement
      {...props}
      as={isHeader ? "th" : "td"}
      className={cn(
        "group/cell relative min-w-16 border border-border/70 p-0 align-top",
        isHeader && "bg-muted/50 text-left",
      )}
    >
      <div
        className={cn(
          "min-h-8 px-2.5 py-1.5",
          selected ? "bg-primary/10" : background,
        )}
      >
        {props.children}
      </div>
      {col === 0 && !isHeader ? <RowHandle element={props.element} /> : null}
      {row === 0 ? <ColumnHandle element={props.element} /> : null}
      {row === 0 && colSpan === 1 && nativeNote ? (
        <ColumnResizeHandle colIndex={col} />
      ) : null}
    </PlateElement>
  );
}

export function TableCellElement(props: PlateElementProps) {
  return <TableCell {...props} />;
}

export function TableCellHeaderElement(props: PlateElementProps) {
  return <TableCell {...props} isHeader />;
}

export function ImageElement(props: PlateElementProps) {
  const element = props.element as TImageElement;
  const editor = useEditorRef();
  const t = useT();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const { resolveImageSrc } = usePlateEditorBridge();
  const [failed, setFailed] = useState(false);
  const url = element.url ?? "";
  const resolved = url ? resolveImageSrc(url) : "";

  useEffect(() => {
    setFailed(false);
  }, [resolved]);

  return (
    <PlateElement {...props} className="my-3">
      <figure className="group m-0 text-center" contentEditable={false}>
        {resolved && !failed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolved}
            alt={url}
            draggable={false}
            onError={() => setFailed(true)}
            onDoubleClick={() => {
              if (!readOnly) showCaption(editor, element);
            }}
            className={cn(
              "mx-auto max-w-full rounded-md",
              selected && "ring-2 ring-ring/60 ring-offset-2",
            )}
          />
        ) : (
          <div className="border-border text-muted-foreground inline-flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs">
            <ImageOffIcon className="size-4" />
            {url ? url : "image"}
          </div>
        )}
        <Caption className="block">
          <CaptionTextarea
            readOnly={readOnly}
            placeholder={t("library.editor.image.captionPlaceholder")}
            className="text-muted-foreground mx-auto mt-1.5 w-full resize-none border-none bg-transparent p-0 text-center text-xs outline-none"
          />
        </Caption>
      </figure>
      {props.children}
    </PlateElement>
  );
}
