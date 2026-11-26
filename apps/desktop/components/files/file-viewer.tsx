"use client";

/**
 * 右侧查看器（资料库页）：左侧树/列表一点，这里即预览；文本类文件就地编辑。
 *
 * 编辑用 CodeMirror（CodeMirrorCode：语法高亮/行号/主题随「外观 → 代码设置」），
 * `editable` + 受控草稿；输入停顿 800ms 防抖自动保存，Cmd/Ctrl+S 立即保存，
 * 切文件（组件按 cwd+rel 重挂载）时把未落盘的草稿落下——不丢字也不需要
 * 记着按保存。
 *
 * 分支：图片（fs_read_file_base64 → data URL，20MB 上限）/ HTML（iframe 沙箱
 * 渲染，可切源码）/ Markdown（渲染预览，可切编辑）/ 代码与纯文本（CodeMirror
 * 编辑）/ 不支持的类型（提示 + 在系统中打开）。
 * 路径经 fs_* 命令（cwd 必须是主进程可信根：资料库根、任务目录、工作区）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertCircleIcon,
  AtSignIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  FolderSearchIcon,
  InfoIcon,
  FileDownIcon,
  Loader2Icon,
  NotebookPenIcon,
  PencilIcon,
} from "lucide-react";
import { CodeMirrorCode, type CodeMirrorReplace } from "@/components/code/cm-code";
import { DotCloud } from "@/components/custom-ui/dot-cloud";
import { BounceSidebar } from "@/components/custom-ui/bounce-sidebar";
import { Segmented } from "@/components/custom-ui/segmented";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { FileManagerIcon } from "./file-manager-icon";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import {
  fsErrorText,
  fsReadFile,
  fsReadFileBase64,
  fsRename,
  fsReveal,
  fsWriteFile,
  imageMimeFor,
} from "@/lib/workspace/fs";
import { canUseLocalFileUrl, localFileUrl } from "@/lib/workspace/local-file-url";
import {
  deriveNoteTitle,
  libraryFileMetaGet,
  libraryFileMetaSet,
} from "@/lib/workspace/library-note-meta";
import {
  knowledgeRefsForPath,
  knowledgeRefsStats,
} from "@/lib/workspace/library-files";
import { NoteTagsEditor } from "./note-tags-editor";
import { FindBar } from "./find-bar";
import {
  FileViewerContextMenu,
  type ViewerMenuState,
} from "./file-viewer-context-menu";
import {
  buildTocEntries,
  tocEqual,
  type TocEntry,
} from "@/lib/markdown/toc";
import {
  checkRichMarkdown,
  type RichFallbackReason,
} from "@/lib/markdown/rich-markdown";
import { readNoteIcon, setNoteIcon } from "@/lib/markdown/note-icon";
import { convertMarkdownFileToNative } from "@/lib/notes/migrate-markdown";
import {
  PlateMarkdownEditor,
  type PlateMarkdownEditorHandle,
} from "./plate-editor/markdown-editor";
import { NativeNoteEditor } from "./plate-editor/native-note-editor";
import {
  isNativeNoteRel,
  nativeNoteBaseName,
  parseNativeNote,
  serializeNativeNote,
  withNativeNotePatch,
  type NativeNoteFile,
} from "@/lib/notes/native-note";
import {
  clearDomFindHighlight,
  findInDom,
  scrollRangeIntoView,
  setDomFindHighlight,
} from "@/lib/markdown/dom-find";

/** 走 Markdown 渲染的文件（其余文本按代码/纯文本编辑） */
const MARKDOWN_RE = /\.(md|markdown)$/i;

/** 走 CodeMirror 语法高亮的扩展名（与 fs.rs TEXT_EXTS 对齐，去掉 md/txt 等纯文本类） */
const CODE_EXTS = new Set([
  "json", "ts", "tsx", "js", "jsx", "py", "rs", "go", "css", "sh", "toml",
  "yaml", "yml", "xml", "html", "htm",
]);

const extOf = (name: string) =>
  name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/** 自动保存防抖（输入停顿多久落盘） */
const AUTOSAVE_DELAY_MS = 800;

/** 查找高亮的 CSS Highlight 注册名：全部命中一份、当前命中一份（叠加更醒目）。
 *  与 thread-find 的 "thread-find" 隔离，互不覆盖 */
const FIND_HIGHLIGHT_NAME = "file-viewer-find";
const FIND_CURRENT_NAME = "file-viewer-find-current";

/* ------------------------------ Markdown 目录 ------------------------------ */

/** SVG 源码 → data URL（用 <img> 渲染：外部资源与脚本都不执行，比 iframe 安全） */
function svgDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, CHUNK));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** base64 → UTF-8：原生笔记用 20MB 的二进制读通道，避免 2MB 文本截断把 JSON 截坏 */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** 笔记标题惰性写入元数据（@ 选择器按标题搜索）：标题变了才写，失败不影响查看 */
async function syncNoteTitle(
  cwd: string,
  rel: string,
  title: string,
): Promise<void> {
  try {
    const meta = await libraryFileMetaGet(cwd, rel);
    if (meta?.title === title) return;
    await libraryFileMetaSet(cwd, rel, { title });
  } catch {
    /* 元数据失败不影响查看 */
  }
}

/** 文件内容就绪后的分支类型 */
type BodyKind =
  | "image"
  | "svg"
  | "html"
  | "markdown"
  | "native-note"
  | "code"
  | "text"
  | "unsupported";

/** 文本体模式：预览（渲染只读）/ 编辑（md 为富文本，其余为 CodeMirror）/ 源码 */
type TextMode = "preview" | "edit" | "source";

function bodyKindOf(name: string): BodyKind {
  // svg 是文本：走"预览（<img> 渲染，脚本不执行）/ 编辑（源码）"双态，
  // 不归图片（图片分支是 base64 二进制读，不给编辑）
  if (/\.svg$/i.test(name)) return "svg";
  if (imageMimeFor(name)) return "image";
  if (/\.html?$/i.test(name)) return "html";
  if (isNativeNoteRel(name)) return "native-note";
  if (MARKDOWN_RE.test(name)) return "markdown";
  if (CODE_EXTS.has(extOf(name))) return "code";
  // fs.rs TEXT_EXTS 的其余成员（txt/csv/log 等）按纯文本编辑
  if (["txt", "csv", "log", "ini", "conf", "env"].includes(extOf(name))) return "text";
  return "unsupported";
}

/** 查看器外壳：选中态切换时按 cwd+rel 重挂载内容体（草稿/模式随文件重置） */
export const FileViewer: FC<{
  cwd: string | null;
  rel: string | null;
  /** 展示名（列表里可能是覆盖名，树行名即磁盘名） */
  name: string;
  /** 未选中文件时的空态追加动作（资料库给「新建笔记 / 导入」快捷入口） */
  emptyActions?: ReactNode;
  /** 数值变化即重读盘上内容（页面工具条的刷新与文件树刷新同源；查看器不再单独放一枚"重新加载"） */
  reloadSignal?: number;
  /** 「引用到对话」：带行号 = 选区引用，不带 = 整文件。只由资料库根传入（AI 产物不参与引用） */
  onReference?: (range?: { startLine: number; endLine: number }) => void;
  /** 元数据（标题/标签）行：同样只对资料库根启用 */
  metaEnabled?: boolean;
  /** 点击文件名改名：成功后把新 rel/name 交回页面（更新选中/树/元数据） */
  onRenamed?: (newRel: string, newName: string) => void;
  className?: string;
}> = ({
  cwd,
  rel,
  name,
  emptyActions,
  reloadSignal,
  onReference,
  metaEnabled,
  onRenamed,
  className,
}) => {
  const t = useT();
  if (!cwd || rel === null) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center",
          className,
        )}
      >
        {/* 与搜索页空态同一套「点阵云 + 毛玻璃图标」：资料库缺省页不再是一枚孤零零的小图标 */}
        <div className="relative -mb-1 grid place-items-center">
          <DotCloud />
          <div className="absolute grid size-14 place-items-center rounded-2xl backdrop-blur-sm">
            <EyeIcon className="text-muted-foreground/70 size-6" strokeWidth={1.75} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs select-none">
          {t("library.viewer.empty")}
        </p>
        {emptyActions && (
          <div className="mt-1 flex items-center gap-2">{emptyActions}</div>
        )}
      </div>
    );
  }
  return (
    <ViewerBody
      key={`${cwd}\u0000${rel}`}
      cwd={cwd}
      rel={rel}
      name={name}
      reloadSignal={reloadSignal}
      onReference={onReference}
      metaEnabled={metaEnabled}
      onRenamed={onRenamed}
      className={className}
    />
  );
};

const ViewerBody: FC<{
  cwd: string;
  rel: string;
  name: string;
  reloadSignal?: number;
  onReference?: (range?: { startLine: number; endLine: number }) => void;
  metaEnabled?: boolean;
  onRenamed?: (newRel: string, newName: string) => void;
  className?: string;
}> = ({
  cwd,
  rel,
  name,
  reloadSignal,
  onReference,
  metaEnabled,
  onRenamed,
  className,
}) => {
  const t = useT();
  const kind = bodyKindOf(name);
  const [load, setLoad] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "too-large" }
    | { status: "ready"; text: string; truncated: boolean; binary: boolean }
    | { status: "image"; url: string }
  >({ status: "loading" });
  /** 换文件才进 loading；reloadSignal（watcher/手动刷新）静默重读，不卸载编辑器 */
  const fileKey = `${cwd}\u0000${rel}\u0000${kind}`;
  const lastFileKeyRef = useRef(fileKey);

  useEffect(() => {
    let alive = true;
    const isNewFile = lastFileKeyRef.current !== fileKey;
    lastFileKeyRef.current = fileKey;
    if (isNewFile) setLoad({ status: "loading" });
    if (kind === "image") {
      void fsReadFileBase64(cwd, rel).then((r) => {
        if (!alive) return;
        if (r === "too-large") setLoad({ status: "too-large" });
        else if (!r) setLoad({ status: "error" });
        else
          setLoad({
            status: "image",
            url: `data:${imageMimeFor(name) ?? "image/png"};base64,${r.base64}`,
          });
      });
      return () => {
        alive = false;
      };
    }
    if (kind === "unsupported") {
      setLoad({ status: "ready", text: "", truncated: false, binary: true });
      return () => {
        alive = false;
      };
    }
    if (kind === "native-note") {
      // 原生笔记是完整 JSON：用 base64 读通道拿全量（文本通道 2MB 会截断）
      void fsReadFileBase64(cwd, rel).then((r) => {
        if (!alive) return;
        if (r === "too-large") setLoad({ status: "too-large" });
        else if (!r) setLoad({ status: "error" });
        else
          setLoad({
            status: "ready",
            text: decodeBase64Utf8(r.base64),
            truncated: false,
            binary: false,
          });
      });
      return () => {
        alive = false;
      };
    }
    void fsReadFile(cwd, rel).then((r) => {
      if (!alive) return;
      if (!r) setLoad({ status: "error" });
      else {
        setLoad({
          status: "ready",
          text: r.content,
          truncated: r.truncated,
          binary: r.binary,
        });
        // 笔记标题惰性写入元数据（@ 选择器按标题搜索用）；非 markdown 不派生
        if (metaEnabled && MARKDOWN_RE.test(name)) {
          void syncNoteTitle(cwd, rel, deriveNoteTitle(r.content, name));
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [cwd, rel, name, kind, reloadSignal, metaEnabled]);

  // 整文件引用前先落盘草稿（选区引用同样）：行号与内容必须对应磁盘上的文件。
  // TextBody 挂载时把 flush 交上来；图片/二进制/加载中没有草稿，直接引用。
  const flushTextRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerFlush = useCallback(
    (fn: (() => Promise<boolean>) | null) => {
      flushTextRef.current = fn;
    },
    [],
  );
  /** 原生笔记改名前的回调：先把新标题写进 envelope，再 fs_rename */
  const prepareRenameRef = useRef<
    ((nextBase: string) => Promise<boolean>) | null
  >(null);
  const registerPrepareRename = useCallback(
    (fn: ((nextBase: string) => Promise<boolean>) | null) => {
      prepareRenameRef.current = fn;
    },
    [],
  );
  const referenceWhole = async () => {
    if (load.status === "error") return;
    const ok = flushTextRef.current ? await flushTextRef.current() : true;
    if (ok) onReference?.();
  };

  const reveal = async () => {
    const err = await fsReveal(cwd, rel);
    if (err) toast.error(fsErrorText(err));
  };

  // 点击文件名改名：Enter/失焦提交，Esc 取消；成功后把新 rel/name 交回页面
  // （页面更新选中项、刷新树、迁移标签元数据）。
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const renameCancelledRef = useRef(false);
  /** Enter 提交后失焦可能再触发一次 blur：防重复 fs_rename */
  const renameCommittingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const startRename = () => {
    if (!onRenamed) return;
    renameCancelledRef.current = false;
    renameCommittingRef.current = false;
    setDraftName(name);
    setRenaming(true);
  };

  useEffect(() => {
    if (!renaming) return;
    const input = nameInputRef.current;
    if (!input) return;
    input.focus();
    // 默认只选中主文件名，保留扩展名（`.env` 这类隐藏文件则全选）
    const dot = name.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [renaming, name]);

  /** 统一的改名落盘：顶栏重命名与大标题共用 */
  const renameTo = async (nextName: string): Promise<boolean> => {
    const next = nextName.trim();
    if (!next || next === name) return false;
    if (/[\\/:*?"<>|]/.test(next)) {
      toast.error(t("library.viewer.badFileName"));
      return false;
    }
    // 原生笔记：标题写在文件里，先改 envelope.title 再重命名
    const dot = next.lastIndexOf(".");
    const nextBase = dot > 0 ? next.slice(0, dot) : next;
    if (prepareRenameRef.current) {
      const prepared = await prepareRenameRef.current(nextBase);
      if (!prepared) return false;
    }
    // 改名后组件按新 rel 重挂载并读盘：先把未保存草稿落下，避免丢最后一段输入
    const flushed = flushTextRef.current ? await flushTextRef.current() : true;
    if (!flushed) return false;
    const err = await fsRename(cwd, rel, next);
    if (err) {
      toast.error(fsErrorText(err));
      return false;
    }
    const slash = rel.lastIndexOf("/");
    const parent = slash < 0 ? "" : rel.slice(0, slash);
    onRenamed?.(parent ? `${parent}/${next}` : next, next);
    return true;
  };

  const commitRename = async () => {
    if (!renaming || renameCommittingRef.current) return;
    renameCommittingRef.current = true;
    const next = draftName.trim();
    setRenaming(false);
    try {
      if (renameCancelledRef.current) {
        renameCancelledRef.current = false;
        return;
      }
      await renameTo(next);
    } finally {
      renameCommittingRef.current = false;
    }
  };

  return (
    <div className={cn("flex h-full min-w-0 flex-col", className)}>
      {/* 顶栏：文件名 + 相对路径；右侧动作 */}
      <div className="border-border/60 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FileTypeIcon path={name} className="size-4 shrink-0" />
        {renaming ? (
          <input
            ref={nameInputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              // IME 组合中：回车是确认候选词，不是提交重命名
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                renameCancelledRef.current = true;
                setRenaming(false);
              }
            }}
            onBlur={() => void commitRename()}
            aria-label={t("library.viewer.renameAria")}
            spellCheck={false}
            className="border-border/70 bg-background focus:border-ring h-6 w-56 min-w-0 rounded-md border px-1.5 text-sm font-medium outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={startRename}
            disabled={!onRenamed}
            title={onRenamed ? t("library.viewer.renameHint") : name}
            className={cn(
              "min-w-0 truncate text-left text-sm font-medium",
              onRenamed &&
                "hover:decoration-muted-foreground/50 cursor-text hover:underline hover:decoration-dotted hover:underline-offset-4",
            )}
          >
            {name}
          </button>
        )}
        {/* 根目录文件的 rel 与 name 相同，重复显示没有信息量 */}
        {rel !== name ? (
          <span className="text-muted-foreground/70 min-w-0 flex-1 truncate font-mono text-xs">
            {rel}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {onReference && (
          <TooltipIconButton
            tooltip={t("library.common.reference")}
            side="bottom"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={t("library.common.reference")}
            disabled={load.status === "error"}
            onClick={() => void referenceWhole()}
          >
            <AtSignIcon className="size-4" />
          </TooltipIconButton>
        )}
        <TooltipIconButton
          tooltip={t("library.common.revealInSystem")}
          side="bottom"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("library.common.revealInSystem")}
          onClick={() => void reveal()}
        >
          <FileManagerIcon className="size-4.5" />
        </TooltipIconButton>
      </div>

      {load.status === "loading" ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin" />
          {t("common.action.loading")}
        </div>
      ) : load.status === "error" ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
          <AlertCircleIcon className="size-6" />
          {t("library.viewer.readFailed")}
        </div>
      ) : load.status === "too-large" ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
          <AlertCircleIcon className="size-6" />
          {t("library.viewer.tooLarge")}
          <Button variant="outline" size="sm" onClick={() => void reveal()}>
            <FileManagerIcon className="size-4.5" />
            {t("library.common.reveal")}
          </Button>
        </div>
      ) : load.status === "image" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={load.url}
            alt={name}
            draggable={false}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      ) : load.binary ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
          <AlertCircleIcon className="size-6" />
          {t("library.viewer.unsupported")}
          <Button variant="outline" size="sm" onClick={() => void reveal()}>
            <FileManagerIcon className="size-4.5" />
            {t("library.common.reveal")}
          </Button>
        </div>
      ) : kind === "native-note" ? (
        <NativeNoteBody
          key={`${rel}\u0000${kind}`}
          cwd={cwd}
          rel={rel}
          name={name}
          initial={load.text}
          truncated={load.truncated}
          onTitleRename={
            onRenamed
              ? (nextBase) => {
                  const ext = name.includes(".")
                    ? name.slice(name.lastIndexOf("."))
                    : "";
                  return renameTo(`${nextBase}${ext}`);
                }
              : undefined
          }
          registerFlush={registerFlush}
          registerPrepareRename={registerPrepareRename}
          metaEnabled={metaEnabled}
          reloadSignal={reloadSignal}
        />
      ) : (
        // reloadSignal 变化（watcher/手动刷新）不再重挂载文本体：外壳静默重读，
        // TextBody 在「未聚焦且不脏」时把新内容换进来——自动保存触发的 watcher
        // 事件不会打断输入/丢光标。换文件才靠 key 重挂载。
        <TextBody
          key={`${rel}\u0000${kind}`}
          cwd={cwd}
          rel={rel}
          name={name}
          kind={kind}
          initial={load.text}
          truncated={load.truncated}
          onReference={onReference}
          onTitleRename={
            onRenamed
              ? (nextBase) => {
                  const ext = name.includes(".")
                    ? name.slice(name.lastIndexOf("."))
                    : "";
                  return renameTo(`${nextBase}${ext}`);
                }
              : undefined
          }
          onConverted={
            onRenamed
              ? (newRel, newName) => onRenamed(newRel, newName)
              : undefined
          }
          registerFlush={registerFlush}
          metaEnabled={metaEnabled}
          reloadSignal={reloadSignal}
        />
      )}
    </div>
  );
};

/**
 * 笔记「被 N 个任务引用」：kb_read 每次成功读到资料库笔记都会在
 * knowledge_refs 落一行（按 session 去重）；这里只读展示，窗口聚焦/刷新时重拉。
 */
const NoteUsageBadge: FC<{
  cwd: string;
  rel: string;
  reloadSignal?: number;
  className?: string;
}> = ({ cwd, rel, reloadSignal, className }) => {
  const t = useT();
  const [count, setCount] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void knowledgeRefsStats({
        source: "library",
        scopeId: cwd,
        path: rel,
      })
        .then((stat) => {
          if (alive) setCount(stat.count);
        })
        .catch(() => {
          /* 统计不可用不打扰阅读 */
        });
      void knowledgeRefsForPath({
        source: "library",
        scopeId: cwd,
        path: rel,
        limit: 5,
      })
        .then((rows) => {
          if (!alive) return;
          // 已删除会话的标题为空：显示原始 sessionId 兜底
          setRecent(
            rows.map((row) => row.title || row.sessionId.slice(0, 8)),
          );
        })
        .catch(() => {
          /* 同上 */
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [cwd, rel, reloadSignal]);
  if (count <= 0) return null;
  const recentLabel =
    recent.length > 0
      ? t("library.viewer.usageRecent", {
          list: recent.join(t("library.viewer.listSeparator")),
        })
      : "";
  return (
    <span
      className={cn(
        "text-muted-foreground/70 shrink-0 text-[11px]",
        className,
      )}
      title={t("library.viewer.usageTitle", {
        count,
        recent: recentLabel,
      })}
    >
      {t("library.viewer.usageLabel", { count })}
    </span>
  );
};

/**
 * 原生笔记体（`.knote`）：解析 envelope → Plate Value 直接编辑 → 防抖写回
 * 整个 JSON。Markdown 只作为 envelope 里的兼容缓存，不参与正文往返。
 *
 * 数据安全：损坏/未知版本/截断的 JSON 只读展示并停止自动保存，绝不覆盖；
 * watcher 回读到的内容等于自己刚写的那份时不做 remount，避免丢光标。
 */
const NativeNoteBody: FC<{
  cwd: string;
  rel: string;
  name: string;
  initial: string;
  truncated: boolean;
  onTitleRename?: (nextBase: string) => Promise<boolean>;
  registerFlush?: (fn: (() => Promise<boolean>) | null) => void;
  registerPrepareRename?: (
    fn: ((nextBase: string) => Promise<boolean>) | null,
  ) => void;
  metaEnabled?: boolean;
  reloadSignal?: number;
}> = ({
  cwd,
  rel,
  name,
  initial,
  truncated,
  onTitleRename,
  registerFlush,
  registerPrepareRename,
  metaEnabled,
  reloadSignal,
}) => {
  const t = useT();
  const baseTitle = name.replace(/\.knote$/iu, "");
  const firstParseRef = useRef<ReturnType<typeof parseNativeNote> | null>(null);
  if (firstParseRef.current === null) {
    firstParseRef.current = parseNativeNote(initial);
  }
  const firstParse = firstParseRef.current;
  const initialNote = firstParse.ok && !truncated ? firstParse.note : null;

  const [note, setNote] = useState<NativeNoteFile | null>(initialNote);
  const noteRef = useRef<NativeNoteFile | null>(initialNote);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [externalError, setExternalError] = useState<string | null>(
    firstParse.ok ? null : firstParse.reason,
  );
  /** 外部重载时换 key，让编辑器用新的 blocks 重建；自己的保存回读不换 */
  const [epoch, setEpoch] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastInitialRef = useRef(initial);
  const lastWrittenRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);

  const blocked = !note || truncated || externalError !== null;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const flush = useCallback(async (): Promise<boolean> => {
    const current = noteRef.current;
    if (!current || blockedRef.current) return false;
    if (!dirtyRef.current) return true;
    const json = serializeNativeNote(current);
    setStatus("saving");
    const err = await fsWriteFile(cwd, rel, json);
    if (err) {
      setStatus("idle");
      toast.error(fsErrorText(err));
      return false;
    }
    lastWrittenRef.current = json;
    // 写盘期间又改了：保持 dirty，下一轮防抖再写一次
    const latest = noteRef.current;
    if (latest && serializeNativeNote(latest) === json) {
      dirtyRef.current = false;
      setDirty(false);
    }
    setStatus("saved");
    return true;
  }, [cwd, rel]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushRef.current();
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const applyPatch = useCallback(
    (
      patch: Partial<
        Pick<
          NativeNoteFile,
          "title" | "icon" | "cover" | "tags" | "blocks" | "markdown"
        >
      >,
      options?: { save?: boolean },
    ): NativeNoteFile | null => {
      const current = noteRef.current;
      if (!current || blockedRef.current) return null;
      const next = withNativeNotePatch(current, patch);
      noteRef.current = next;
      setNote(next);
      dirtyRef.current = true;
      setDirty(true);
      if (options?.save !== false) scheduleSave();
      return next;
    },
    [scheduleSave],
  );

  // 文件名是标题的事实源：外部改名/迁移遗留的 envelope.title 在打开时校正。
  // 这是元数据修复，不碰 blocks；失败也不阻塞编辑。
  useEffect(() => {
    const current = noteRef.current;
    if (!current || blockedRef.current) return;
    if (current.title === baseTitle) return;
    applyPatch({ title: baseTitle });
  }, [applyPatch, baseTitle]);

  // 「引用到对话」前先落盘（顶部按钮统一调用），行号/内容对应磁盘
  useEffect(() => {
    registerFlush?.(flush);
    return () => registerFlush?.(null);
  }, [flush, registerFlush]);

  useEffect(() => {
    const prepare = async (nextBase: string): Promise<boolean> => {
      if (!noteRef.current || blockedRef.current) return false;
      applyPatch({ title: nextBase }, { save: false });
      return flushRef.current();
    };
    registerPrepareRename?.(prepare);
    return () => registerPrepareRename?.(null);
  }, [applyPatch, registerPrepareRename]);

  // 卸载前把未落盘内容写完（切文件/切区）
  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      void flushRef.current();
    },
    [],
  );

  // Cmd/Ctrl+S 立即保存（与 Markdown/文本体一致）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        void flushRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // 外部重载（watcher / 手动刷新）：未聚焦且不脏才换；自己刚写的内容直接忽略
  useEffect(() => {
    if (initial === lastInitialRef.current) return;
    lastInitialRef.current = initial;
    if (initial === lastWrittenRef.current) return;
    const parsed = parseNativeNote(initial);
    if (!parsed.ok) {
      // 外部文件已损坏/版本过新：即使本地有草稿也停止保存，绝不覆盖原文件
      setExternalError(parsed.reason);
      return;
    }
    if (dirtyRef.current) return;
    if (bodyRef.current?.contains(document.activeElement)) return;
    const next = { ...parsed.note, title: baseTitle };
    noteRef.current = next;
    setNote(next);
    setExternalError(null);
    setEpoch((value) => value + 1);
    setDirty(false);
    dirtyRef.current = false;
    setStatus("idle");
  }, [baseTitle, initial]);

  // 标题以文件名为准（Finder/顶栏改名也能对上），元数据同步供 @ 搜索
  useEffect(() => {
    if (!metaEnabled || !firstParse.ok || truncated) return;
    void syncNoteTitle(cwd, rel, baseTitle);
  }, [baseTitle, cwd, firstParse.ok, metaEnabled, rel, truncated]);

  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const handleTitleRename = async (nextBase: string): Promise<boolean> => {
    if (!onTitleRename || !noteRef.current || blockedRef.current) return false;
    applyPatch({ title: nextBase }, { save: false });
    const ok = await flushRef.current();
    if (!ok) return false;
    return onTitleRename(nextBase);
  };

  /** 导出 Markdown 兼容副本：写进库内隐藏的 .kova/exports，不覆盖任何笔记 */
  const exportMarkdown = async () => {
    const current = noteRef.current;
    if (!current) return;
    const base = nativeNoteBaseName(baseTitle);
    const relPath = `.kova/exports/${base}.md`;
    const meta = [
      "---",
      `title: ${JSON.stringify(current.title)}`,
      ...(current.tags.length > 0
        ? [`tags: ${JSON.stringify(current.tags)}`]
        : []),
      "---",
      "",
    ].join("\n");
    const frontmatter = current.frontmatter?.trimEnd() || meta;
    const content = `${frontmatter}\n\n${current.markdown}`;
    const err = await fsWriteFile(cwd, relPath, content);
    if (err) {
      toast.error(fsErrorText(err));
      return;
    }
    toast.success(
      t("library.editor.exportedMarkdown", { path: relPath }),
    );
  };

  return (
    <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col">
      <div className="border-border/40 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <span
          className={cn(
            "text-muted-foreground min-w-0 truncate text-xs",
            metaEnabled ? "shrink" : "flex-1",
          )}
        >
          {truncated && t("library.viewer.truncatedNotice")}
          {status === "saving"
            ? t("library.viewer.saving")
            : dirty
              ? t("library.viewer.unsaved")
              : !truncated && note && !externalError
                ? t("library.viewer.saved")
                : ""}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 shrink-0 gap-1 px-1.5 text-xs"
          disabled={blocked}
          onClick={() => void exportMarkdown()}
        >
          <FileDownIcon className="size-3.5" />
          {t("library.editor.exportMarkdown")}
        </Button>
        {metaEnabled && (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <NoteUsageBadge cwd={cwd} rel={rel} reloadSignal={reloadSignal} />
            <NoteTagsEditor
              cwd={cwd}
              rel={rel}
              className="min-w-0 justify-end"
              onChange={(tags) => applyPatch({ tags })}
            />
          </div>
        )}
      </div>

      {externalError ? (
        <div className="border-border/40 text-muted-foreground flex shrink-0 items-start gap-1.5 border-b px-3 py-1.5 text-xs">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{t("library.viewer.nativeReadFailed")}</span>
        </div>
      ) : null}

      {/* 原生笔记滚动容器：编辑器本身不滚，正文超屏靠这里滚
          （Markdown 分支同样是外层 overflow-y-auto + 内层 sticky 工具栏） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {note ? (
          <NativeNoteEditor
            key={`${note.id}:${epoch}`}
            blocks={note.blocks}
            editable={!truncated && !externalError}
            cwd={cwd}
            rel={rel}
            title={baseTitle}
            onRename={onTitleRename ? handleTitleRename : undefined}
            icon={note.icon}
            onIconChange={
              !truncated && !externalError
                ? (nextIcon) => applyPatch({ icon: nextIcon ?? undefined })
                : undefined
            }
            cover={note.cover}
            onCoverChange={
              !truncated && !externalError
                ? (nextCover) =>
                    applyPatch({ cover: nextCover ?? undefined })
                : undefined
            }
            imagePickEnabled={Boolean(metaEnabled)}
            onChange={(blocks, markdown) =>
              applyPatch({ blocks, markdown })
            }
          />
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
            <AlertCircleIcon className="size-6" />
            {t("library.viewer.nativeReadFailed")}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * 文本体：预览 / 编辑双态 + 防抖自动保存。
 * 组件随文件重挂载，草稿/基线/模式都只属于当前文件；卸载（切文件/切区）时
 * flush 未落盘的草稿——flushRef 存最新闭包，cleanup 里调用的不是旧快照。
 */
const TextBody: FC<{
  cwd: string;
  rel: string;
  name: string;
  kind: BodyKind;
  initial: string;
  truncated: boolean;
  onReference?: (range?: { startLine: number; endLine: number }) => void;
  onTitleRename?: (nextBase: string) => Promise<boolean>;
  onConverted?: (newRel: string, newName: string) => void;
  registerFlush?: (fn: (() => Promise<boolean>) | null) => void;
  metaEnabled?: boolean;
  reloadSignal?: number;
}> = ({
  cwd,
  rel,
  name,
  kind,
  initial,
  truncated,
  onReference,
  onTitleRename,
  onConverted,
  registerFlush,
  metaEnabled,
  reloadSignal,
}) => {
  const t = useT();
  /** HTML/SVG 仍可切换「预览 / 编辑」；Markdown 已是所见即所得，不再给模式开关 */
  const hasPreview = kind === "html" || kind === "svg";
  /** 富文本兼容性：不通过时自动落源码态，绝不静默改写笔记 */
  const richCheck = useMemo(
    () =>
      kind === "markdown"
        ? checkRichMarkdown(initial, { truncated })
        : null,
    [initial, kind, truncated],
  );
  const canRich = richCheck?.ok ?? false;
  const richFallbackReason: RichFallbackReason | null =
    richCheck && !richCheck.ok ? (richCheck.reason ?? null) : null;
  const [mode, setMode] = useState<TextMode>(() => {
    if (kind === "markdown") {
      // 笔记默认就是富文本编辑；只有语法不兼容时自动用源码打开
      return checkRichMarkdown(initial, { truncated }).ok ? "edit" : "source";
    }
    return hasPreview ? "preview" : "edit";
  });
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [converting, setConverting] = useState(false);
  /** iframe 预览的重载版本（切到预览且草稿已落盘后 +1） */
  const [previewRev, setPreviewRev] = useState(0);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastInitialRef = useRef(initial);
  /** Markdown 预览的标题目录（锚点定位 + 滚动高亮） */
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [activeTocId, setActiveTocId] = useState("");
  /** 富文本编辑态的目录（由编辑器文档实时上报） */
  const [richToc, setRichToc] = useState<TocEntry[]>([]);
  const [richActiveTocId, setRichActiveTocId] = useState("");
  const [tocOpen, setTocOpen] = useState(true);
  const reduceMotion = useReducedMotion();
  const markdownScrollRef = useRef<HTMLDivElement>(null);
  const headingElsRef = useRef(new Map<string, HTMLElement>());
  const richEditorRef = useRef<PlateMarkdownEditorHandle | null>(null);

  // 外部重载后兼容性变化：编辑态立刻退回源码，避免把不支持的文档交给富文本；
  // 反过来兼容性恢复时（例如外部编辑器修好了 HTML）也自动回到所见即所得。
  useEffect(() => {
    if (kind !== "markdown") return;
    if (!canRich && mode === "edit") setMode("source");
    if (canRich && mode === "source") setMode("edit");
  }, [canRich, kind, mode]);

  /* ------------------------------ Ctrl+F 查找 ------------------------------ */

  /** 查找目标：md 预览走 DOM 扫描；md 富文本编辑走 ProseMirror；
   *  html 预览走 iframe 引擎（仅桌面）；源码/代码/纯文本走 CodeMirror。 */
  const findTarget: "dom" | "iframe" | "cm" | "rich" | null = useMemo(() => {
    if (kind === "markdown") {
      if (mode === "source") return "cm";
      if (mode === "edit") return "rich";
      return "dom";
    }
    if (mode === "preview") {
      if (kind === "html") return canUseLocalFileUrl() ? "iframe" : null;
      return null;
    }
    return "cm";
  }, [mode, kind]);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  /** 当前命中（0-based，-1 = 无）；命中数由各后端上报 */
  const [findIndex, setFindIndex] = useState(-1);
  const [findCount, setFindCount] = useState(0);
  /** CodeMirror 查找的跳转信号（同方向重复点击也要生效） */
  const [cmFindNav, setCmFindNav] = useState<{ dir: 1 | -1; nonce: number }>({ dir: 1, nonce: 0 });
  const cmNavNonceRef = useRef(0);
  /** 替换值与替换信号（nonce 变化执行一次；cm 端执行后经 onHits 回报新命中） */
  const [replaceValue, setReplaceValue] = useState("");
  const [replaceOp, setReplaceOp] = useState<CodeMirrorReplace | null>(null);
  const replaceNonceRef = useRef(0);
  /** 替换仅在可编辑态开放：md 预览 / html iframe 是只读渲染，截断只读 */
  const canReplace =
    !truncated &&
    (findTarget === "cm" || (findTarget === "rich" && mode === "edit"));
  /** iframe 查找引擎的请求序号：回包对不上序号的丢弃 */
  const iframeFindSeqRef = useRef(0);
  /** iframe 引擎就绪前攒下的查询：ready 回包后重发 */
  const iframeReadyRef = useRef(false);
  /** html 预览的 iframe（查找消息桥的目标 window 校验用） */
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** FindBar 聚焦信号：再按 Ctrl+F 时重聚焦并全选 */
  const [findFocusSignal, setFindFocusSignal] = useState(0);
  /** findIndex 的镜像（MutationObserver / iframe 回包里读最新值用） */
  const findIndexRef = useRef(-1);
  findIndexRef.current = findIndex;
  /** 查询防抖（iframe 与 dom 共用；输入停顿再扫，长文不逐键全量扫） */
  const [deferredFindQuery, setDeferredFindQuery] = useState("");
  /** 右键菜单（落点 + 选区）：md/编辑器读宿主选区，html 预览由 iframe 上报 */
  const [viewerMenu, setViewerMenu] = useState<ViewerMenuState | null>(null);


  // 外壳静默重读（watcher/手动刷新）后的新内容：只有「未聚焦且没有未保存
  // 草稿」才替换。这样自动保存触发的 watcher 事件不会打断输入、也不会用
  // 盘上内容覆盖正在写的草稿。
  useEffect(() => {
    if (initial === lastInitialRef.current) return;
    lastInitialRef.current = initial;
    const focused =
      bodyRef.current?.contains(document.activeElement) ?? false;
    if (focused || draftRef.current !== baselineRef.current) return;
    setDraft(initial);
    setBaseline(initial);
    setPreviewRev((r) => r + 1);
  }, [initial]);

  /** 从渲染后的 DOM 收集标题：给每个标题补稳定 id，并同步目录 */
  const collectHeadings = useCallback(() => {
    const root = markdownScrollRef.current;
    if (!root) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"),
    ).flatMap((el) => {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      return text ? [{ el, text }] : [];
    });
    const next = buildTocEntries(
      nodes.map(({ el, text }) => ({
        text,
        level: Number(el.tagName.slice(1)) || 1,
      })),
    );
    const els = new Map<string, HTMLElement>();
    nodes.forEach(({ el }, index) => {
      const id = next[index]?.id;
      if (!id) return;
      if (el.id !== id) el.id = id;
      els.set(id, el);
    });
    headingElsRef.current = els;
    setToc((prev) => (tocEqual(prev, next) ? prev : next));
    setActiveTocId((prev) =>
      next.some((entry) => entry.id === prev) ? prev : (next[0]?.id ?? ""),
    );
  }, []);

  // 目录收集：Streamdown 首帧/懒加载 chunk 到达都会改 DOM，用 MutationObserver
  // 重扫；id 是属性写入，不触发 childList，不会自激循环。
  useEffect(() => {
    if (mode !== "preview" || kind !== "markdown") {
      headingElsRef.current.clear();
      setToc((prev) => (prev.length === 0 ? prev : []));
      setActiveTocId("");
      return;
    }
    const root = markdownScrollRef.current;
    if (!root) return;
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        collectHeadings();
      });
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [collectHeadings, draft, kind, mode, previewRev]);

  // 滚动高亮：取最后一个已经越过视口顶部（留 32px 余量）的标题
  useEffect(() => {
    if (mode !== "preview" || kind !== "markdown" || toc.length === 0) return;
    const root = markdownScrollRef.current;
    if (!root) return;
    let raf = 0;
    const update = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rootTop = root.getBoundingClientRect().top;
        let current = toc[0]?.id ?? "";
        for (const entry of toc) {
          const el = headingElsRef.current.get(entry.id);
          if (!el) continue;
          if (el.getBoundingClientRect().top - rootTop <= 32) current = entry.id;
          else break;
        }
        setActiveTocId((prev) => (prev === current ? prev : current));
      });
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => {
      root.removeEventListener("scroll", update);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [kind, mode, toc]);

  const handleTocSelect = useCallback(
    (id: string) => {
      if (kind === "markdown" && mode === "edit") {
        richEditorRef.current?.scrollToHeading(id);
        setRichActiveTocId(id);
        return;
      }
      const root = markdownScrollRef.current;
      const el = headingElsRef.current.get(id);
      if (!root || !el) return;
      const top =
        root.scrollTop +
        el.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        16;
      const reduce =
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ??
        false;
      root.scrollTo({
        top: Math.max(0, top),
        behavior: reduce ? "auto" : "smooth",
      });
      setActiveTocId(id);
    },
    [kind, mode],
  );

  const richEditing = kind === "markdown" && mode === "edit";
  const tocSource = richEditing ? richToc : toc;
  const activeTocForRender = richEditing ? richActiveTocId : activeTocId;

  const tocItems = useMemo(
    () =>
      tocSource.map((entry) => ({
        id: entry.id,
        title: entry.label,
        label: (
          <span
            className="line-clamp-2 min-w-0 w-full leading-snug break-words"
            style={{ paddingLeft: (entry.level - 1) * 6 }}
          >
            {entry.label}
          </span>
        ),
      })),
    [tocSource],
  );
  const tocFadeIn = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, delay: 0.04 };
  const tocFadeOut = reduceMotion ? { duration: 0 } : { duration: 0.08 };

  /* ------------------------------ Ctrl+F 查找实现 ------------------------------ */

  // 查询防抖：输入停顿 150ms 再扫（长文/流式渲染不逐键全量扫）
  useEffect(() => {
    const t = setTimeout(() => setDeferredFindQuery(findQuery), 150);
    return () => clearTimeout(t);
  }, [findQuery]);

  /** 查找关闭/查询清空：三端统一收尾（iframe 的清理随下一次 search 消息走）。
   *  注意不动 cmFindNav 的 nonce：两侧 nonce 只增不减，回拨会让下一轮查询
   *  首帧被误判成"待执行导航"而空转（见 cm-code.tsx 的 lastNavNonceRef） */
  const resetFind = useCallback(() => {
    setFindIndex(-1);
    setFindCount(0);
    clearDomFindHighlight(FIND_HIGHLIGHT_NAME);
    clearDomFindHighlight(FIND_CURRENT_NAME);
    richEditorRef.current?.clearSearch();
  }, []);

  /** 打开查找：保留上次的查询（浏览器行为——重开还是原词，直接 Enter 续翻） */
  const openFind = useCallback(() => {
    setFindOpen(true);
    resetFind();
  }, [resetFind]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    resetFind();
    // iframe 引擎明确清高亮（仅桌面有该后端）
    iframeRef.current?.contentWindow?.postMessage(
      { __kovaFind: true, type: "clear" },
      "*",
    );
  }, [resetFind]);

  // Ctrl/Cmd+F 打开；已开时再按只聚焦并全选（与浏览器行为一致）。
  // 守卫对齐 thread-find：modal 开着不抢、别人 preventDefault 过不抢
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "f") return;
      if (event.defaultPrevented) return;
      if (!findTarget) return;
      // 对话框/浮层开着时不抢：查找条压在其他浮层下面没有意义
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (findOpen) {
        // 已开：重聚焦（FindBar 的 focusSignal 变化触发全选）
        setFindFocusSignal((s) => s + 1);
      } else {
        openFind();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [findTarget, findOpen, openFind]);

  // Esc 关闭（焦点在输入框外时也要能关）。不捕获、不 stopPropagation：
  // 模态对话框/全局搜索覆盖层的 Esc 先跑（它们 preventDefault 后我们才退），
  // 与 thread-find 的关闭链路同一口径，避免把下层页面的 Esc 链抢断
  useEffect(() => {
    if (!findOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeFind();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [findOpen, closeFind]);

  // 切模式/切文件/卸载：查找随内容体退场
  useEffect(() => {
    if (!findOpen) return;
    return () => {
      clearDomFindHighlight(FIND_HIGHLIGHT_NAME);
      clearDomFindHighlight(FIND_CURRENT_NAME);
    };
  }, [findOpen, mode, kind]);

  // 切模式（预览↔编辑）：右键菜单的落点/选区属于旧形态，直接收起
  useEffect(() => {
    setViewerMenu(null);
  }, [mode]);

  /* --- md 预览（DOM 后端） --- */

  /** scroll=false 供 MutationObserver 重扫：只更新计数/高亮，不拽动阅读位置 */
  const domFindRun = useCallback(
    (query: string, jumpIndex: number | null, scroll = true) => {
      const root = markdownScrollRef.current;
      if (!root || !query) {
        resetFind();
        return;
      }
      const { count, ranges } = findInDom(root, FIND_HIGHLIGHT_NAME, query);
      setFindCount(count);
      if (count === 0) {
        clearDomFindHighlight(FIND_CURRENT_NAME);
        setFindIndex(-1);
        return;
      }
      // jumpIndex null = 查询变化落第一条；数字 = 上一个/下一个（已由调用方取模）。
      // 高亮 Range 有上限（DOM_FIND_MAX_RANGES），超出部分只计数不染色——
      // 定位夹到 Range 范围内，保证"当前命中"始终有可见高亮
      const idx = Math.min(Math.max(jumpIndex ?? 0, 0), count - 1);
      setFindIndex(idx);
      const current = ranges[Math.min(idx, ranges.length - 1)];
      if (current) {
        // 当前命中单独高亮：挂第二个注册名（::highlight 叠加，当前项更醒目）
        setDomFindHighlight(FIND_CURRENT_NAME, [current]);
        if (scroll && root.contains(current.startContainer)) {
          scrollRangeIntoView(root, current);
        }
      }
    },
    [resetFind],
  );

    // 查询变化（md 预览）：扫全文并落第一条
  useEffect(() => {
    if (!findOpen || findTarget !== "dom") return;
    if (!deferredFindQuery) {
      resetFind();
      return;
    }
    // 首帧 DOM 可能还没渲染完（Streamdown 异步）：rAF 后扫，扫不到交给
    // MutationObserver 补扫
    const frame = requestAnimationFrame(() => domFindRun(deferredFindQuery, null));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredFindQuery, findOpen, findTarget]);

  // md 预览渲染是异步的（Streamdown chunk/Mermaid 等）：查找开着时挂
  // MutationObserver 重扫当前查询，保证新渲染出的段落也能命中
  useEffect(() => {
    if (!findOpen || findTarget !== "dom" || !deferredFindQuery) return;
    const root = markdownScrollRef.current;
    if (!root) return;
    let raf = 0;
    const observer = new MutationObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        // 重扫但不跳不滚：保持当前 index（越界时夹取），别把正在阅读的人拽回去
        domFindRun(deferredFindQuery, findIndexRef.current, false);
      });
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [findOpen, findTarget, deferredFindQuery, domFindRun]);

  /* --- html 预览（iframe 引擎后端，仅桌面） --- */

  // 回包处理读的宿主状态走镜像 ref：监听只装一次，不因 query/开关变化重装
  const findOpenRef = useRef(false);
  findOpenRef.current = findOpen;
  const deferredFindQueryRef = useRef("");
  deferredFindQueryRef.current = deferredFindQuery;

  // iframe 回包：查找计数（__kovaFindResult）与右键菜单上报（__kovaContext）
  useEffect(() => {
    if (findTarget !== "iframe") return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | {
            __kovaFindResult?: boolean;
            __kovaContext?: boolean;
            seq?: number;
            count?: number;
            ready?: boolean;
            x?: number;
            y?: number;
            selection?: string;
          }
        | undefined;
      if (!data) return;
      // 只信当前 iframe 的回包（多 iframe 页面下 source 校验）
      if (event.source !== iframeRef.current?.contentWindow) return;
      // 右键菜单上报：iframe 内选区宿主读不到，由子文档带上来。
      // 落点换算到宿主视口（iframe 视口坐标 + iframe 自身矩形偏移）
      if (data.__kovaContext === true) {
        const rect = iframeRef.current?.getBoundingClientRect();
        if (!rect) return;
        setViewerMenu({
          x: rect.left + (typeof data.x === "number" ? data.x : 0),
          y: rect.top + (typeof data.y === "number" ? data.y : 0),
          selection: typeof data.selection === "string" ? data.selection : "",
        });
        return;
      }
      if (data.__kovaFindResult !== true) return;
      if (data.ready) {
        // 引擎就绪：重发当前查询（打开查找时 iframe 可能还没加载完）
        iframeReadyRef.current = true;
        if (findOpenRef.current && deferredFindQueryRef.current) {
          sendIframeFind(
            deferredFindQueryRef.current,
            Math.max(findIndexRef.current, 0),
          );
        }
        return;
      }
      // 查找已关闭：旧请求的计数迟到也不上屏（重开时会重新扫）
      if (!findOpenRef.current) return;
      if (typeof data.seq !== "number" || data.seq !== iframeFindSeqRef.current) {
        return; // 旧请求的迟到回包：丢弃
      }
      setFindCount(data.count ?? 0);
      // 回包后同步当前下标：首次命中落 0；命中数缩水时夹回范围内
      setFindIndex((prev) => {
        if (!data.count) return -1;
        if (prev < 0) return 0;
        return Math.min(prev, data.count - 1);
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findTarget]);

  /** 向 iframe 发查找请求（带递增 seq；count 回包异步到） */
  const sendIframeFind = useCallback((query: string, index: number) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    iframeFindSeqRef.current += 1;
    win.postMessage(
      { __kovaFind: true, type: "search", query, index, seq: iframeFindSeqRef.current },
      "*",
    );
  }, []);

  // 查询变化/导航（html 预览）：防抖后的 query 与当前 index 发给引擎
  useEffect(() => {
    if (!findOpen || findTarget !== "iframe") return;
    if (!deferredFindQuery) {
      resetFind();
      iframeRef.current?.contentWindow?.postMessage(
        { __kovaFind: true, type: "clear" },
        "*",
      );
      return;
    }
    // 引擎没就绪先不发（ready 回包会补发）；ready 状态在 ref 里
    if (!iframeReadyRef.current) return;
    sendIframeFind(deferredFindQuery, Math.max(findIndex, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredFindQuery, findIndex, findOpen, findTarget, sendIframeFind]);

  // iframe 重载（previewRev 变化）：引擎随新文档重装，就绪状态清零
  useEffect(() => {
    iframeReadyRef.current = false;
  }, [previewRev]);

  const flush = useCallback(async (): Promise<boolean> => {
    const text = draftRef.current;
    if (text === baselineRef.current) return true;
    setStatus("saving");
    const err = await fsWriteFile(cwd, rel, text);
    if (err) {
      setStatus("idle");
      toast.error(fsErrorText(err));
      return false;
    }
    setBaseline(text);
    setStatus("saved");
    return true;
  }, [cwd, rel]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  // 「引用到对话」前先 flush（顶部按钮 / 选区浮层都要）：行号与内容必须对应
  // 磁盘上的文件，半路草稿会让引用错位。把 flush 交给查看器外壳统一调用。
  useEffect(() => {
    registerFlush?.(flush);
    return () => registerFlush?.(null);
  }, [flush, registerFlush]);

  // 防抖自动保存：草稿离开基线即排队，继续输入则重排
  useEffect(() => {
    if (draft === baseline) return;
    const t = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [draft, baseline, flush]);

  // 「已保存」提示两秒后淡回常态；未落盘时以草稿为准
  useEffect(() => {
    if (status !== "saved") return;
    const t = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(t);
  }, [status]);

  // 切文件/切区（组件卸载）前把未落盘草稿落下
  useEffect(() => () => void flushRef.current(), []);

  // Cmd/Ctrl+S 立即保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void flush();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flush]);

  const dirty = draft !== baseline;

  /** Markdown 兼容文件 → 原生笔记；成功后在页面层切换选中到新文件 */
  const convertToNative = async () => {
    if (converting || !metaEnabled) return;
    const flushed = await flush();
    if (!flushed) return;
    setConverting(true);
    try {
      const result = await convertMarkdownFileToNative(cwd, rel);
      if (!result.ok) {
        toast.error(
          t("library.editor.convertFailed", { error: result.error }),
        );
        return;
      }
      toast.success(t("library.editor.convertDone"));
      const newName = result.newRel.split("/").pop() ?? result.newRel;
      onConverted?.(result.newRel, newName);
    } finally {
      setConverting(false);
    }
  };

  /**
   * 切模式：html 预览读盘上文件，先 flush 再 bump iframe 版本；md 预览/源码
   * 都用内存草稿，不需要为切换写盘。不兼容富文本的笔记禁止进编辑态。
   */
  const switchMode = (next: TextMode) => {
    if (next === "edit" && kind === "markdown" && !canRich) {
      toast.info(t("library.editor.fallback.blocked"));
      return;
    }
    setMode(next);
    if (next === "preview" && kind === "html") {
      void flush().then((ok) => {
        if (ok) setPreviewRev((r) => r + 1);
      });
    }
  };

  const modeOptions = useMemo(() => {
    // Markdown 所见即所得：不再提供「预览 / 源码」，避免三套渲染分叉
    if (kind === "markdown") return [];
    const options: {
      value: TextMode;
      label: string;
      icon: ReactNode;
    }[] = [
      {
        value: "preview",
        label: t("library.viewer.preview"),
        icon: <EyeIcon className="size-3.5" />,
      },
      {
        value: "edit",
        label: t("common.action.edit"),
        icon: <PencilIcon className="size-3.5" />,
      },
    ];
    return options;
  }, [kind, t]);

  /* --- 查找导航：按后端分派 --- */

  // 查询变化：下标归零再由各后端落位（否则 cm 的"落第一条"会带上旧查询
  // 的 active，落在错误的命中上）
  useEffect(() => {
    setFindIndex(-1);
  }, [deferredFindQuery]);

  /** 上一个/下一个：md 预览直接重扫+跳；cm 走 nav nonce（下标由 cm 回报）；
   *  iframe 走 index */
  const stepFind = useCallback(
    (dir: 1 | -1) => {
      if (findCount === 0) return;
      if (findTarget === "rich") {
        if (dir === 1) richEditorRef.current?.searchNext();
        else richEditorRef.current?.searchPrev();
        return;
      }
      if (findTarget === "cm") {
        cmNavNonceRef.current += 1;
        setCmFindNav({ dir, nonce: cmNavNonceRef.current });
        return;
      }
      const next = ((findIndex < 0 ? (dir === 1 ? -1 : 0) : findIndex) + dir + findCount) % findCount;
      setFindIndex(next);
      if (findTarget === "dom") {
        domFindRun(deferredFindQuery, next);
      } else if (findTarget === "iframe") {
        sendIframeFind(deferredFindQuery, next);
      }
    },
    [findCount, findTarget, findIndex, deferredFindQuery, domFindRun, sendIframeFind],
  );

  /** 替换入口（FindBar）：命中就绪才发信号；替换经 CodeMirror onChange 进草稿，
   *  走既有防抖自动保存/Cmd+S 链路，不走直接落盘 */
  const doReplace = useCallback(
    (replaceMode: "one" | "all") => {
      if (!canReplace || findCount === 0) return;
      if (findTarget === "rich") {
        if (replaceMode === "one") {
          richEditorRef.current?.replace(replaceValue);
        } else {
          richEditorRef.current?.replaceAll(replaceValue);
        }
        return;
      }
      replaceNonceRef.current += 1;
      setReplaceOp({
        mode: replaceMode,
        value: replaceValue,
        nonce: replaceNonceRef.current,
      });
    },
    [canReplace, findCount, findTarget, replaceValue],
  );

  // 离开源码态即清掉已消费的替换信号：CodeMirrorCode 随分支卸载，重挂后
  // cm 端的 nonce 基线归零，旧信号不清会被当成新信号再执行一次（重复替换）
  useEffect(() => {
    if (findTarget !== "cm") setReplaceOp(null);
  }, [findTarget]);

  /** Markdown 预览/富文本编辑共用的右侧目录（有 2 个以上标题才出现） */
  const tocAside =
    tocSource.length > 1 ? (
      <motion.aside
        aria-label={
          tocOpen
            ? t("library.viewer.tocAria")
            : t("library.viewer.tocAriaCollapsed")
        }
        initial={false}
        animate={{ width: tocOpen ? 224 : 36 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }
        }
        className="border-border/60 hidden shrink-0 overflow-y-auto overflow-x-hidden border-l py-4 xl:flex xl:flex-col"
      >
        <AnimatePresence initial={false} mode="wait">
          {tocOpen ? (
            <motion.div
              key="open"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: tocFadeIn }}
              exit={{ opacity: 0, transition: tocFadeOut }}
              className="flex min-h-0 w-56 shrink-0 flex-col px-2"
            >
              <div className="mb-1 flex items-center justify-between px-2">
                <span className="text-muted-foreground text-2xs font-medium tracking-wide">
                  {t("library.viewer.toc")}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground size-6"
                  title={t("library.viewer.collapseToc")}
                  aria-label={t("library.viewer.collapseToc")}
                  onClick={() => setTocOpen(false)}
                >
                  <ChevronRightIcon className="size-3.5" />
                </Button>
              </div>
              <BounceSidebar
                items={tocItems}
                value={activeTocForRender}
                onValueChange={handleTocSelect}
                ariaLabel={t("library.viewer.tocAria")}
                listClassName="gap-0.5 pl-5"
                itemClassName="min-h-7 py-1 pr-1 text-xs whitespace-normal"
              />
            </motion.div>
          ) : (
            <motion.div
              key="closed"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: tocFadeIn }}
              exit={{ opacity: 0, transition: tocFadeOut }}
              className="flex w-full justify-center"
            >
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-6"
                title={t("library.viewer.expandToc")}
                aria-label={t("library.viewer.expandToc")}
                onClick={() => setTocOpen(true)}
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.aside>
    ) : null;

  return (
    <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-col">
      {/* 状态行：模式切换（可预览的文件）+ 保存状态 + 右侧标签编辑。
          三个控件统一 28px 高（h-7），标签靠右对齐——之前标签贴着模式切换、
          且比它高一点，看起来像两套尺寸。 */}
      <div className="border-border/40 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        {hasPreview && (
          <Segmented
            value={mode}
            onChange={(next) => switchMode(next)}
            options={modeOptions}
          />
        )}
        <span
          className={cn(
            "text-muted-foreground min-w-0 truncate text-xs",
            metaEnabled ? "shrink" : "flex-1",
          )}
        >
          {truncated && t("library.viewer.truncatedNotice")}
          {status === "saving"
            ? t("library.viewer.saving")
            : dirty
              ? t("library.viewer.unsaved")
              : !truncated
                ? t("library.viewer.saved")
                : ""}
        </span>
        {kind === "markdown" && metaEnabled && !truncated ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground h-6 shrink-0 gap-1 px-1.5 text-xs"
            disabled={converting}
            onClick={() => void convertToNative()}
          >
            {converting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <NotebookPenIcon className="size-3.5" />
            )}
            {t("library.editor.convertToNative")}
          </Button>
        ) : null}
        {metaEnabled && (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <NoteUsageBadge
              cwd={cwd}
              rel={rel}
              reloadSignal={reloadSignal}
            />
            <NoteTagsEditor
              cwd={cwd}
              rel={rel}
              className="min-w-0 justify-end"
            />
          </div>
        )}
      </div>

      {/* 富文本兼容性提示：不静默改写，明确告诉用户为什么落在源码态 */}
      {kind === "markdown" &&
      richFallbackReason &&
      richFallbackReason !== "truncated" ? (
        <div className="border-border/40 text-muted-foreground flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs">
          <InfoIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {t(
              richFallbackReason === "size"
                ? "library.editor.fallback.size"
                : "library.editor.fallback.unsupported",
            )}
          </span>
        </div>
      ) : null}

      {/* 内容区右键：Electron 没有系统默认右键菜单，选中文字后补「复制」。
          iframe 内的右键由注入脚本上报（跨源拿不到内部选区），这里只管
          宿主 DOM（md 预览 / CodeMirror 编辑器）。内层组件已 preventDefault
          的不抢（尊重页面自身交互）。 */}
      <div
        className="min-h-0 flex-1"
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          setViewerMenu({
            x: event.clientX,
            y: event.clientY,
            selection: window.getSelection?.()?.toString() ?? "",
          });
        }}
      >
        {kind === "markdown" && mode !== "source" ? (
          /* Markdown 所见即所得：直接挂 Plate 编辑器；只有语法不兼容时才
             自动落源码态。不再有「预览 / 编辑 / 源码」三态切换。 */
          <div className="flex h-full min-h-0">
            <div
              ref={markdownScrollRef}
              className="min-w-0 flex-1 overflow-y-auto pr-6 pl-12"
            >
              <PlateMarkdownEditor
                ref={richEditorRef}
                value={draft}
                editable={!truncated}
                cwd={cwd}
                rel={rel}
                title={name.replace(/\.(md|markdown)$/i, "")}
                onRename={onTitleRename}
                icon={readNoteIcon(draft)}
                onIconChange={(nextIcon) =>
                  setDraft((prev) => setNoteIcon(prev, nextIcon))
                }
                searching={findOpen}
                imagePickEnabled={Boolean(metaEnabled)}
                findQuery={
                  findOpen && findTarget === "rich" ? deferredFindQuery : ""
                }
                scrollContainerRef={markdownScrollRef}
                onChange={setDraft}
                onFindResult={(count, index) => {
                  setFindCount(count);
                  setFindIndex(index);
                }}
                onTocChange={(entries) =>
                  setRichToc((prev) =>
                    tocEqual(prev, entries) ? prev : entries,
                  )
                }
                onActiveHeadingChange={setRichActiveTocId}
              />
            </div>
            {tocAside}
          </div>
        ) : mode === "preview" && kind === "svg" ? (
          /* SVG：<img> 渲染 data URL（脚本/外部资源不执行，比 iframe 安全）；
           * 棋盘底便于看清透明区域 */
          <div
            className="flex h-full items-center justify-center overflow-auto p-4"
            style={{
              backgroundImage:
                "repeating-conic-gradient(rgba(0,0,0,0.06) 0 25%, transparent 0 50%)",
              backgroundSize: "16px 16px",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={svgDataUrl(draft)}
              alt={name}
              draggable={false}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : mode === "preview" && kind === "html" ? (
          /* HTML：iframe 渲染（sandbox 不给 allow-same-origin，脚本可跑但与宿主
           * 同源隔离）。src 用 kova://file/<绝对路径>——真实基址，页面里相对
           * 路径的图片/CSS/JS 才能解析（srcDoc 的 about:srcdoc 没有基址，这也
           * 是"预览加载不了静态图片"的根因）；web 端没有该协议，退回 srcDoc。 */
          <iframe
            ref={iframeRef}
            key={previewRev}
            src={canUseLocalFileUrl() ? localFileUrl(cwd, rel) : undefined}
            srcDoc={canUseLocalFileUrl() ? undefined : draft}
            sandbox="allow-scripts allow-forms allow-popups"
            title={name}
            className="h-full w-full bg-white"
          />
        ) : (
          <CodeMirrorCode
            className="h-full"
            height="100%"
            value={draft}
            path={name}
            editable={!truncated}
            onChange={truncated ? undefined : setDraft}
            transparentBg
            find={
              findOpen && findTarget === "cm"
                ? {
                    query: deferredFindQuery,
                    active: findIndex,
                    nav: cmFindNav,
                    replace: replaceOp ?? undefined,
                    onHits: (n, active) => {
                      setFindCount(n ?? 0);
                      // cm 端是跳转权威：active 直接采用，宿主不乐观推进
                      if (typeof active === "number") setFindIndex(active);
                      else if (!n) setFindIndex(-1);
                    },
                  }
                : undefined
            }
            selectionAction={
              onReference && !truncated
                ? {
                    label: t("library.common.reference"),
                    onSelect: ({ startLine, endLine }) => {
                      // 选区引用：先落盘草稿，行号对应磁盘内容再插入芯片
                      void flush().then((ok) => {
                        if (ok) onReference({ startLine, endLine });
                      });
                    },
                  }
                : undefined
            }
          />
        )}
      </div>

      {/* 查找条：悬浮在内容区右上（预览态贴正文、编辑态贴代码区），
          不挤顶栏——临时工具不该占常驻布局。替换行仅在可编辑源码态出现
          （canReplace 门控） */}
      {findOpen && findTarget ? (
        <FindBar
          className="absolute right-3 top-2 z-30 w-full max-w-120"
          query={findQuery}
          onQueryChange={setFindQuery}
          count={findCount}
          index={findIndex}
          onNext={() => stepFind(1)}
          onPrev={() => stepFind(-1)}
          onClose={closeFind}
          focusSignal={findFocusSignal}
          replaceValue={canReplace ? replaceValue : undefined}
          onReplaceChange={canReplace ? setReplaceValue : undefined}
          onReplace={canReplace ? () => doReplace("one") : undefined}
          onReplaceAll={canReplace ? () => doReplace("all") : undefined}
        />
      ) : null}

      {/* 右键菜单（复制选中文本）：宿主 DOM 与 iframe 两路共用 */}
      <FileViewerContextMenu
        menu={viewerMenu}
        onClose={() => setViewerMenu(null)}
      />
    </div>
  );
};
