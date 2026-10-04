"use client";

import {
  useCallback,
  useEffect,
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
  fsReadFileBase64,
  fsWriteFile,
  imageMimeFor,
  type FsFileContent,
} from "@/lib/workspace/fs";
import { CodeMirrorCode } from "@/components/code/cm-code";
import { stripReadLineNumbers } from "@/lib/pi/read-result";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { splitPath } from "./git-files";
import { FileTypeIcon } from "./file-type-icon";
import { TabEmpty } from "./tab-empty";

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
 * Markdown 文件（含计划）头部给「预览 | 源码」切换，预览即消息区同款渲染
 * （复用 MarkdownText：自带 .aui-markdown 包装层，代码块头部按钮/边框等
 * 样式都作用域在该层下，裸 Streamdown 会回退到默认定位导致按钮跑飞）。
 * 磁盘模式下扩展名命中图片（lib/fs IMAGE_MIME）走 ImageView：原始字节
 * base64 → data URL 直显，不再落"二进制无法预览"占位。
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

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
const FileBody: FC<{ part: FilePart; note?: string; edit?: FileEdit }> = ({
  part,
  note,
  edit,
}) => {
  const isMd = /\.mdx?$/i.test(part.path);
  const [mode, setMode] = useState<"preview" | "source">(
    isMd ? "preview" : "source",
  );
  // 行号前缀只在 read 快照里有；计划/写入的正文是原文，别碰
  const text = part.kind === "read" ? stripReadLineNumbers(part.text) : part.text;
  // 源码态看草稿，预览态看盘上内容（未保存的编辑不进预览）
  const source = edit ? edit.draft : text;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileHeader
        path={part.path}
        extra={
          <>
            {isMd ? <ModeToggle mode={mode} onChange={setMode} /> : null}
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
      <div className="min-h-0 flex-1 overflow-auto">
        {!source ? (
          <p className="text-muted-foreground/60 px-3 py-2 text-xs">
            （没有记录到内容）
          </p>
        ) : mode === "preview" ? (
          <div className="px-4 py-3">
            <MarkdownText text={text} />
          </div>
        ) : (
          <CodeMirrorCode
            value={source}
            path={part.path}
            editable={!!edit}
            onChange={edit?.onDraftChange}
          />
        )}
      </div>
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
const DiskFileView: FC<{ cwd: string; path: string }> = ({ cwd, path }) => {
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

/**
 * 图片预览（磁盘模式）：fs_read_file_base64 原始字节 → data URL（CSP 已放行）。
 * 与 DiskFileView 并列而非在其内分支——图片扩展名在挂载时即定，两条读取路径
 * 的 state 机也不同，拆成兄弟组件最干净（FileTab 分流，key 保证换文件重置）。
 */
const ImageView: FC<{ cwd: string; path: string; mime: string }> = ({
  cwd,
  path,
  mime,
}) => {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; src: string; size: number }
    | { status: "too-large" }
    | { status: "error" }
  >({ status: "loading" });
  useEffect(() => {
    let alive = true;
    void fsReadFileBase64(cwd, path).then((r) => {
      if (!alive) return;
      if (r === "too-large") setState({ status: "too-large" });
      else if (r)
        setState({
          status: "ready",
          src: `data:${mime};base64,${r.base64}`,
          size: r.size,
        });
      else setState({ status: "error" });
    });
    return () => {
      alive = false;
    };
  }, [cwd, path, mime]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileHeader path={path} />
      {state.status === "ready" ? (
        <NoteBar
          text={`${path.slice(path.lastIndexOf(".") + 1).toUpperCase()} · ${formatBytes(state.size)}`}
        />
      ) : null}
      <div className="bg-muted/20 min-h-0 flex-1 overflow-auto p-4">
        {state.status === "loading" ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            读取图片…
          </div>
        ) : state.status === "ready" ? (
          <div className="grid h-full w-full place-items-center">
            <img
              src={state.src}
              alt={path}
              draggable={false}
              className="max-h-full max-w-full rounded-md object-contain shadow-sm"
            />
          </div>
        ) : (
          <TabEmpty
            icon={ImageOffIcon}
            text={
              state.status === "too-large"
                ? "图片超过 20MB，暂不预览"
                : "读取失败（文件可能已被删除，或无权限访问）"
            }
          />
        )}
      </div>
    </div>
  );
};

/** 快照模式：数据来自消息里的工具 part（read/write/plan/memory 回放） */
const SnapshotFileTab: FC<{ tab: PanelTab }> = ({ tab }) => {
  const part = useFilePart(tab.focus);
  if (!part)
    return (
      <TabEmpty
        icon={FileTextIcon}
        text="找不到对应的记录（会话已更新或已切换）"
      />
    );
  return <FileBody key={tab.focus ?? part.path} part={part} />;
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
    if (mime)
      return <ImageView key={key} cwd={cwd} path={tab.path} mime={mime} />;
    return <DiskFileView key={key} cwd={cwd} path={tab.path} />;
  }
  return <SnapshotFileTab tab={tab} />;
};
