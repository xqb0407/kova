"use client";

/**
 * 资料库 Markdown 富文本编辑器（Plate 内核）。
 *
 * FileViewer 通过 props/handle 接入（自动保存、查找替换、目录、图片落库）；
 * 职责：
 * - frontmatter 原文保留，只在用户真实交互后回写；
 * - 外部重载同步（不与自动保存互相覆盖）；
 * - 查找/替换、目录、图片落库、粘贴/拖入图片；
 * - 工具栏 / 浮动工具栏 / 斜杠菜单 / 块拖拽由子组件提供。
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
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { KEYS, type TRange } from "platejs";
import {
  Plate,
  PlateContent,
  useEditorSelector,
  usePlateEditor,
  useRedecorate,
  type PlateEditor,
} from "platejs/react";
import {
  PlateEditorBridgeContext,
  type PlateEditorBridge,
} from "./editor-context";
import {
  PLATE_PLUGINS,
  markdownFromPlate,
  plateValueFromMarkdown,
} from "./plugins";
import { PlateToolbar } from "./toolbar";
import { PlateFloatingToolbar } from "./floating-toolbar";
import { PlateSlashMenu } from "./slash-menu";
import {
  activePlateHeading,
  collectPlateHeadings,
  collectPlateMatches,
  replacePlateRange,
  scrollPlateHeadingIntoView,
  scrollPlateRangeIntoView,
  setPlateSearchHighlight,
  type PlateHeading,
} from "./search";
import {
  isImageFile,
  pickImageForNote,
  uploadImageFiles,
  type InsertedImage,
} from "./image-upload";
import { SmilePlus } from "lucide-react";
import { DicebearIconPicker } from "@/components/custom-ui/dicebear-icon-picker";
import { NoteIconGlyph } from "@/components/files/note-icon-glyph";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  resolveRichImageSrc,
  splitEditorMarkdown,
  type EditorMarkdownParts,
} from "@/lib/markdown/rich-markdown";
import { tocEqual, type TocEntry } from "@/lib/markdown/toc";

export interface PlateMarkdownEditorHandle {
  focus: () => void;
  search: (query: string) => void;
  searchNext: () => void;
  searchPrev: () => void;
  replace: (value: string) => void;
  replaceAll: (value: string) => void;
  clearSearch: () => void;
  scrollToHeading: (id: string) => void;
}

export interface PlateMarkdownEditorProps {
  /** 完整 Markdown（含 frontmatter）；外部重载时变化 */
  value: string;
  editable?: boolean;
  cwd: string;
  rel: string;
  /** 笔记标题（文件名去扩展名）；编辑后走文件重命名 */
  title?: string;
  onRename?: (nextTitle: string) => Promise<boolean>;
  /** 页面图标（frontmatter.icon） */
  icon?: string | null;
  onIconChange?: (icon: string | null) => void;
  searching?: boolean;
  imagePickEnabled?: boolean;
  findQuery?: string;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  onChange: (markdown: string) => void;
  onFindResult?: (count: number, index: number) => void;
  onTocChange?: (entries: TocEntry[]) => void;
  onActiveHeadingChange?: (id: string) => void;
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

/**
 * frontmatter 与正文之间保留一个空行。
 * Plate 序列化不会带正文开头的空行，直接拼会把 `---` 和标题贴在一起；
 * 而 joinEditorMarkdown 的单测约定是「不给空行就不补」，所以这里单独处理。
 */
function joinWithFrontmatter(raw: string, body: string): string {
  if (!raw) return body;
  if (!body) return raw;
  if (body.startsWith("\n")) return `${raw}${body}`;
  return raw.endsWith("\n\n") ? `${raw}${body}` : `${raw}\n${body}`;
}

/** useRedecorate 必须在 <Plate> 内部调用；把函数交给外层查找逻辑使用 */
function PlateRedecorateBridge({
  target,
}: {
  target: MutableRefObject<() => void>;
}) {
  const redecorate = useRedecorate();
  useEffect(() => {
    target.current = redecorate;
    return () => {
      target.current = () => {};
    };
  }, [redecorate, target]);
  return null;
}

/** Notion 式页面图标：点开用 DiceBear 图标网格选一个，写入 frontmatter.icon */
export function NoteIcon({
  icon,
  onChange,
}: {
  icon?: string | null;
  onChange?: (icon: string | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  if (!onChange) {
    return icon ? (
      <div className="mb-2">
        <NoteIconGlyph icon={icon} />
      </div>
    ) : null;
  }

  return (
    <div ref={rootRef} className="relative mb-2 flex">
      <button
        type="button"
        aria-label={t("library.editor.iconAria")}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "hover:bg-hover inline-flex items-center rounded-md transition-colors",
          icon
            ? "leading-none"
            : "text-muted-foreground hover:bg-hover hover:text-foreground gap-1 px-1 py-0.5 text-xs",
        )}
      >
        {icon ? (
          <NoteIconGlyph icon={icon} />
        ) : (
          <>
            <SmilePlus className="size-4" />
            {t("library.editor.addIcon")}
          </>
        )}
      </button>
      {open ? (
        <div className="bg-popover text-popover-foreground border-border absolute top-full left-0 z-50 mt-1 font-sans rounded-lg border p-2 shadow-lg">
          <DicebearIconPicker
            value={icon}
            onChange={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 页面大标题：文件名去扩展名，回车/失焦落盘改名 */
export function NoteTitle({
  title,
  onRename,
}: {
  title: string;
  onRename?: (nextTitle: string) => Promise<boolean>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commit = async () => {
    if (busy) return;
    const next = draft.trim();
    if (!onRename || !next || next === title) {
      setDraft(title);
      return;
    }
    setBusy(true);
    const ok = await onRename(next);
    setBusy(false);
    if (!ok) setDraft(title);
  };

  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(title);
          event.currentTarget.blur();
        }
      }}
      disabled={!onRename || busy}
      aria-label={t("library.editor.titleAria")}
      placeholder={t("library.editor.untitled")}
      spellCheck={false}
      className="text-foreground placeholder:text-muted-foreground/40 mb-3 w-full min-w-0 border-none bg-transparent text-[34px] leading-[1.2] font-bold tracking-tight outline-none disabled:opacity-100"
    />
  );
}

/**
 * 文档已经以 H1 开头时，H1 本身就是页面标题，不再叠一个文件名大标题；
 * 空文档/无 H1 的笔记才显示可改名的标题输入。
 */
export function NoteTitleGate({
  title,
  onRename,
}: {
  title: string;
  onRename?: (nextTitle: string) => Promise<boolean>;
}) {
  const hasLeadingH1 = useEditorSelector((editor) => {
    const first = editor.children[0];
    return Boolean(first && "type" in first && first.type === KEYS.h1);
  }, []);
  if (hasLeadingH1) return null;
  return <NoteTitle title={title} onRename={onRename} />;
}

export const PlateMarkdownEditor = forwardRef<
  PlateMarkdownEditorHandle,
  PlateMarkdownEditorProps
>(function PlateMarkdownEditor(
  {
    value,
    editable = true,
    cwd,
    rel,
    title,
    onRename,
    icon,
    onIconChange,
    searching = false,
    imagePickEnabled = false,
    findQuery = "",
    scrollContainerRef,
    onChange,
    onFindResult,
    onTocChange,
    onActiveHeadingChange,
    toolbarEnd,
    meta,
  },
  ref,
) {
  const t = useT();
  const initialPartsRef = useRef<EditorMarkdownParts | null>(null);
  if (initialPartsRef.current === null) {
    initialPartsRef.current = splitEditorMarkdown(value);
  }
  const initialBody = initialPartsRef.current.body;
  const frontmatterRef = useRef(initialPartsRef.current.raw);
  const lastEmittedRef = useRef(value);
  const suppressEmitRef = useRef(false);
  /** 首次真实交互前不回写（初始化规范化不应触发自动保存） */
  const userInteractedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFindResultRef = useRef(onFindResult);
  onFindResultRef.current = onFindResult;
  const onTocChangeRef = useRef(onTocChange);
  onTocChangeRef.current = onTocChange;
  const onActiveHeadingRef = useRef(onActiveHeadingChange);
  onActiveHeadingRef.current = onActiveHeadingChange;

  const initialValue = useMemo(
    () => (editor: PlateEditor) =>
      plateValueFromMarkdown(editor, initialBody),
    [initialBody],
  );
  const editor = usePlateEditor({
    plugins: PLATE_PLUGINS,
    value: initialValue,
  });
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const redecorateRef = useRef<() => void>(() => {});
  const bridge = useMemo<PlateEditorBridge>(
    () => ({
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
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  // ---- 目录 -------------------------------------------------------------
  const headingsRef = useRef<PlateHeading[]>([]);
  const lastTocRef = useRef<TocEntry[]>([]);
  const tocRafRef = useRef(0);

  const reportActiveHeading = useCallback(() => {
    const container = scrollContainerRef?.current;
    if (!container) return;
    onActiveHeadingRef.current?.(
      activePlateHeading(editor, headingsRef.current, container),
    );
  }, [editor, scrollContainerRef]);

  const refreshToc = useCallback(() => {
    const headings = collectPlateHeadings(editor);
    headingsRef.current = headings;
    const entries: TocEntry[] = headings.map((heading) => ({
      id: heading.id,
      label: heading.text.slice(0, 80),
      level: heading.level,
    }));
    if (!tocEqual(lastTocRef.current, entries)) {
      lastTocRef.current = entries;
      onTocChangeRef.current?.(entries);
    }
    // 不用 rAF：窗口被遮挡/后台时 rAF 可能完全不触发，目录会一直空着。
    window.setTimeout(reportActiveHeading, 0);
  }, [editor, reportActiveHeading]);

  const scheduleToc = useCallback(() => {
    if (tocRafRef.current) return;
    tocRafRef.current = window.setTimeout(() => {
      tocRafRef.current = 0;
      refreshToc();
    }, 0);
  }, [refreshToc]);

  // ---- 查找/替换 --------------------------------------------------------
  const searchQueryRef = useRef("");
  const searchMatchesRef = useRef<TRange[]>([]);
  const searchIndexRef = useRef(-1);
  const searchTimerRef = useRef<number | null>(null);

  const markActiveSearch = useCallback((index: number) => {
    window.setTimeout(() => {
      const marks = rootRef.current?.querySelectorAll("mark");
      marks?.forEach((mark, markIndex) => {
        if (markIndex === index) {
          mark.setAttribute("data-search-active", "true");
        } else {
          mark.removeAttribute("data-search-active");
        }
      });
    }, 0);
  }, []);

  const reportSearch = useCallback(() => {
    onFindResultRef.current?.(
      searchMatchesRef.current.length,
      searchIndexRef.current,
    );
    markActiveSearch(searchIndexRef.current);
  }, [markActiveSearch]);

  const applySearch = useCallback(
    (query: string) => {
      searchQueryRef.current = query;
      if (!query.trim()) {
        searchMatchesRef.current = [];
        searchIndexRef.current = -1;
        setPlateSearchHighlight(editor, "", () => redecorateRef.current());
        reportSearch();
        return;
      }
      setPlateSearchHighlight(editor, query, () => redecorateRef.current());
      const matches = collectPlateMatches(editor, query);
      searchMatchesRef.current = matches;
      searchIndexRef.current = matches.length > 0 ? 0 : -1;
      if (matches.length > 0) {
        scrollPlateRangeIntoView(
          editor,
          matches[0]!,
          scrollContainerRef?.current ?? null,
        );
      }
      // 宿主在 query 变化后会把 index 重置为 -1（父级 effect 晚于子级），
      // 延后一个宏任务再上报，避免刚算出的 active=0 被覆盖成「只显示总数」。
      window.setTimeout(reportSearch, 0);
    },
    [editor, reportSearch, scrollContainerRef],
  );

  const refreshSearch = useCallback(() => {
    if (!searchQueryRef.current.trim()) return;
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      const matches = collectPlateMatches(editor, searchQueryRef.current);
      searchMatchesRef.current = matches;
      searchIndexRef.current = matches.length
        ? Math.min(
            Math.max(searchIndexRef.current, 0),
            matches.length - 1,
          )
        : -1;
      reportSearch();
    }, 160);
  }, [editor, reportSearch]);

  const stepSearch = useCallback(
    (delta: 1 | -1) => {
      const matches = searchMatchesRef.current;
      if (!searchQueryRef.current.trim()) return;
      if (matches.length === 0) {
        applySearch(searchQueryRef.current);
        return;
      }
      const next =
        (searchIndexRef.current + delta + matches.length) % matches.length;
      searchIndexRef.current = next;
      scrollPlateRangeIntoView(
        editor,
        matches[next]!,
        scrollContainerRef?.current ?? null,
      );
      reportSearch();
    },
    [applySearch, editor, reportSearch, scrollContainerRef],
  );

  const replaceCurrent = useCallback(
    (replacement: string) => {
      const range = searchMatchesRef.current[searchIndexRef.current];
      if (!range) {
        reportSearch();
        return;
      }
      // 替换可能从 FindBar 触发（编辑器本身没有 pointer/key 交互），
      // 这同样是用户修改，必须允许回写保存。
      userInteractedRef.current = true;
      replacePlateRange(editor, range, replacement);
      const matches = collectPlateMatches(editor, searchQueryRef.current);
      searchMatchesRef.current = matches;
      searchIndexRef.current = matches.length
        ? Math.min(searchIndexRef.current, matches.length - 1)
        : -1;
      if (matches.length > 0 && searchIndexRef.current >= 0) {
        scrollPlateRangeIntoView(
          editor,
          matches[searchIndexRef.current]!,
          scrollContainerRef?.current ?? null,
        );
      }
      reportSearch();
    },
    [editor, reportSearch, scrollContainerRef],
  );

  const replaceAllMatches = useCallback(
    (replacement: string) => {
      const matches = searchMatchesRef.current;
      userInteractedRef.current = true;
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        replacePlateRange(editor, matches[index]!, replacement);
      }
      searchMatchesRef.current = collectPlateMatches(
        editor,
        searchQueryRef.current,
      );
      searchIndexRef.current =
        searchMatchesRef.current.length > 0 ? 0 : -1;
      reportSearch();
    },
    [editor, reportSearch],
  );

  const clearSearch = useCallback(() => {
    searchQueryRef.current = "";
    searchMatchesRef.current = [];
    searchIndexRef.current = -1;
    setPlateSearchHighlight(editor, "", () => redecorateRef.current());
    reportSearch();
  }, [editor, reportSearch]);

  // ---- 回写 -------------------------------------------------------------
  const emitChange = useCallback(
    (current: PlateEditor) => {
      if (!userInteractedRef.current || suppressEmitRef.current) return;
      const body = markdownFromPlate(current);
      const full = joinWithFrontmatter(frontmatterRef.current, body);
      if (full === lastEmittedRef.current) return;
      lastEmittedRef.current = full;
      onChangeRef.current(full);
      scheduleToc();
      refreshSearch();
    },
    [refreshSearch, scheduleToc],
  );

  // 外部重载（watcher / 手动刷新）
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const parts = splitEditorMarkdown(value);
    frontmatterRef.current = parts.raw;
    const currentBody = markdownFromPlate(editor);
    // 比较时忽略正文开头空行：序列化会去掉它，不能因此反复重载
    if (parts.body.replace(/^\n+/, "") !== currentBody) {
      suppressEmitRef.current = true;
      editor.tf.setValue(plateValueFromMarkdown(editor, parts.body));
      queueMicrotask(() => {
        suppressEmitRef.current = false;
      });
      scheduleToc();
      refreshSearch();
    }
    lastEmittedRef.current = value;
  }, [editor, refreshSearch, scheduleToc, value]);

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
      "focusin",
    ];
    for (const event of events) root.addEventListener(event, mark, true);
    return () => {
      for (const event of events) root.removeEventListener(event, mark, true);
    };
  }, []);

  // 宿主 FindBar 的 query 直接驱动（切模式时 query 可能先到）
  useEffect(() => {
    applySearch(findQuery);
  }, [applySearch, findQuery]);

  // 目录滚动高亮
  useEffect(() => {
    const container = scrollContainerRef?.current;
    if (!container) return;
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        reportActiveHeading();
      }, 0);
    };
    reportActiveHeading();
    container.addEventListener("scroll", schedule, { passive: true });
    return () => {
      container.removeEventListener("scroll", schedule);
      if (timer) window.clearTimeout(timer);
    };
  }, [reportActiveHeading, scrollContainerRef]);

  // 首帧目录 + 清理
  useEffect(() => {
    scheduleToc();
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
      if (tocRafRef.current) {
        window.clearTimeout(tocRafRef.current);
        // StrictMode 会先 mount→cleanup→mount：不清零会让下一次
        // scheduleToc 以为已有排队任务而永久跳过，目录永远不出现。
        tocRafRef.current = 0;
      }
    };
  }, [scheduleToc]);

  // ---- 图片粘贴/拖入 ----------------------------------------------------
  const insertImages = useCallback(
    async (files: File[], at?: TRange) => {
      const images = files.filter(isImageFile);
      if (images.length === 0) return;
      let inserted: InsertedImage[] = [];
      const uploader = bridgeRef.current.uploadImageFiles;
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
    [editor],
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

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor.tf.focus();
      },
      search: (query: string) => {
        applySearch(query);
      },
      searchNext: () => stepSearch(1),
      searchPrev: () => stepSearch(-1),
      replace: (replacement: string) => replaceCurrent(replacement),
      replaceAll: (replacement: string) => replaceAllMatches(replacement),
      clearSearch,
      scrollToHeading: (id: string) => {
        const heading = headingsRef.current.find((item) => item.id === id);
        if (!heading) return;
        scrollPlateHeadingIntoView(
          editor,
          heading,
          scrollContainerRef?.current ?? null,
        );
        onActiveHeadingRef.current?.(id);
      },
    }),
    [
      applySearch,
      clearSearch,
      editor,
      replaceAllMatches,
      replaceCurrent,
      scrollContainerRef,
      stepSearch,
    ],
  );

  return (
    <PlateEditorBridgeContext.Provider value={bridge}>
      <div ref={rootRef} className="kova-plate-editor h-full">
        {mounted ? (
          <Plate
            editor={editor}
            readOnly={!editable}
            onValueChange={({ editor: current }) => emitChange(current)}
          >
            <PlateRedecorateBridge target={redecorateRef} />
            <div className="sticky top-0 z-30 ">
              <PlateToolbar end={toolbarEnd} />
            </div>
            <PlateFloatingToolbar searching={searching} />
            <PlateSlashMenu />
            <div className="px-12 pt-10 pb-24">
              <div className="relative mx-auto w-full max-w-[64rem]">
                <NoteIcon icon={icon} onChange={onIconChange} />
                {title !== undefined ? (
                  <NoteTitleGate title={title} onRename={onRename} />
                ) : null}
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
          // 等 hydration 结束再创建 Slate 的 contenteditable：否则首帧 DOM
          // 可能在 hydration 时被替换，Slate 的原生 beforeinput 监听会挂在
          // 已被丢弃的节点上，表现为「能点、能选，但键盘输入无效」。
          <div className="min-h-[40vh]" aria-hidden />
        )}
      </div>
    </PlateEditorBridgeContext.Provider>
  );
});
