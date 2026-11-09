"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import { FileTextIcon, ImageOffIcon, Loader2Icon } from "lucide-react";
import type { PanelTab } from "@/lib/panels/panel-tabs";
import {
  fsErrorText,
  fsReadFile,
  fsWriteFile,
  imageMimeFor,
  type FsFileContent,
} from "@/lib/workspace/fs";
import { blobUrlFor } from "@/lib/pi/image-blob-url";
import type { PiImagePartData } from "@/lib/pi/pi-bridge";
import { formatBytes } from "@/lib/panels/artifacts";
import { CodeMirrorCode } from "@/components/code/cm-code";
import { cn } from "@/lib/utils";
import { ImageView, ZoomableImage } from "./image-viewer";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import {
  buildCodeDirective,
  toWorkspaceRelative,
} from "@/lib/composer/code-reference";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { stripReadLineNumbers } from "@/lib/pi/read-result";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { splitPath } from "./git-files";
import { FileTypeIcon } from "./file-type-icon";
import { TabEmpty } from "./tab-empty";
import { FileRail } from "./file-rail";

/**
 * 「文件」标签：单文件内容回看，三种数据源：
 * - 磁盘实时（tab.path，文件树标签点击唤起）：fs_read_file 现读盘上内容，
 *   与消息无关；重开/刷新后仍是最新内容；文本文件可就地编辑（CodeMirror
 *   editable），顶栏「● 未保存 + 保存」或 Cmd/Ctrl+S 走 fs_write_file 写盘；
 *   超 2MB 截断与二进制文件保持只读（截断缓冲保存会毁文件）；
 * - read 调用：tab.focus = read part 的 toolCallId（sidecar 带行号前缀，
 *   这里剥掉交给 CodeMirror 自己的行号栏），展示当次读取快照，非磁盘实时内容；
 * - plan_write（含历史 SubmitPlan/SubmitGoal）：tab.focus = 提交 part 的
 *   toolCallId，渲染 args 里的完整计划 Markdown（计划进右侧面板的入口）。
 * 快照类历史会话/刷新后同样可打开。
 * 源码态编辑器撑满剩余高度（点正文外的空白也能定位光标），长文件由
 * 编辑器内部滚动；预览态仍是内容自适应 + 外层滚动。
 * Markdown 文件（含计划）头部给「预览 | 源码」切换，预览即消息区同款渲染
 * （复用 MarkdownText：自带 .aui-markdown 包装层，代码块头部按钮/边框等
 * 样式都作用域在该层下，裸 Streamdown 会回退到默认定位导致按钮跑飞）。
 * SVG 同样是文本文件（fs_read_file 正常出内容），头部给同一组切换：
 * 预览走 <img> + data URL（图片上下文不执行脚本、不加载外链，文件内的
 * CSS/SMIL 动画仍会播放），源码走 CodeMirror 的 XML 高亮。
 * 磁盘模式下扩展名命中图片（lib/fs IMAGE_MIME）走 image-viewer 的 ImageView：
 * 原始字节 base64 → data URL 直显 + 缩放/平移（见 image-viewer.tsx），不再落
 * "二进制无法预览"占位。
 */

type FilePart = {
  kind: "read" | "plan" | "write" | "memory";
  /** read/write = 真实路径；plan/memory = 标题拼的虚拟路径（图标/语言用） */
  path: string;
  text: string;
};

/** 打包成单字符串选择器：值不变即引用相等，流式期间避免逐 token 重渲 */
function useFilePart(focus: string | undefined): FilePart | null {
  const packed = useAuiState((s) => {
    if (!focus) return null;
    for (const m of s.thread.messages) {
      for (const p of m.content) {
        if (p.type !== "tool-call" || p.toolCallId !== focus) continue;
        const args = p.args as Record<string, unknown> | undefined;
        const str = (k: string) =>
          typeof args?.[k] === "string" ? (args[k] as string) : "";
        if (p.toolName === "read") {
          const raw =
            typeof p.result === "string"
              ? p.result
              : p.result == null
                ? ""
                : JSON.stringify(p.result);
          return ["read", str("file_path"), raw].join("\0");
        }
        if (p.toolName === "write") {
          // 产物「代码」查看：write args 里就是完整内容快照（源码，无行号前缀）
          return ["write", str("file_path"), str("content")].join("\0");
        }
        if (
          p.toolName === "plan_write" ||
          p.toolName === "SubmitPlan" ||
          p.toolName === "SubmitGoal"
        ) {
          const title =
            str("title") || (p.toolName === "SubmitGoal" ? "目标" : "计划");
          return ["plan", `${title}.md`, str("markdown")].join("\0");
        }
        if (p.toolName === "memory_write") {
          // 记忆写入快照：args.content 就是写入的 Markdown（scope/file 拼虚拟路径）
          const scope = str("scope") || "global";
          const file = str("file") || "MEMORY.md";
          return ["memory", `${scope}/${file}`, str("content")].join("\0");
        }
        if (p.toolName === "memory_read") {
          const scope = str("scope") || "global";
          const file = str("file");
          const raw =
            typeof p.result === "string"
              ? p.result
              : p.result == null
                ? ""
                : JSON.stringify(p.result);
          if (!file) {
            // 无 file = 列出全部记忆文件：结果是逐行文件名，按纯文本看
            return ["memory", "memory/文件列表.txt", raw].join("\0");
          }
          // 有 file 的结果首行是 `scope/rel`，空一行后接正文——剥掉位置行只留内容
          const sep = raw.indexOf("\n\n");
          const body =
            sep > 0 && /^[^\n]+\/[^\n]+$/.test(raw.slice(0, sep))
              ? raw.slice(sep + 2)
              : raw;
          return ["memory", `${scope}/${file}`, body].join("\0");
        }
      }
    }
    return null;
  });
  if (packed === null) return null;
  const [kind, path, ...rest] = packed.split("\0");
  const parsed: FilePart["kind"] =
    kind === "plan"
      ? "plan"
      : kind === "write"
        ? "write"
        : kind === "memory"
          ? "memory"
          : "read";
  return { kind: parsed, path, text: rest.join("\0") };
}

/**
 * read 快照命中的配对成图：图片字节在转录里的事实源是 data part（name
 * "image"，按 toolCallId 与工具行认亲，与消息流图廊同一机制）；工具文本
 * 结果里只有宿主的占位行（"Image attached: …"）。selector 必须打包成
 * 字符串返回——getSnapshot 里新建数组会破坏引用稳定（useFilePart 同款约定）。
 */
function useImagePartsPacked(focus: string | undefined): string | null {
  return useAuiState((s) => {
    if (!focus) return null;
    let packed: string | null = null;
    for (const m of s.thread.messages) {
      for (const p of m.content) {
        if (p.type !== "data" || p.name !== "image") continue;
        const d = p.data as Partial<PiImagePartData> | undefined;
        if (d?.toolCallId !== focus) continue;
        const piece = [
          typeof d.src === "string" ? d.src : "",
          typeof d.mimeType === "string" ? d.mimeType : "",
          typeof d.bytes === "number" ? String(d.bytes) : "0",
        ].join("\u0000");
        packed = packed === null ? piece : `${packed}\u0001${piece}`;
      }
    }
    return packed;
  });
}

const ModeToggle: FC<{
  mode: "preview" | "source";
  onChange: (m: "preview" | "source") => void;
}> = ({ mode, onChange }) => (
  // 全局 Tabs 的 outline 变体（描边容器 + bg-muted 滑块），自带滑动动画
  <Tabs
    value={mode}
    onValueChange={(v) => onChange(v as "preview" | "source")}
    className="ml-auto shrink-0"
  >
    <TabsList
      variant="outline"
      className="group-data-horizontal/tabs:h-6 rounded-md p-0.5 text-xs"
    >
      <TabsTrigger value="preview" className="rounded px-2 py-0 text-xs">
        预览
      </TabsTrigger>
      <TabsTrigger value="source" className="rounded px-2 py-0 text-xs">
        源码
      </TabsTrigger>
    </TabsList>
  </Tabs>
);

/** 顶栏：文件图标 + 文件名 + 灰色目录（截断时 title 看全路径）；extra 挂右侧控件 */
const FileHeader: FC<{ path: string; extra?: ReactNode }> = ({
  path,
  extra,
}) => {
  const { dir, base } = splitPath(path);
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2"
      title={path}
    >
      <FileTypeIcon path={path} />
      <span className="truncate text-[13px] font-medium text-foreground/90">
        {base}
      </span>
      {dir ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground/70">
          {dir}
        </span>
      ) : null}
      {extra}
    </div>
  );
};

/** 顶栏下方的浅色提示条（截断说明 / 图片格式与体积） */
const NoteBar: FC<{ text: string }> = ({ text }) => (
  <p className="bg-muted/30 text-muted-foreground shrink-0 border-b border-border/60 px-3 py-1 text-xs">
    {text}
  </p>
);

/**
 * SVG 预览：文本 → base64 data URL 交给 <img>。
 * 不用内联 dangerouslySetInnerHTML / object / iframe：<img> 的图片上下文
 * 不执行脚本、不加载外部资源，但 SVG 自带的 CSS/SMIL 动画仍会播放。
 * 预览内容跟随已保存文本（与 Markdown 一致，源码态的未保存草稿不进预览）。
 */
const SvgPreview: FC<{ text: string; path: string }> = ({ text, path }) => {
  const src = useMemo(() => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  }, [text]);
  // 记录失败的 src 而非布尔值：内容一变（重新加载/保存）自动恢复尝试
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    return (
      <TabEmpty
        icon={ImageOffIcon}
        text="SVG 渲染失败（文件可能不是有效的 SVG）"
      />
    );
  }
  // 与磁盘图片共用看图器：矢量图「适应」允许放大（贴满容器才是原观感），
  // 拿不到固有尺寸（无 width/height 的 SVG）时它自动退回「撑满容器 + 无缩放条」
  return (
    <ZoomableImage
      src={src}
      alt={path}
      upscaleToFit
      onError={() => setFailedSrc(src)}
    />
  );
};

/**
 * 磁盘模式编辑上下文（快照模式不传 = 只读，行为不变）：
 * draft 是受控草稿，dirty 驱动顶栏保存按钮；预览态渲染的仍是盘上内容，
 * 编辑只发生在源码态，切走再切回草稿不丢（组件 state 持有）。
 */
type FileEdit = {
  draft: string;
  dirty: boolean;
  saving: boolean;
  onDraftChange: (v: string) => void;
  onSave: () => void;
};

/** part 到位后才挂载：预览/源码初值要按扩展名定，key 保证换文件重置 */
const FileBody: FC<{
  part: FilePart;
  note?: string;
  edit?: FileEdit;
  /** 打开后滚动定位到的行（知识引用「跳到行」用） */
  focusLine?: number;
  /** 行定位非ce：同一行重复点击也重新滚动 */
  focusNonce?: number;
}> = ({ part, note, edit, focusLine, focusNonce }) => {
  const isMd = /\.mdx?$/i.test(part.path);
  const isSvg = /\.svg$/i.test(part.path);
  const previewable = isMd || isSvg;
  const [mode, setMode] = useState<"preview" | "source">(
    previewable ? (focusLine && isMd ? "source" : "preview") : "source",
  );
  // 行号随引用点击变化：markdown 渲染视图没有行概念，带行号时落到源码态
  useEffect(() => {
    if (focusLine && isMd) setMode("source");
  }, [focusLine, focusNonce, isMd]);
  // 行号前缀只在 read 快照里有；计划/写入的正文是原文，别碰
  const text = part.kind === "read" ? stripReadLineNumbers(part.text) : part.text;
  // 源码态看草稿，预览态看盘上内容（未保存的编辑不进预览）
  const source = edit ? edit.draft : text;
  // 「引用到对话」只对真实文件开放：read/write 两种 kind 的 path 是真实路径
  // （文件树标签给的是 cwd 相对路径——正是 agent cwd 里的形态，最理想；快照可能
  // 是绝对路径，插入前经 toWorkspaceRelative 折算）；plan/memory 是拼出来的
  // 虚拟名，引用它等于给 agent 一个不存在的文件
  const referencePath =
    part.kind === "read" || part.kind === "write" ? part.path : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileHeader
        path={part.path}
        extra={
          <>
            {previewable ? <ModeToggle mode={mode} onChange={setMode} /> : null}
            {edit?.dirty ? (
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <span className="text-muted-foreground text-xs">● 未保存</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={edit.saving}
                  onClick={edit.onSave}
                >
                  {edit.saving ? "保存中…" : "保存"}
                </Button>
              </div>
            ) : null}
          </>
        }
      />
      {note ? <NoteBar text={note} /> : null}
      {!source ? (
        <p className="text-muted-foreground px-3 py-2 text-xs">
          （没有记录到内容）
        </p>
      ) : mode === "preview" ? (
        /* 预览：Markdown 长文外层滚动；SVG 交给看图器自己滚（两套滚动会打架） */
        <div
          className={cn("min-h-0 flex-1", isSvg ? "overflow-hidden" : "overflow-auto")}
        >
          {isSvg ? (
            <SvgPreview text={text} path={part.path} />
          ) : (
            <div className="px-4 py-3">
              <MarkdownText text={text} />
            </div>
          )}
        </div>
      ) : (
        /* 源码：编辑器撑满剩余高度（height="100%" 需容器链逐层定高，
           否则百分比落回 auto）——正文之外的空白也属于编辑器，点哪都能
           定位光标/起选；长文件由编辑器内部滚动（行号跟随），外层不再
           滚动，避免两套滚动容器打架 */
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeMirrorCode
            className="h-full"
            height="100%"
            value={source}
            path={part.path}
            editable={!!edit}
            onChange={edit?.onDraftChange}
            scrollToLine={focusLine}
            scrollNonce={focusNonce}
            transparentBg
            selectionAction={
              referencePath
                ? {
                    label: "引用到对话",
                    onSelect: ({ startLine, endLine }) => {
                      // 引用路线：只插入芯片（发送时展开成 @path (lines N-M)），
                      // 内容不内联——agent 按行号用文件工具自己读（内容永远最新）
                      const inserted = insertIntoComposer(
                        buildCodeDirective({
                          path: toWorkspaceRelative(
                            referencePath,
                            getWorkspace(),
                          ),
                          startLine,
                          endLine,
                        }),
                      );
                      if (!inserted) {
                        toast.error("输入框未就绪，未能插入引用");
                      }
                    },
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
};

/**
 * 磁盘实时模式（文件树点击唤起）：fs_read_file 现读 + 就地编辑保存。
 * 组件按 (cwd, path) key 重挂载，换文件即重置加载态、草稿与预览/源码选择。
 * 保存语义：fs_write_file 覆盖写；成功后把盘上内容基线回写为草稿内容
 * （dirty 归零），失败 toast 错误码文案、草稿保留可重试。
 * 已知限制（v1）：切走标签丢未保存草稿（靠「● 未保存」提示）；
 * agent 并发写不做冲突检测，用户保存即覆盖。
 */
const DiskFileView: FC<{
  cwd: string;
  path: string;
  line?: number;
  lineNonce?: number;
}> = ({ cwd, path, line, lineNonce }) => {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; data: FsFileContent } | { status: "error" }
  >({ status: "loading" });
  /** 编辑草稿：null = 未动过笔，显示盘上内容 */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void fsReadFile(cwd, path).then((data) => {
      if (!alive) return;
      setState(data ? { status: "ready", data } : { status: "error" });
    });
    return () => {
      alive = false;
    };
  }, [cwd, path]);

  const baseline = state.status === "ready" ? state.data.content : "";
  const dirty = draft !== null && draft !== baseline;
  // 截断/二进制不可编辑（与 FileBody 的 edit 传入口径一致）
  const editable =
    state.status === "ready" && !state.data.binary && !state.data.truncated;
  const save = useCallback(() => {
    if (draft === null || draft === baseline || saving) return;
    const text = draft;
    setSaving(true);
    void fsWriteFile(cwd, path, text).then((err) => {
      setSaving(false);
      if (err) {
        toast.error(fsErrorText(err));
        return;
      }
      // 盘上内容即草稿：基线回写，否则 setDraft(null) 会把视图"退回"旧内容
      setState((s) =>
        s.status === "ready" ? { ...s, data: { ...s.data, content: text } } : s,
      );
      setDraft(null);
      toast.success("已保存");
    });
  }, [draft, baseline, saving, cwd, path]);

  // Cmd/Ctrl+S 保存：面板只挂载活动标签（index.tsx 以 tab.id 重挂载），
  // 不会串到别的文件标签误存；只读态不劫持系统快捷键
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, editable]);

  if (state.status === "loading")
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        读取文件…
      </div>
    );
  if (state.status === "error")
    return (
      <TabEmpty
        icon={FileTextIcon}
        text="读取失败（文件可能已被删除，或无权限访问）"
      />
    );
  const { data } = state;
  if (data.binary)
    return <TabEmpty icon={FileTextIcon} text="二进制文件，无法预览内容" />;
  return (
    <FileBody
      // kind=write：正文是盘上原文，无行号前缀可剥；md/源码切换按扩展名走
      part={{ kind: "write", path, text: data.content }}
      focusLine={line}
      focusNonce={lineNonce}
      note={
        data.truncated ? "文件超过 2MB，仅显示开头部分（不可编辑）" : undefined
      }
      // 截断文件禁编辑：拿半份缓冲保存会把文件写坏
      edit={
        editable
          ? {
              draft: draft ?? data.content,
              dirty,
              saving,
              onDraftChange: setDraft,
              onSave: save,
            }
          : undefined
      }
    />
  );
};

/** 快照模式：数据来自消息里的工具 part（read/write/plan/memory 回放） */
const SnapshotFileTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const part = useFilePart(tab.focus);
  const imgPacked = useImagePartsPacked(tab.focus);
  const images = useMemo(
    () =>
      imgPacked === null
        ? []
        : imgPacked
            .split("\u0001")
            .map((piece) => {
              const [src = "", mimeType = "", bytes = "0"] = piece.split("\0");
              return { src, mimeType, bytes: Number(bytes) || 0 };
            })
            .filter((im) => im.src.startsWith("data:")),
    [imgPacked],
  );
  if (!part)
    return (
      <TabEmpty
        icon={FileTextIcon}
        text="找不到对应的记录（会话已更新或已切换）"
      />
    );
  // read 快照命中图片：正文文本只是宿主占位行，真图在配对的 data-image
  // part。拿不到配对（早于投影链路的旧会话 / 图被 2MiB 闸门拦下）时：
  // 闸门拦截的结果文本自带「图片未展示：…」说明行，继续走文本渲染最诚实；
  // 其余退磁盘实时读（ImageView 自带加载/超限/失败态，绝对路径读不到就
  // 落它的错误空态）。
  if (part.kind === "read" && imageMimeFor(part.path)) {
    if (images.length > 0) {
      const first = images[0]!;
      return (
        <SnapshotImageView
          key={tab.focus ?? part.path}
          path={part.path}
          src={first.src}
          bytes={first.bytes}
          extra={images.length > 1 ? `共 ${images.length} 张` : undefined}
        />
      );
    }
    if (part.text.includes("图片未展示"))
      return <FileBody key={tab.focus ?? part.path} part={part} />;
    const mime = imageMimeFor(part.path);
    if (mime)
      return (
        <ImageView
          key={part.path}
          cwd={getWorkspace() ?? ""}
          path={part.path}
          mime={mime}
        />
      );
  }
  return <FileBody key={tab.focus ?? part.path} part={part} />;
};

/** read 快照的成图渲染：data URL 先转 Blob URL（DOM 不驻留大段 base64，
 *  同消息流 ImagePartCard 的性能口径），交给看图器缩放/平移 */
const SnapshotImageView: FC<{
  path: string;
  src: string;
  bytes: number;
  extra?: string;
}> = ({ path, src, bytes, extra }) => {
  const blobSrc = useMemo(() => blobUrlFor(src), [src]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // 回调必须引用稳定 + 值不变即返回 cur：ZoomableImage 的 syncNatural →
  // effect 链依赖本回调的引用，内联箭头 + 每次新对象会把它带进无限重渲染
  const handleNatural = useCallback(
    (s: { w: number; h: number }) => {
      setNatural((cur) =>
        cur?.w === s.w && cur?.h === s.h ? cur : { w: s.w, h: s.h },
      );
    },
    [],
  );
  if (!blobSrc)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <FileHeader path={path} />
        <TabEmpty icon={ImageOffIcon} text="图片数据缺失（该记录未带有效快照）" />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileHeader path={path} />
      <NoteBar
        text={
          [
            path.slice(path.lastIndexOf(".") + 1).toUpperCase(),
            formatBytes(bytes),
            natural ? `${natural.w} × ${natural.h}` : null,
            extra,
            "读取时快照",
          ]
            .filter(Boolean)
            .join(" · ")
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ZoomableImage
          src={blobSrc}
          alt={path}
          onNatural={handleNatural}
        />
      </div>
    </div>
  );
};

/**
 * 数据源路由：tab.path 存在 = 文件树磁盘模式（两字段互斥，唤起方各自清对面
 * 残留：tool-panel 带 path:undefined，文件树带 focus:undefined）。
 * 分流成两个子组件而非同一组件内早退——useFilePart 是 hook，条件调用会破坏
 * hooks 规则。
 */
export const FileTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  if (tab.path) {
    const cwd = tab.cwd ?? "";
    if (!cwd)
      return <TabEmpty icon={FileTextIcon} text="缺少工作目录上下文" />;
    const key = `${cwd}\u0000${tab.path}`;
    const mime = imageMimeFor(tab.path);
    // 磁盘模式统一右缘挂文件树栏（源码/图片同语境）：看代码时不再切
    // 「文件树」标签；开合态与树的展开态都跨标签保持（见 FileRail 注释）
    return (
      <div className="flex h-full min-h-0">
        <div className="min-w-0 flex-1">
          {mime ? (
            <ImageView key={key} cwd={cwd} path={tab.path} mime={mime} />
          ) : (
            <DiskFileView
              key={key}
              cwd={cwd}
              path={tab.path}
              line={tab.line}
              lineNonce={tab.lineNonce}
            />
          )}
        </div>
        <FileRail cwd={cwd} activePath={tab.path} />
      </div>
    );
  }
  return <SnapshotFileTab tab={tab} />;
};
