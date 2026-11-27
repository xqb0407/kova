"use client";

/**
 * Plate 块级拖拽手柄（Notion 左侧 + / ⠿）。
 *
 * 基于官方 DndPlugin/useDraggable：拖拽时由插件生成预览与落点线；
 * 这里只负责手柄 UI、整块高度对齐和「在下方插入块」。
 */

import {
  type PlateElementProps,
  type RenderNodeWrapper,
  MemoizedChildren,
  useEditorRef,
  useElement,
} from "platejs/react";
import { useDraggable, useDropLine } from "@platejs/dnd";
import { GripVertical, Plus, Trash2Icon, CopyIcon } from "lucide-react";
import { KEYS, PathApi, type TElement } from "platejs";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const UNDRAGGABLE_TYPES = new Set<string>([
  KEYS.tr,
  KEYS.td,
  KEYS.th,
  KEYS.codeLine,
]);

export const BlockDraggable: RenderNodeWrapper = (props) => {
  if (props.path.length !== 1) return;
  if (UNDRAGGABLE_TYPES.has(props.element.type as string)) return;
  return (props) => <Draggable {...props} />;
};

function Draggable(props: PlateElementProps) {
  const { children, element } = props;
  const editor = useEditorRef();
  const { isDragging, nodeRef, handleRef } = useDraggable({ element });
  const { dropLine } = useDropLine({ id: element.id as string });

  return (
    <div
      ref={nodeRef}
      className={cn(
        "group/block relative",
        isDragging && "opacity-50",
      )}
    >
      <Gutter
        handleRef={handleRef}
        isDragging={isDragging}
      />
      <MemoizedChildren>{children}</MemoizedChildren>
      {dropLine ? (
        <div
          contentEditable={false}
          className={cn(
            "bg-primary pointer-events-none absolute inset-x-0 z-10 h-0.5",
            dropLine === "top" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
    </div>
  );
}

function Gutter({
  handleRef,
  isDragging,
}: {
  handleRef: (node: HTMLElement | null) => void;
  isDragging: boolean;
}) {
  const editor = useEditorRef();
  const current = useElement();
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  /** 菜单展开方向：默认向下，视口下方放不下且上方放得下时向上翻 */
  const [menuPlacement, setMenuPlacement] = useState<"bottom" | "top">("bottom");
  const menuRef = useRef<HTMLDivElement>(null);

  // 菜单 z-50 只在 gutter 自己的层叠上下文里生效：相邻块的 gutter 也是 z-20
  // 且 DOM 更靠后，会整层画在菜单上面（手柄透过菜单露出来）。打开时把整个
  // gutter 抬到 z-50，压过所有兄弟 gutter。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen]);

  // 打开后（绘制前）量一次：下方放不下、上方放得下就翻到上面
  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.top;
    if (rect.height > spaceBelow && rect.top > rect.height) {
      setMenuPlacement("top");
    } else {
      setMenuPlacement("bottom");
    }
  }, [menuOpen]);

  const currentPath = () => editor.api.findPath(current);

  const addBlockBelow = () => {
    const path = currentPath();
    if (!path) return;
    editor.tf.insertNodes(
      { type: KEYS.p, children: [{ text: "/" }] },
      { at: PathApi.next(path), select: true },
    );
    editor.tf.focus();
  };

  const duplicate = () => {
    const path = currentPath();
    if (!path) return;
    editor.tf.duplicateNodes({ at: path, block: true });
    setMenuOpen(false);
  };

  const remove = () => {
    const path = currentPath();
    if (!path) return;
    editor.tf.removeNodes({ at: path });
    setMenuOpen(false);
  };

  const turnInto = (type: string) => {
    const path = currentPath();
    if (!path) return;
    const textBlocks = new Set<string>([
      KEYS.p,
      ...KEYS.heading,
      KEYS.blockquote,
    ]);
    if (!textBlocks.has(current.type as string)) return;
    if (current.type === KEYS.blockquote) {
      // 引用是容器：先脱掉 blockquote，再把里面的段落改成目标块
      editor.tf.unwrapNodes({
        at: path,
        match: { type: KEYS.blockquote },
      });
      editor.tf.setNodes({ type }, { at: path });
    } else {
      editor.tf.setNodes({ type }, { at: path });
    }
    editor.tf.focus();
    setMenuOpen(false);
  };

  const canTurnInto = new Set<string>([
    KEYS.p,
    ...KEYS.heading,
    KEYS.blockquote,
  ]).has(current.type as string);

  return (
    <div
      contentEditable={false}
      className={cn(
        "group/gutter absolute top-0 -left-16 flex h-8 items-center gap-0.5",
        "pointer-events-auto opacity-0 transition-opacity",
        "group-hover/block:opacity-100 group-focus-within/block:opacity-100",
        (isDragging || menuOpen) && "opacity-100",
        menuOpen ? "z-50" : "z-20",
      )}
    >
      <button
        type="button"
        aria-label={t("library.editor.drag.addBlock")}
        title={t("library.editor.drag.addBlock")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={addBlockBelow}
        className="text-muted-foreground hover:bg-hover hover:text-foreground pointer-events-none inline-flex size-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover/gutter:pointer-events-auto group-hover/gutter:opacity-100"
      >
        <Plus className="size-4" />
      </button>
      <button
        ref={handleRef}
        type="button"
        aria-label={t("library.editor.drag.menuAria")}
        title={t("library.editor.drag.menuAria")}
        onClick={() => {
          const path = currentPath();
          if (!path) return;
          // 用块内第一个文本点，而不是 { path, offset: 0 }：后者对表格/
          // 图片等非文本块会造出非法选区，mark 查询时直接崩。
          if (current.type !== KEYS.img && current.type !== KEYS.hr) {
            const start = editor.api.start(path);
            if (start) editor.tf.select(start);
          }
          editor.tf.focus();
          setMenuOpen((open) => !open);
        }}
        className="text-muted-foreground hover:bg-hover hover:text-foreground inline-flex size-6 cursor-grab items-center justify-center rounded-md active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("library.editor.drag.menuAria")}
          className={cn(
            // font-sans 显式钉应用字体：菜单挂在编辑器子树里，防继承链偏差
            "bg-popover text-popover-foreground border-border absolute left-0 z-50 w-44 font-sans overflow-hidden rounded-lg border p-1 shadow-lg",
            // 视口内兜底：极矮窗口下再不够放就内部滚动
            "max-h-[min(16rem,calc(100vh-2rem))] overflow-y-auto",
            menuPlacement === "top" ? "bottom-8" : "top-8",
          )}
        >
          <button
            type="button"
            role="menuitem"
            onClick={duplicate}
            className="hover:bg-hover flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
          >
            <CopyIcon className="text-muted-foreground size-3.5" />
            {t("library.editor.drag.duplicate")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={remove}
            className="hover:bg-hover text-destructive flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
          >
            <Trash2Icon className="size-3.5" />
            {t("library.editor.drag.delete")}
          </button>
          {canTurnInto ? (
            <>
              <div className="bg-border my-1 h-px" />
              {[
                { type: KEYS.p, label: t("library.editor.block.paragraph") },
                { type: KEYS.h1, label: t("library.editor.block.heading1") },
                { type: KEYS.h2, label: t("library.editor.block.heading2") },
                { type: KEYS.h3, label: t("library.editor.block.heading3") },
              ].map((item) => (
                <button
                  key={item.type}
                  type="button"
                  role="menuitem"
                  onClick={() => turnInto(item.type)}
                  className="hover:bg-hover flex w-full items-center rounded-lg px-2 py-1.5 text-left text-sm"
                >
                  {item.label}
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
