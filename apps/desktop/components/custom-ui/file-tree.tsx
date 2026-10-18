"use client";
// beui.dev/components/motion/file-tree
// 本地改造（对齐 VSCode explorer 的做法）：树拍平成固定行高的虚拟列表，
// 只挂载视口 ±overscan 行；行/分支线入场动画与 hover pill 全部移除
// （虚拟滚动下行随滚动回收复用，动画会闪烁且成本极高）。

import { useVirtualizer } from "@tanstack/react-virtual";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import {
  Children,
  Fragment,
  useCallback,
  isValidElement,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { SPRING_SWAP } from "@/lib/motion/ease";
import { cn } from "@/lib/utils";

type FileTreeItem = {
  value: string;
  name: string;
  type: "file" | "folder";
  children?: FileTreeItem[];
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** 行级拖放透传（资料库把外部文件拖到文件夹上导入：目标目录即该行） */
  onDragOver?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragLeave?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLButtonElement>) => void;
};

/** 行级拖放回调（三种一起给；不给则该行不参与拖放） */
export interface FileTreeRowDragHandlers {
  onDragOver: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: React.DragEvent<HTMLButtonElement>) => void;
}

export interface FileTreeFolderProps {
  value: string;
  name: string;
  icon?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
  /** 右键回调（行按钮上触发，不冒泡到树的空白区） */
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** 拖放回调（folder 行可作投放目标） */
  dragHandlers?: FileTreeRowDragHandlers;
}

export interface FileTreeFileProps {
  value: string;
  name: string;
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** 右键回调（行按钮上触发，不冒泡到树的空白区） */
  onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** 拖放回调（一般只文件夹需要） */
  dragHandlers?: FileTreeRowDragHandlers;
}

export type FileTreeClassNames = {
  tree?: string;
  item?: string;
  icon?: string;
  label?: string;
};

export interface FileTreeProps {
  children: ReactNode;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  expandedIds?: string[];
  defaultExpandedIds?: string[];
  onExpandedChange?: (expandedIds: string[]) => void;
  ariaLabel?: string;
  indent?: number;
  className?: string;
  classNames?: FileTreeClassNames;
}

type FlatFileTreeItem = {
  item: FileTreeItem;
  depth: number;
  parentId: string | null;
  position: number;
  setSize: number;
};

// These declarative parts are read by FileTree and turned into one flattened,
// keyboard-navigable collection. They intentionally render nothing alone.
export function FileTreeFolder(_props: FileTreeFolderProps) {
  return null;
}

export function FileTreeFile(_props: FileTreeFileProps) {
  return null;
}

/** 行高（px），与行按钮固定高度一致；虚拟滚动的前提是等高行 */
const ROW_HEIGHT = 36;

function flattenItems(
  items: FileTreeItem[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parentId: string | null = null,
): FlatFileTreeItem[] {
  return items.flatMap((item, index) => {
    const row = {
      item,
      depth,
      parentId,
      position: index + 1,
      setSize: items.length,
    };

    if (
      item.type !== "folder" ||
      !expanded.has(item.value) ||
      !item.children?.length
    ) {
      return [row];
    }

    return [
      row,
      ...flattenItems(item.children, expanded, depth + 1, item.value),
    ];
  });
}

function itemsFromChildren(children: ReactNode): FileTreeItem[] {
  const items: FileTreeItem[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;

    if (child.type === Fragment) {
      const props = child.props as { children?: ReactNode };
      items.push(...itemsFromChildren(props.children));
      return;
    }

    if (child.type === FileTreeFolder) {
      const props = child.props as FileTreeFolderProps;
      items.push({
        value: props.value,
        name: props.name,
        type: "folder",
        icon: props.icon,
        disabled: props.disabled,
        className: props.className,
        onContextMenu: props.onContextMenu,
        ...props.dragHandlers,
        children: itemsFromChildren(props.children),
      });
      return;
    }

    if (child.type === FileTreeFile) {
      const props = child.props as FileTreeFileProps;
      items.push({
        value: props.value,
        name: props.name,
        type: "file",
        icon: props.icon,
        disabled: props.disabled,
        className: props.className,
        onContextMenu: props.onContextMenu,
        ...props.dragHandlers,
      });
    }
  });

  return items;
}

// 文件夹开合图标直接切换（此前是每行一个 AnimatePresence popLayout，
// 大列表下测量成本显著，且与树的高频重渲染叠加成卡顿）
function DefaultIcon({ item, open }: { item: FileTreeItem; open: boolean }) {
  if (item.type === "file") return <File className="size-4" />;
  return open ? (
    <FolderOpen className="size-4" />
  ) : (
    <Folder className="size-4" />
  );
}

export function FileTree({
  children,
  value,
  defaultValue = null,
  onValueChange,
  expandedIds,
  defaultExpandedIds = [],
  onExpandedChange,
  ariaLabel = "Files",
  indent = 18,
  className,
  classNames,
}: FileTreeProps) {
  const reduce = useReducedMotion() ?? false;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalExpandedIds, setInternalExpandedIds] = useState(
    defaultExpandedIds,
  );
  const [focusedId, setFocusedId] = useState<string | null>(
    value ?? defaultValue,
  );
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedId = value === undefined ? internalValue : value;
  const currentExpandedIds = expandedIds ?? internalExpandedIds;
  const expanded = useMemo(
    () => new Set(currentExpandedIds),
    [currentExpandedIds],
  );
  const items = useMemo(() => itemsFromChildren(children), [children]);
  const rows = useMemo(() => flattenItems(items, expanded), [expanded, items]);

  // 虚拟滚动：count = 展开后的总行数，只渲染视口 ±overscan；固定行高免动态测量
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Keep a real row tabbable in the first commit and immediately after a
  // collapse removes the previously focused descendant.
  const focusedRow =
    focusedId !== null && rows.some(({ item }) => item.value === focusedId)
      ? focusedId
      : (rows[0]?.item.value ?? null);
  if (focusedId !== focusedRow) setFocusedId(focusedRow);

  const focusRow = useCallback(
    (id: string) => {
      setFocusedId(id);
      // 虚拟化下目标行可能未挂载：先滚进视口，下一帧行挂上后再聚焦
      const index = rows.findIndex((row) => row.item.value === id);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
      const row = rowRefs.current.get(id);
      if (row) row.focus();
      else requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
    },
    [rows, virtualizer],
  );

  const selectItem = useCallback(
    (item: FileTreeItem) => {
      if (item.disabled) return;
      if (value === undefined) setInternalValue(item.value);
      onValueChange?.(item.value);
    },
    [onValueChange, value],
  );

  const setExpanded = useCallback(
    (next: string[]) => {
      if (expandedIds === undefined) setInternalExpandedIds(next);
      onExpandedChange?.(next);
    },
    [expandedIds, onExpandedChange],
  );

  const toggleFolder = useCallback(
    (id: string) => {
      const next = new Set(currentExpandedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpanded(Array.from(next));
    },
    [currentExpandedIds, setExpanded],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, row: FlatFileTreeItem) => {
      const index = rows.findIndex(({ item }) => item.value === row.item.value);
      const previous = rows[index - 1];
      const next = rows[index + 1];
      const isFolder = row.item.type === "folder";
      const isOpen = expanded.has(row.item.value);

      if (event.key === "ArrowDown" && next) {
        event.preventDefault();
        focusRow(next.item.value);
      } else if (event.key === "ArrowUp" && previous) {
        event.preventDefault();
        focusRow(previous.item.value);
      } else if (event.key === "Home" && rows[0]) {
        event.preventDefault();
        focusRow(rows[0].item.value);
      } else if (event.key === "End" && rows.at(-1)) {
        event.preventDefault();
        focusRow(rows.at(-1)?.item.value ?? row.item.value);
      } else if (event.key === "ArrowRight" && isFolder) {
        event.preventDefault();
        if (!isOpen && !row.item.disabled) toggleFolder(row.item.value);
        else if (next?.parentId === row.item.value) focusRow(next.item.value);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (isFolder && isOpen && !row.item.disabled)
          toggleFolder(row.item.value);
        else if (row.parentId) focusRow(row.parentId);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (row.item.disabled) return;
        selectItem(row.item);
        if (isFolder) toggleFolder(row.item.value);
      }
    },
    [expanded, focusRow, rows, selectItem, toggleFolder],
  );

  // 容器自身是滚动视口（virtualizer 锚定它）。行绝对定位在等高网格上，
  // 只挂载视口 ±overscan 行；hover/选中反馈走行自身的 CSS 底色
  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable={false}
      className={cn(
        "h-full min-w-0 overflow-y-auto p-1.5",
        className,
        classNames?.tree,
      )}
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null; // rows 与 virtualizer 计数短暂不一致的兜底
          const isFolder = row.item.type === "folder";
          const isOpen = isFolder && expanded.has(row.item.value);
          const isSelected = selectedId === row.item.value;

          return (
            <button
              key={row.item.value}
              ref={(node) => {
                if (node) rowRefs.current.set(row.item.value, node);
                else rowRefs.current.delete(row.item.value);
              }}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-posinset={row.position}
              aria-setsize={row.setSize}
              aria-selected={isSelected}
              aria-expanded={isFolder ? isOpen : undefined}
              aria-disabled={row.item.disabled || undefined}
              tabIndex={focusedRow === row.item.value ? 0 : -1}
              onFocus={() => setFocusedId(row.item.value)}
              onKeyDown={(event) => handleKeyDown(event, row)}
              onContextMenu={(event) => {
                if (row.item.disabled) return;
                row.item.onContextMenu?.(event);
              }}
              onDragOver={row.item.onDragOver}
              onDragLeave={row.item.onDragLeave}
              onDrop={row.item.onDrop}
              onClick={() => {
                if (row.item.disabled) return;
                selectItem(row.item);
                if (isFolder) toggleFolder(row.item.value);
              }}
              className={cn(
                "group/file-tree absolute left-0 flex w-full items-center gap-2 overflow-hidden rounded-lg pr-2 text-left text-sm text-muted-foreground outline-none",
                "transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                "aria-disabled:cursor-not-allowed",
                row.item.disabled && "opacity-[0.42]",
                isSelected && "bg-muted font-medium text-foreground",
                classNames?.item,
                row.item.className,
              )}
              style={{
                top: vi.start,
                height: ROW_HEIGHT,
                paddingLeft: 8 + row.depth * indent,
              }}
            >
              {row.depth > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-0 bottom-0 w-px bg-border/70"
                  style={{ left: 16 + (row.depth - 1) * indent }}
                />
              ) : null}

              <motion.span
                aria-hidden="true"
                animate={{ rotate: isOpen ? 90 : 0 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className={cn(
                  "relative z-10 grid size-4 shrink-0 place-items-center",
                  !isFolder && "opacity-0",
                )}
              >
                <ChevronRight className="size-3.5" />
              </motion.span>

              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 grid size-4 shrink-0 place-items-center text-muted-foreground transition-colors group-hover/file-tree:text-foreground",
                  isFolder && isOpen && "text-foreground",
                  classNames?.icon,
                )}
              >
                {row.item.icon ?? <DefaultIcon item={row.item} open={isOpen} />}
              </span>

              <span
                className={cn(
                  "relative z-10 min-w-0 flex-1 truncate",
                  classNames?.label,
                )}
              >
                {row.item.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
