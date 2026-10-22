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

import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import {
  AlertCircleIcon,
  AtSignIcon,
  EyeIcon,
  FolderSearchIcon,
  Loader2Icon,
  PencilIcon,
} from "lucide-react";
import { CodeMirrorCode } from "@/components/code/cm-code";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { FileManagerIcon } from "./file-manager-icon";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
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
import { NoteTagsEditor } from "./note-tags-editor";

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
type BodyKind = "image" | "svg" | "html" | "markdown" | "code" | "text" | "unsupported";

function bodyKindOf(name: string): BodyKind {
  // svg 是文本：走"预览（<img> 渲染，脚本不执行）/ 编辑（源码）"双态，
  // 不归图片（图片分支是 base64 二进制读，不给编辑）
  if (/\.svg$/i.test(name)) return "svg";
  if (imageMimeFor(name)) return "image";
  if (/\.html?$/i.test(name)) return "html";
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
  /** 默认落在编辑态（笔记区「点开就写」） */
  defaultEdit?: boolean;
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
  defaultEdit,
  emptyActions,
  reloadSignal,
  onReference,
  metaEnabled,
  onRenamed,
  className,
}) => {
  if (!cwd || rel === null) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center",
          className,
        )}
      >
        <EyeIcon className="text-muted-foreground/50 size-6" />
        <p className="text-muted-foreground/60 text-xs select-none">
          在左侧选择一个文件，这里显示内容并可编辑
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
      defaultEdit={Boolean(defaultEdit)}
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
  defaultEdit: boolean;
  reloadSignal?: number;
  onReference?: (range?: { startLine: number; endLine: number }) => void;
  metaEnabled?: boolean;
  onRenamed?: (newRel: string, newName: string) => void;
  className?: string;
}> = ({
  cwd,
  rel,
  name,
  defaultEdit,
  reloadSignal,
  onReference,
  metaEnabled,
  onRenamed,
  className,
}) => {
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
      if (!next || next === name) return;
      if (/[\\/:*?"<>|]/.test(next)) {
        toast.error('文件名不能包含 \\ / : * ? " < > |');
        return;
      }
      // 改名后组件按新 rel 重挂载并读盘：先把未保存草稿落下，避免丢最后一段输入
      const flushed = flushTextRef.current ? await flushTextRef.current() : true;
      if (!flushed) return;
      const err = await fsRename(cwd, rel, next);
      if (err) {
        toast.error(fsErrorText(err));
        return;
      }
      const slash = rel.lastIndexOf("/");
      const parent = slash < 0 ? "" : rel.slice(0, slash);
      onRenamed?.(parent ? `${parent}/${next}` : next, next);
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
            aria-label="重命名文件"
            spellCheck={false}
            className="border-border/70 bg-background focus:border-ring h-6 w-56 min-w-0 rounded-md border px-1.5 text-sm font-medium outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={startRename}
            disabled={!onRenamed}
            title={onRenamed ? "点击重命名" : name}
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
          <span className="text-muted-foreground/70 min-w-0 flex-1 truncate font-mono text-[11px]">
            {rel}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {onReference && (
          <TooltipIconButton
            tooltip="引用"
            side="bottom"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="引用"
            disabled={load.status === "error"}
            onClick={() => void referenceWhole()}
          >
            <AtSignIcon className="size-4" />
          </TooltipIconButton>
        )}
        <TooltipIconButton
          tooltip="在系统中显示"
          side="bottom"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="在系统中显示"
          onClick={() => void reveal()}
        >
          <FileManagerIcon className="size-4.5" />
        </TooltipIconButton>
      </div>

      {load.status === "loading" ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin" />
          加载中…
        </div>
      ) : load.status === "error" ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
          <AlertCircleIcon className="size-6" />
          读取失败（文件可能已被移动或删除）
        </div>
      ) : load.status === "too-large" ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
          <AlertCircleIcon className="size-6" />
          文件超过 20MB，不在应用内预览
          <Button variant="outline" size="sm" onClick={() => void reveal()}>
            <FileManagerIcon className="size-4.5" />
            在系统中打开
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
          该文件类型暂不支持预览
          <Button variant="outline" size="sm" onClick={() => void reveal()}>
            <FileManagerIcon className="size-4.5" />
            在系统中打开
          </Button>
        </div>
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
          defaultEdit={defaultEdit}
          onReference={onReference}
          registerFlush={registerFlush}
          metaEnabled={metaEnabled}
        />
      )}
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
  defaultEdit: boolean;
  onReference?: (range?: { startLine: number; endLine: number }) => void;
  registerFlush?: (fn: (() => Promise<boolean>) | null) => void;
  metaEnabled?: boolean;
}> = ({
  cwd,
  rel,
  name,
  kind,
  initial,
  truncated,
  defaultEdit,
  onReference,
  registerFlush,
  metaEnabled,
}) => {
  /** 可切换预览的文件（md 渲染 / html 页面 / svg 图形）；其余文本编辑态即预览 */
  const hasPreview = kind === "markdown" || kind === "html" || kind === "svg";
  const [mode, setMode] = useState<"preview" | "edit">(
    hasPreview && !defaultEdit ? "preview" : "edit",
  );
  const [draft, setDraft] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  /** iframe 预览的重载版本（切到预览且草稿已落盘后 +1） */
  const [previewRev, setPreviewRev] = useState(0);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastInitialRef = useRef(initial);

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

  /**
   * 切到预览：先把未落盘草稿落下，再 bump 预览版本让 iframe 重新加载——
   * kova:// 预览读的是盘上文件，草稿不落盘就看不到刚改的内容。
   */
  const switchMode = (next: "preview" | "edit") => {
    setMode(next);
    if (next === "preview") {
      void flush().then((ok) => {
        if (ok) setPreviewRev((r) => r + 1);
      });
    }
  };

  return (
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
      {/* 状态行：模式切换（可预览的文件）+ 保存状态 + 右侧标签编辑。
          三个控件统一 28px 高（h-7），标签靠右对齐——之前标签贴着模式切换、
          且比它高一点，看起来像两套尺寸。 */}
      <div className="border-border/40 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        {hasPreview && (
          <div className="bg-muted/60 flex h-7 items-center gap-0.5 rounded-lg p-0.5">
            {(
              [
                { value: "preview", label: "预览", icon: EyeIcon },
                { value: "edit", label: "编辑", icon: PencilIcon },
              ] as const
            ).map((v) => (
              <button
                key={v.value}
                onClick={() => switchMode(v.value)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-md px-2 text-xs transition-colors",
                  mode === v.value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <v.icon className="size-3" />
                {v.label}
              </button>
            ))}
          </div>
        )}
        <span
          className={cn(
            "text-muted-foreground min-w-0 truncate text-xs",
            metaEnabled ? "shrink" : "flex-1",
          )}
        >
          {truncated && "内容超过 2MB 已截断，仅编辑可见部分；"}
          {status === "saving"
            ? "保存中…"
            : dirty
              ? "未保存（停顿后自动保存）"
              : status === "saved"
                ? "已保存"
                : ""}
        </span>
        {metaEnabled && (
          <NoteTagsEditor
            cwd={cwd}
            rel={rel}
            className="ml-auto min-w-0 justify-end"
          />
        )}
      </div>

      <div className="min-h-0 flex-1">
        {mode === "preview" && kind === "markdown" ? (
          /* 正文限宽居中：库里的 md 常常是长文，横跨两千像素无法阅读 */
          <div className="aui-markdown h-full overflow-y-auto p-5">
            <div className="mx-auto w-full max-w-5xl">
              <MarkdownText text={draft} />
            </div>
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
            selectionAction={
              onReference && !truncated
                ? {
                    label: "引用",
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
    </div>
  );
};