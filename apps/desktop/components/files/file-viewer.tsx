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
  EyeIcon,
  FolderSearchIcon,
  Loader2Icon,
  PencilIcon,
} from "lucide-react";
import { CodeMirrorCode } from "@/components/code/cm-code";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  fsErrorText,
  fsReadFile,
  fsReadFileBase64,
  fsReveal,
  fsWriteFile,
  imageMimeFor,
} from "@/lib/workspace/fs";
import { canUseLocalFileUrl, localFileUrl } from "@/lib/workspace/local-file-url";

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

/** 文件内容就绪后的分支类型 */
type BodyKind = "image" | "html" | "markdown" | "code" | "text" | "unsupported";

function bodyKindOf(name: string): BodyKind {
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
  className?: string;
}> = ({ cwd, rel, name, defaultEdit, emptyActions, reloadSignal, className }) => {
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
  className?: string;
}> = ({ cwd, rel, name, defaultEdit, reloadSignal, className }) => {
  const kind = bodyKindOf(name);
  const [load, setLoad] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "too-large" }
    | { status: "ready"; text: string; truncated: boolean; binary: boolean }
    | { status: "image"; url: string }
  >({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setLoad({ status: "loading" });
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
      else
        setLoad({
          status: "ready",
          text: r.content,
          truncated: r.truncated,
          binary: r.binary,
        });
    });
    return () => {
      alive = false;
    };
  }, [cwd, rel, name, kind, reloadSignal]);

  const reveal = async () => {
    const err = await fsReveal(cwd, rel);
    if (err) toast.error(fsErrorText(err));
  };

  return (
    <div className={cn("flex h-full min-w-0 flex-col", className)}>
      {/* 顶栏：文件名 + 相对路径；右侧动作 */}
      <div className="border-border/60 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <FileTypeIcon path={name} className="size-4 shrink-0" />
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="text-muted-foreground/70 min-w-0 flex-1 truncate font-mono text-[11px]">
          {rel}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="在系统中显示"
          onClick={() => void reveal()}
        >
          <FolderSearchIcon className="size-3.5" />
        </Button>
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
            在系统中打开
          </Button>
        </div>
      ) : (
        // reloadSignal 变化 = 用户按了刷新：重挂载文本体（卸载时先 flush 草稿），
        // 重新以盘上内容为基线
        <TextBody
          key={`${rel}\u0000${reloadSignal ?? 0}`}
          cwd={cwd}
          rel={rel}
          name={name}
          kind={kind}
          initial={load.text}
          truncated={load.truncated}
          defaultEdit={defaultEdit}
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
}> = ({ cwd, rel, name, kind, initial, truncated, defaultEdit }) => {
  /** 可切换预览的文件（md 渲染 / html 页面）；其余文本编辑态即预览 */
  const hasPreview = kind === "markdown" || kind === "html";
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

  const flush = useCallback(async () => {
    const text = draftRef.current;
    if (text === baselineRef.current) return;
    setStatus("saving");
    const err = await fsWriteFile(cwd, rel, text);
    if (err) {
      setStatus("idle");
      toast.error(fsErrorText(err));
      return;
    }
    setBaseline(text);
    setStatus("saved");
  }, [cwd, rel]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

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
      void flush().then(() => setPreviewRev((r) => r + 1));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 状态行：模式切换（可预览的文件）+ 保存状态 + 截断提示 */}
      <div className="border-border/40 flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        {hasPreview && (
          <div className="bg-muted/60 flex items-center gap-0.5 rounded-lg p-0.5">
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
                  "flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors",
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
        <span className="text-muted-foreground flex-1 text-xs">
          {truncated && "内容超过 2MB 已截断，仅编辑可见部分；"}
          {status === "saving"
            ? "保存中…"
            : dirty
              ? "未保存（停顿后自动保存）"
              : status === "saved"
                ? "已保存"
                : ""}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {mode === "preview" && kind === "markdown" ? (
          /* 正文限宽居中：库里的 md 常常是长文，横跨两千像素无法阅读 */
          <div className="aui-markdown h-full overflow-y-auto p-5">
            <div className="mx-auto w-full max-w-3xl">
              <MarkdownText text={draft} />
            </div>
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
          />
        )}
      </div>
    </div>
  );
};