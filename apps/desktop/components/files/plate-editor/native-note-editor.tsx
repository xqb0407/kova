"use client";

/**
 * 原生笔记（`.knote`）编辑器：Plate Value 直接来自 envelope.blocks，
 * 不经过 Markdown 字符串回写。Markdown 只作为保存时的兼容缓存。
 *
 * 与 Markdown 兼容编辑器共用插件、工具栏、斜杠菜单、块拖拽和图片落库；
 * 区别是这里不再持有 frontmatter/源码态，标题/图标来自 envelope。
 */

import "@/app/styles/plate-editor.css";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { KEYS, type Descendant, type TRange, type Value } from "platejs";
import {
  Plate,
  PlateContent,
  usePlateEditor,
  type PlateEditor,
} from "platejs/react";
import {
  PlateEditorBridgeContext,
  type PlateEditorBridge,
} from "./editor-context";
import { PLATE_PLUGINS } from "./plugins";
import { markdownFromNativeValue } from "@/lib/notes/native-markdown";
import { PlateToolbar } from "./toolbar";
import { PlateFloatingToolbar } from "./floating-toolbar";
import { PlateSlashMenu } from "./slash-menu";
import { NoteIcon, NoteTitleGate } from "./markdown-editor";
import {
  isImageFile,
  pickImageForNote,
  uploadImageFiles,
  type InsertedImage,
} from "./image-upload";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { resolveRichImageSrc } from "@/lib/markdown/rich-markdown";

export interface NativeNoteEditorHandle {
  focus: () => void;
}

export interface NativeNoteEditorProps {
  /** 当前磁盘上的 blocks（仅首次挂载使用；外部重载由宿主 remount） */
  blocks: Descendant[];
  editable?: boolean;
  cwd: string;
  rel: string;
  /** 页面标题（文件名去扩展名）；提交后走文件重命名 */
  title: string;
  onRename?: (nextTitle: string) => Promise<boolean>;
  icon?: string | null;
  onIconChange?: (icon: string | null) => void;
  imagePickEnabled?: boolean;
  cover?: string | null;
  onCoverChange?: (cover: string | null) => void;
  onChange: (blocks: Descendant[], markdown: string) => void;
  /** 工具栏右侧固定簇（保存状态 / 文档级动作）：替代查看器原来的独立状态行 */
  toolbarEnd?: ReactNode;
  /** 标题下的元信息行（标签 / 引用数）：属于文档内容，不占顶栏 */
  meta?: ReactNode;
}

/** 剪贴板/拖放里的图片：优先 files，部分平台只给 items */
function filesFromTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export const NativeNoteEditor = forwardRef<
  NativeNoteEditorHandle,
  NativeNoteEditorProps
>(function NativeNoteEditor(
  {
    blocks,
    editable = true,
    cwd,
    rel,
    title,
    onRename,
    icon,
    onIconChange,
    imagePickEnabled = false,
    cover,
    onCoverChange,
    onChange,
    toolbarEnd,
    meta,
  },
  ref,
) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialBlocksRef = useRef<Descendant[]>(blocks);
  /** 首次真实交互前不回写（初始化规范化不应触发自动保存） */
  const userInteractedRef = useRef(false);
  const lastBlocksJsonRef = useRef(JSON.stringify(blocks));
  const lastMarkdownRef = useRef("");

  const editor = usePlateEditor({
    plugins: PLATE_PLUGINS,
    // envelope 已校验为块数组；顶层 Descendant 在 Plate 里即 Value
    value: initialBlocksRef.current as Value,
  });
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const bridge = useMemo<PlateEditorBridge>(
    () => ({
      nativeNote: true,
      resolveImageSrc: (src) => resolveRichImageSrc(cwd, rel, src),
      pickImage: imagePickEnabled
        ? () => pickImageForNote(cwd, rel)
        : undefined,
      uploadImageFiles: cwd
        ? (files) => uploadImageFiles(cwd, rel, files)
        : undefined,
    }),
    [cwd, imagePickEnabled, rel],
  );

  const emitChange = useCallback((current: PlateEditor) => {
    if (!userInteractedRef.current) return;
    const nextBlocks = current.children as Descendant[];
    const json = JSON.stringify(nextBlocks);
    if (json === lastBlocksJsonRef.current) return;
    lastBlocksJsonRef.current = json;
    let markdown = lastMarkdownRef.current;
    try {
      markdown = markdownFromNativeValue(current, nextBlocks);
      lastMarkdownRef.current = markdown;
    } catch {
      // 高级节点暂时没有 Markdown 映射：保留上一次缓存，绝不因此丢正文
    }
    onChangeRef.current(nextBlocks, markdown);
  }, []);

  // 首次真实交互后才允许回写
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mark = () => {
      userInteractedRef.current = true;
    };
    const events = [
      "pointerdown",
      "keydown",
      "beforeinput",
      "paste",
      "drop",
    ];
    for (const event of events) root.addEventListener(event, mark, true);
    return () => {
      for (const event of events) root.removeEventListener(event, mark, true);
    };
  }, []);

  // ---- 图片粘贴/拖入 ----------------------------------------------------
  const insertImages = useCallback(
    async (files: File[], at?: TRange) => {
      const images = files.filter(isImageFile);
      if (images.length === 0) return;
      let inserted: InsertedImage[] = [];
      const uploader = bridge.uploadImageFiles;
      if (uploader) {
        inserted = await uploader(images);
      } else {
        inserted = await Promise.all(
          images.map(async (file) => ({
            src: await fileToDataUrl(file),
            alt: file.name.replace(/[[\]\r\n]+/g, " ").trim() || "image",
          })),
        );
      }
      if (inserted.length === 0) return;
      const nodes = inserted.map((image) => ({
        type: KEYS.img,
        url: image.src,
        caption: [{ text: image.alt }],
        children: [{ text: "" }],
      }));
      editor.tf.insertNodes(nodes, {
        at: at ?? editor.selection ?? undefined,
        select: true,
      });
      editor.tf.insertNodes(editor.api.create.block(), { select: true });
      editor.tf.focus();
    },
    [bridge.uploadImageFiles, editor],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = filesFromTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void insertImages(files, editor.selection ?? undefined);
    };
    const onDrop = (event: DragEvent) => {
      const files = filesFromTransfer(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      let at: TRange | undefined;
      try {
        at = editor.api.findEventRange(event) ?? undefined;
      } catch {
        at = undefined;
      }
      if (at) editor.tf.select(at);
      void insertImages(files, at ?? editor.selection ?? undefined);
    };
    root.addEventListener("paste", onPaste, true);
    root.addEventListener("drop", onDrop, true);
    return () => {
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("drop", onDrop, true);
    };
  }, [editor, insertImages]);

  const pickCover = useCallback(async () => {
    if (!imagePickEnabled) return;
    const picked = await pickImageForNote(cwd, rel);
    if (picked) onCoverChange?.(picked.src);
  }, [cwd, imagePickEnabled, onCoverChange, rel]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor.tf.focus();
      },
    }),
    [editor],
  );

  return (
    <PlateEditorBridgeContext.Provider value={bridge}>
      {/* min-h-full：编辑器根随正文长高，滚动交给外层 overflow 容器；
          固定 h-full 会让内容溢出却没有滚动容器（表现为整页滚不动） */}
      <div ref={rootRef} className="kova-plate-editor min-h-full">
        {mounted ? (
          <Plate
            editor={editor}
            readOnly={!editable}
            onValueChange={({ editor: current }) => emitChange(current)}
          >
            <div className="sticky top-0 z-30 bg-background">
              <PlateToolbar end={toolbarEnd} />
            </div>
            <PlateFloatingToolbar searching={false} />
            <PlateSlashMenu allowNativeBlocks />
            <div className="px-12 pt-10 pb-24">
              <div className="group/cover relative mx-auto w-full max-w-[70rem]">
                {cover ? (
                  <div className="group/cover relative -mt-4 mb-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={resolveRichImageSrc(cwd, rel, cover)}
                      alt=""
                      draggable={false}
                      className="h-44 w-full rounded-xl object-cover"
                    />
                    {editable && imagePickEnabled ? (
                      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover/cover:opacity-100">
                        <button
                          type="button"
                          onClick={() => void pickCover()}
                          className="bg-background/90 text-foreground hover:bg-background rounded-md px-2 py-1 text-xs shadow-sm"
                        >
                          {t("library.editor.changeCover")}
                        </button>
                        <button
                          type="button"
                          aria-label={t("library.editor.removeCover")}
                          onClick={() => onCoverChange?.(null)}
                          className="bg-background/90 text-muted-foreground hover:text-foreground grid size-7 place-items-center rounded-md shadow-sm"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex items-start justify-between">
                  <NoteIcon
                    icon={icon}
                    onChange={editable ? onIconChange : undefined}
                  />
                  {!cover && editable && imagePickEnabled ? (
                    <button
                      type="button"
                      onClick={() => void pickCover()}
                      className="text-muted-foreground hover:bg-hover hover:text-foreground mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs opacity-0 transition-opacity group-hover/cover:opacity-100 focus-visible:opacity-100"
                    >
                      <ImagePlusIcon className="size-3.5" />
                      {t("library.editor.addCover")}
                    </button>
                  ) : null}
                </div>
                <NoteTitleGate title={title} onRename={onRename} />
                {meta ? (
                  /* 标签/引用数等元信息贴着标题：这是文档属性，不是工具栏控件 */
                  <div className="mb-7 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {meta}
                  </div>
                ) : null}
                <PlateContent
                  aria-label={t("library.editor.editorAria")}
                  className="w-full text-ui-lg leading-7 outline-none"
                />
              </div>
            </div>
          </Plate>
        ) : (
          <div className="min-h-[40vh]" aria-hidden />
        )}
      </div>
    </PlateEditorBridgeContext.Provider>
  );
});
