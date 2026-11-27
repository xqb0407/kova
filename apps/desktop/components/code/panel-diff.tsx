"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import type {
  DiffLineAnnotation,
  FileDiffContentsLoader,
  SelectedLineRange,
} from "@pierre/diffs/react";
import { cn } from "@/lib/utils";
import { DIFF_SHIKI_THEME, resolveCodeThemeName } from "@/lib/markdown/code-theme";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { useUiPrefs } from "@/lib/settings/ui-prefs";
import {
  extractPatchLineRange,
  normalizeDiffLineSelection,
  type CodeCommentRange,
} from "@/lib/composer/code-comment";
import { InlineCodeCommentEditor } from "./inline-code-comment-editor";
import { CodeCommentCard } from "./code-comment-card";
import { useCodeComments } from "./use-code-comments";
import {
  removeCodeComment,
  type CodeCommentEntry,
} from "@/lib/composer/code-comment-store";
import { removeDirectiveFromComposer } from "@/components/agent-thread/cm-composer-input";
import "@/app/styles/panel-diff.css";

/**
 * 右侧面板的 git diff 视图（参考 hernessX）：@pierre/diffs（Shiki 高亮）
 * unified 单栏 + disableFileHeader，全高渲染随面板整体滚动。
 * 与 CodeMirror（设置页代码预览 / 后续文件预览）是两套渲染引擎，主题经
 * DIFF_SHIKI_THEME 用同一份配置映射。库内部是自定义元素（shadow DOM），
 * 只在客户端挂载（ssr:false）；主题 token 通过 --diffs-* CSS 变量穿透。
 */

const PatchDiff = dynamic(
  () => import("@pierre/diffs/react").then((m) => m.PatchDiff),
  { ssr: false },
);
const MultiFileDiff = dynamic(
  () => import("@pierre/diffs/react").then((m) => m.MultiFileDiff),
  { ssr: false },
);
const DiffPoolProvider = dynamic(
  () => import("@pierre/diffs/react").then((m) => m.WorkerPoolContextProvider),
  { ssr: false },
);

// 高亮/diff 计算的 off-main-thread 通道：库只认 WorkerPoolContext 里的
// manager（disableWorkerPool 与否都不改变"无 provider 即主线程渲染"的事
// 实，大文件展开会长时间阻塞主线程）。
// 入口必须用 worker-portable.js（rolldown 已把 shiki/diff/@pierre/theming
// 全部内联，零裸说明符）：Turbopack 对 new URL(..., import.meta.url) 只做
// 静态资源拷贝、不打包 ESM 依赖，非 portable 的 worker.js 裸 import 在
// 浏览器里解析失败 → workersFailed → 静默回退主线程。portable 里仅剩的
// wasm 动态 import 只在 preferredHighlighter==="shiki-wasm" 时触发，
// 默认 shiki-js（纯 JS 正则引擎）不会走到。
// 池内部自带 LRU 结果缓存，主题/语言经 set-render-options 广播，
// 全部 diff 实例共享单例池；worker 加载失败自动回退主线程渲染，不白屏。
const diffWorkerFactory = (): Worker =>
  new Worker(
    new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url),
    { type: "module" },
  );

const DiffPool: FC<{ children: ReactNode }> = ({ children }) => (
  <DiffPoolProvider
    poolOptions={{ workerFactory: diffWorkerFactory, poolSize: 4 }}
    highlighterOptions={{}}
  >
    {children}
  </DiffPoolProvider>
);

/** dynamic() 泛型组件把 options 具化为默认实例，直接取组件 props 上的类型最稳 */
type PanelDiffOptions = NonNullable<
  ComponentProps<typeof PatchDiff>["options"]
>;

function useDiffOptions(
  loadFiles?: FileDiffContentsLoader,
  /** 强制换行：窄预览框专用，见 PanelFileDiff.wrap 的注释 */
  forceWrap?: boolean,
  /** 传了才开 library 的 gutter utility（行悬停 + / 拖动多行） */
  onGutterUtilityClick?: (range: SelectedLineRange) => void,
  /** 传了才开行拖选：批量选中后点加号评论整个范围 */
  onLineSelectionEnd?: (range: SelectedLineRange | null) => void,
  /** 多文件 patch（如 PR diff）需要文件头，默认关闭以贴合面板单文件视图 */
  fileHeaders?: boolean,
) {
  const prefs = useUiPrefs();
  const dark = useHtmlDark();
  const pair = DIFF_SHIKI_THEME[resolveCodeThemeName(prefs, dark)];
  const options = useMemo<PanelDiffOptions>(
    () => ({
      theme: { light: pair.light, dark: pair.dark },
      themeType: dark ? "dark" : "light",
      diffStyle: "unified",
      disableFileHeader: !fileHeaders,
      disableLineNumbers: !prefs.codeLineNumbers,
      overflow: forceWrap || prefs.codeWrap ? "wrap" : "scroll",
      // token 颜色走类名 + 一份共享样式表，而不是每个 span 内联 style：
      // 大 diff 展开时的样式重算量级下降（观感不变）。
      useCSSClasses: true,
      // patch 只带 3 行上下文，"N unmodified lines" 分隔条点击展开时
      // 由调用方的 loader 拉取文件全文做水合（省略 = 分隔条不可展开）。
      loadDiffFiles: loadFiles,
      // 评论入口：库自带 gutter utility 的「+」与拖动范围选择；
      // 不传回调时保持只读 diff。
      ...(onGutterUtilityClick
        ? {
            enableGutterUtility: true,
            lineHoverHighlight: "both" as const,
            onGutterUtilityClick,
            // 代码区拖选整行范围：批量选中后点 + 评论整个范围
            ...(onLineSelectionEnd
              ? {
                  enableLineSelection: true,
                  onLineSelectionEnd,
                }
              : {}),
            // 默认 utility 是库的蓝色；跟随应用 primary，与 CodeMirror 的 + 一致
            unsafeCSS:
              "[data-utility-button]{background-color:var(--primary);color:var(--primary-foreground);}",
          }
        : {}),
    }),
    [
      pair.light,
      pair.dark,
      dark,
      prefs.codeLineNumbers,
      prefs.codeWrap,
      forceWrap,
      fileHeaders,
      loadFiles,
      onGutterUtilityClick,
      onLineSelectionEnd,
    ],
  );
  // 背景覆写为透明：diff 融进面板卡片（hernessX 是覆写成纯黑，同理）。
  // 字号取「外观 → 代码设置」，字体跟随项目 mono 栈。
  const style = useMemo(
    () =>
      ({
        "--diffs-font-size": `${prefs.codeFontSize + 2}px`,
        "--diffs-font-family": "var(--font-mono)",
        // 容器内外边距：默认 gap 是 8px 四边，展开后与行头/下一条之间
        // 会多出明显的空带。纵向归零（紧贴吸顶行头），横向对齐行头的 12px。
        "--diffs-gap-block": "0px",
        "--diffs-gap-inline": "12px",
        "--diffs-bg": "transparent",
        "--diffs-bg-buffer-override": "transparent",
        "--diffs-bg-context-override": "transparent",
        "--diffs-bg-hover-override": dark
          ? "rgba(255,255,255,0.05)"
          : "rgba(0,0,0,0.04)",
        "--diffs-bg-separator-override": "transparent",
      }) as CSSProperties,
    [prefs.codeFontSize, dark],
  );
  // themeType 变化时整树重建（同 hernessX：组件缓存了主题态）
  const renderKey = `${options.themeType}`;
  return { options, style, renderKey };
}

export type DiffCommentAction = {
  /** 返回 false = 输入框不可用，浮层保持打开 */
  onSubmit: (
    range: CodeCommentRange,
    comment: string,
    selectedText: string,
  ) => boolean;
};

/** 从 unified patch 文本渲染（审查标签：git show/diff 的产物）。
 * 全高渲染、无内部滚动：diff 随面板整体滚动，文件行头由调用方吸顶。
 * 传 loadFiles 后，未改动行分隔条可点击展开到全文（调用方负责取数）。
 * 传 commentAction 后启用行悬停 + / 拖动多行评论（库自带 gutter utility）。 */
export const PanelPatchDiff: FC<{
  patch: string;
  className?: string;
  loadFiles?: FileDiffContentsLoader;
  commentAction?: DiffCommentAction;
  /** 评论浮层标题里的文件展示名（通常 basename） */
  fileLabel?: string;
  /** 评论归属的 workspace 相对路径（回显待发送评论卡片） */
  commentPath?: string;
  /** 多文件 patch（PR diff）显示文件头；面板单文件继续隐藏 */
  fileHeaders?: boolean;
}> = ({ patch, className, loadFiles, commentAction, fileLabel, commentPath, fileHeaders }) => {
  const commentEnabled = Boolean(commentAction);
  const comments = useCodeComments(commentPath);
  const [draft, setDraft] = useState<CodeCommentRange | null>(null);
  /**
   * 受控选区：库在点击加号后会把选中行留在内部、加号继续挂在旧行上，
   * 下一条评论就会重复落到同一范围。评论模式下把选区透传给库，提交/取消
   * 时置 null 清掉，加号才会重新跟随 hover 行。
   */
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  // 回调经 ref 取最新：options 的交互回调要保持稳定，避免每次渲染重配 diff
  const actionRef = useRef(commentAction);
  actionRef.current = commentAction;

  const handleGutterUtilityClick = useCallback((range: SelectedLineRange) => {
    if (!actionRef.current) return;
    setSelection(range);
    setDraft(normalizeDiffLineSelection(range));
  }, []);

  // 代码区拖选整行：只记住选区，等用户点 + 再评论；不自动弹编辑框
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!actionRef.current) return;
      setSelection(range);
    },
    [],
  );

  const closeDraft = useCallback(() => {
    setDraft(null);
    setSelection(null);
  }, []);

  // diff 内容刷新后行号可能整体变化：已打开的评论草稿/选区立刻作废，
  // 避免把评论落到旧行号上。
  useEffect(() => {
    closeDraft();
  }, [patch, closeDraft]);

  const { options, style, renderKey } = useDiffOptions(
    loadFiles,
    undefined,
    commentEnabled ? handleGutterUtilityClick : undefined,
    commentEnabled ? handleLineSelectionEnd : undefined,
    fileHeaders,
  );

  const handleDeleteComment = useCallback((id: string) => {
    removeCodeComment(id);
    removeDirectiveFromComposer(`comment:${id}`);
  }, []);

  type DiffAnnotationMeta =
    | { kind: "draft" }
    | { kind: "card"; entry: CodeCommentEntry };

  // 内联编辑器/已提交卡片都挂在目标行下；side 决定挂在新侧还是旧侧
  const draftAnnotations = useMemo<DiffLineAnnotation<DiffAnnotationMeta>[]>(
    () => {
      const annotations: DiffLineAnnotation<DiffAnnotationMeta>[] = comments.map(
        (entry) => ({
          side: entry.deleted ? "deletions" : "additions",
          lineNumber: entry.endLine,
          metadata: { kind: "card", entry },
        }),
      );
      if (draft) {
        annotations.push({
          side: draft.deleted ? "deletions" : "additions",
          lineNumber: draft.endLine,
          metadata: { kind: "draft" },
        });
      }
      return annotations;
    },
    [comments, draft],
  );

  return (
    <DiffPool>
      <PatchDiff
        key={renderKey}
        patch={patch}
        options={options}
        style={style}
        // 只在评论模式接管选区；没有评论能力时保持库的非受控行为
        selectedLines={commentEnabled ? selection : undefined}
        lineAnnotations={draftAnnotations}
        renderAnnotation={(annotation) => {
          // PatchDiff 的 renderAnnotation 未随 lineAnnotations 一起泛型推断，
          // metadata 在这里按本地注解类型收窄
          const metadata = annotation.metadata as DiffAnnotationMeta;
          if (metadata.kind === "card") {
            return (
              <CodeCommentCard
                entry={metadata.entry}
                onDelete={handleDeleteComment}
              />
            );
          }
          return draft ? (
            <div className="code-comment-draft-surface">
              <InlineCodeCommentEditor
                key={`${draft.startLine}:${draft.endLine}`}
                pathLabel={fileLabel}
                startLine={draft.startLine}
                endLine={draft.endLine}
                deleted={draft.deleted}
                onSubmit={(comment) => {
                  const ok =
                    actionRef.current?.onSubmit(
                      {
                        startLine: draft.startLine,
                        endLine: draft.endLine,
                        ...(draft.deleted ? { deleted: true } : {}),
                      },
                      comment,
                      extractPatchLineRange(
                        patch,
                        draft.deleted ? "deletions" : "additions",
                        draft.startLine,
                        draft.endLine,
                      ),
                    ) ?? false;
                  if (ok) closeDraft();
                  return ok;
                }}
                onCancel={closeDraft}
              />
            </div>
          ) : null;
        }}
        className={cn("pierre-diff-host", className)}
      />
    </DiffPool>
  );
};

/** 从新旧全文渲染（活动标签：edit/write 工具的入参对）。
 *  wrap：强制长行换行，无视全局 codeWrap 设置。消息流里的展开框是窄预览
 *  （限高滚动），scroll 模式下长行会横向溢出，而行号列是 sticky 的、底色
 *  取 --diffs-bg——我们把它覆成了 transparent（diff 融卡片），横向滚一点
 *  文本就从行号底下穿出来，观感即"行号和文字重叠"。wrap 模式没有横向
 *  溢出、行号列也不 sticky，从源头消掉；面板全高视图仍跟随用户设置。 */
export const PanelFileDiff: FC<{
  name: string;
  oldText: string | null;
  newText: string;
  className?: string;
  wrap?: boolean;
}> = ({ name, oldText, newText, className, wrap }) => {
  const { options, style, renderKey } = useDiffOptions(undefined, wrap);
  return (
    <DiffPool>
      <MultiFileDiff
        key={renderKey}
        oldFile={{ name, contents: oldText ?? "" }}
        newFile={{ name, contents: newText }}
        options={options}
        style={style}
        className={cn("pierre-diff-host", className)}
      />
    </DiffPool>
  );
};
