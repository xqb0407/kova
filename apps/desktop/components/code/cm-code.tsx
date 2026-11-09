"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { MessageSquarePlus } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  codeThemeExtension,
  languageForPath,
  resolveCodeThemeName,
} from "@/lib/markdown/code-theme";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { useUiPrefsSelector } from "@/lib/settings/ui-prefs";
import "@/app/styles/codemirror.css";

/**
 * CodeMirror 代码视图（默认只读，可选编辑）：面板 diff 已迁到
 * @pierre/diffs（panel-diff.tsx），只读态给设置页代码预览与「我的文件」
 * 预览用；编辑态给面板「文件」标签的磁盘模式就地改存（editable + onChange）。
 * 主题/行号/换行/字号同样取自「外观 → 代码设置」。
 */

/**
 * 代码设置（外观 → 代码设置）→ CodeMirror 渲染参数。
 * forceDark 供设置页"浅色/深色预览"双卡片强制指定配色，不跟随界面。
 */
function useCodeSettings(forceDark?: boolean) {
  // 逐字段订阅：外观页拖动滑杆（对话宽度/对比度等）时，CodeMirror 不跟着重渲染
  const htmlDark = useHtmlDark();
  const dark = forceDark ?? htmlDark;
  const codeThemeLight = useUiPrefsSelector((p) => p.codeThemeLight);
  const codeThemeDark = useUiPrefsSelector((p) => p.codeThemeDark);
  const codeLineNumbers = useUiPrefsSelector((p) => p.codeLineNumbers);
  const codeWrap = useUiPrefsSelector((p) => p.codeWrap);
  const codeFontSize = useUiPrefsSelector((p) => p.codeFontSize);
  const themeName = resolveCodeThemeName({ codeThemeLight, codeThemeDark }, dark);
  // memo：选区状态变化会触发本组件重渲染，返回值每次新对象会连带
  // Shell/CodeMirror 逐次重渲染（basicSetup 等 props 变了还会重配置编辑器）
  return useMemo(
    () => ({
      dark,
      themeName,
      lineNumbers: codeLineNumbers,
      wrap: codeWrap,
      fontSize: codeFontSize,
    }),
    [dark, themeName, codeLineNumbers, codeWrap, codeFontSize],
  );
}

/** 语言扩展按文件名懒加载（未命中=纯文本） */
function useLanguage(path?: string): Extension[] {
  const [lang, setLang] = useState<Extension[]>([]);
  useEffect(() => {
    if (!path) {
      setLang([]);
      return;
    }
    let alive = true;
    void languageForPath(path).then((exts) => {
      if (alive) setLang(exts);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return lang;
}

const BASIC_SETUP = (lineNumbers: boolean, editable: boolean) => ({
  lineNumbers,
  foldGutter: false,
  // 编辑态给当前行高亮（光标定位感），只读态保持极简
  highlightActiveLine: editable,
  highlightActiveLineGutter: editable,
  autocompletion: false,
  bracketMatching: false,
  closeBrackets: false,
  highlightSelectionMatches: false,
  searchKeymap: false,
});

/** 长行自动换行：lineWrapping + 词内断行（窄面板里 base64 等长 token 也不溢出） */
const WRAP_EXTENSION = [
  EditorView.lineWrapping,
  EditorView.theme({ "& .cm-content": { overflowWrap: "anywhere" } }),
];

function Shell({
  value,
  extensions,
  settings,
  className,
  height,
  editable,
  onChange,
  onCreateView,
}: {
  value: string;
  extensions: Extension[];
  settings: ReturnType<typeof useCodeSettings>;
  className?: string;
  /** 容器定高（如 "72vh"）：编辑器内部滚动（行号 sticky 跟随）；不传自适应内容高 */
  height?: string;
  editable: boolean;
  onChange?: (value: string) => void;
  /** 编辑器实例就绪回调（选区动作要用 posAtDOM 把原生选区映射回文档位置） */
  onCreateView?: (view: EditorView) => void;
}) {
  // basicSetup 每次新对象会让 @uiw/react-codemirror 重配置编辑器；memo 掉
  const basicSetup = useMemo(
    () => BASIC_SETUP(settings.lineNumbers, editable),
    [settings.lineNumbers, editable],
  );
  return (
    <div
      className={cn("aui-cm-code overflow-hidden", className)}
      style={{ "--cm-font-size": `${settings.fontSize + 2}px` } as CSSProperties}
    >
      <CodeMirror
        // h-full：外层 .aui-cm-code 定高（h-full + height="100%"）时中间这层
        // 也要定高，.cm-editor 的 100% 才有百分比基准；外层高度自适应时
        // 100% 等价 auto，无副作用
        className="h-full"
        value={value}
        editable={editable}
        readOnly={!editable}
        onChange={onChange}
        onCreateEditor={onCreateView}
        theme="none"
        height={height}
        basicSetup={basicSetup}
        extensions={extensions}
      />
    </div>
  );
}

/**
 * 代码视图（带语法高亮，语言按文件名懒加载）：默认只读——设置页代码预览、
 * 「我的文件」文件预览用；传 editable + onChange 即就地编辑（面板「文件」
 * 标签磁盘模式），受控 value 由调用方持有草稿。
 */
/** 当前选区（视口坐标 + 行范围） */
type SelectionState = {
  x: number;
  y: number;
  startLine: number;
  endLine: number;
};

/** 选区动作（文件视图「引用到对话」）：选中行后浮出按钮，点击拿行范围 */
export type CodeSelectionAction = {
  label: string;
  onSelect: (range: { startLine: number; endLine: number }) => void;
};

/** 选区浮层按钮相对选区顶部的偏移（按钮高 28 + 间隙 6） */
const SELECTION_ACTION_OFFSET = 34;

export const CodeMirrorCode: FC<{
  value: string;
  path: string;
  className?: string;
  forceDark?: boolean;
  height?: string;
  editable?: boolean;
  onChange?: (value: string) => void;
  /** 传了才启用选区浮层（默认只读态选代码 → 引用到对话） */
  selectionAction?: CodeSelectionAction;
  /** 去掉主题实色底（编辑器+行号槽），透出所在容器背景（右侧面板文件视图用） */
  transparentBg?: boolean;
  /** 变化时滚动到该行并居中（引用芯片「跳到行」用；undefined = 不动） */
  scrollToLine?: number;
  /** 同一行重复点击也要重新滚动：每次引用点击换一个数 */
  scrollNonce?: number;
}> = ({
  value,
  path,
  className,
  forceDark,
  height,
  editable,
  onChange,
  selectionAction,
  transparentBg,
  scrollToLine,
  scrollNonce,
}) => {
  const settings = useCodeSettings(forceDark);
  const lang = useLanguage(path);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  // 动作经 ref 取最新：监听只装一次，不因回调换新而重装
  const actionRef = useRef(selectionAction);
  actionRef.current = selectionAction;
  const viewRef = useRef<EditorView | null>(null);

  /** 滚到行号并居中（越界夹取）；view 还没建好时调用方负责稍后再试 */
  const scrollViewToLine = useCallback(
    (view: EditorView, lineNumber: number): void => {
      if (!Number.isFinite(lineNumber) || lineNumber < 1) return;
      const line = view.state.doc.line(
        Math.min(Math.max(1, Math.trunc(lineNumber)), view.state.doc.lines),
      );
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
    },
    [],
  );

  /**
   * 从**原生 DOM 选区**读选区与行号（不依赖 CodeMirror 的 state.selection）。
   *
   * 只读态（默认只读文件预览）下 CM 的 state.selection 不保证跟原生选区同步，
   * 而用户拖选是真实存在的——用 window.getSelection + view.posAtDOM 映射回
   * 文档位置最稳，两种模式（只读/可编辑）同一条路径。
   */
  const readNativeSelection = (view: EditorView) => {
    const native = window.getSelection?.();
    if (!native || native.rangeCount === 0 || native.isCollapsed) return null;
    const range = native.getRangeAt(0);
    const content = view.contentDOM;
    if (
      !content.contains(range.startContainer) ||
      !content.contains(range.endContainer)
    ) {
      return null;
    }
    let from: number;
    let to: number;
    try {
      from = view.posAtDOM(range.startContainer, range.startOffset);
      to = view.posAtDOM(range.endContainer, range.endOffset);
    } catch {
      return null;
    }
    if (from > to) [from, to] = [to, from];
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return {
      x: rect.left,
      y: rect.top,
      startLine: view.state.doc.lineAt(from).number,
      endLine: view.state.doc.lineAt(to).number,
    };
  };

  /** 上一次发布的选区：用来跳过"没变化"的同步。
   *  document 级 selectionchange 会在**任何**编辑器里光标移动时触发（包括
   *  composer 逐键打字）；函数式 setState 无法被 React 提前跳过，会让本组件
   *  （连同文件视图）逐键走一遍渲染，表现为"输入框发卡"。这里先比 ref，
   *  真变了才用**直接值** setState（等值时 React 走 eager bailout，零渲染）。 */
  const lastSelectionRef = useRef<SelectionState | null>(null);
  const syncSelection = () => {
    const view = viewRef.current;
    const next = view && actionRef.current ? readNativeSelection(view) : null;
    const prev = lastSelectionRef.current;
    if (
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.startLine === next.startLine &&
        prev.endLine === next.endLine)
    ) {
      return;
    }
    lastSelectionRef.current = next;
    setSelection(next);
  };

  /** syncSelection 每渲染换新（读最新 actionRef）；监听里经 ref 取 */
  const syncSelectionRef = useRef(syncSelection);
  syncSelectionRef.current = syncSelection;

  const selectionExtension = useMemo(
    () =>
      EditorView.domEventHandlers({
        // 拖选（mouseup）/ 键盘扩选（shift+方向键、⌘A）后同步一次
        mouseup: (_event, view) => {
          viewRef.current = view;
          syncSelectionRef.current();
          return false;
        },
        keyup: (_event, view) => {
          viewRef.current = view;
          syncSelectionRef.current();
          return false;
        },
      }),
    [],
  );

  // 选区在编辑器之外变化（含清空选区、点别处）也要跟着收/放；
  // document 级 selectionchange 是唯一能覆盖全部来源的事件
  const hasSelectionAction = Boolean(selectionAction);
  // 行级跳转（引用芯片「跳到行」）：scrollToLine 变化时滚到该行居中。
  // 放在 viewRef 赋值的 onCreateEditor 之后注册的 effect 里也能拿到 view。
  useEffect(() => {
    const view = viewRef.current;
    if (!view || scrollToLine == null || scrollToLine < 1) return;
    scrollViewToLine(view, scrollToLine);
  }, [scrollToLine, scrollNonce, scrollViewToLine]);
  useEffect(() => {
    if (!hasSelectionAction) return;
    const onSelectionChange = () => syncSelectionRef.current();
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [hasSelectionAction]);

  // 滚动/窗口变化会把选区移出按钮下方，直接收起而不是追着跑；Esc 同
  useEffect(() => {
    if (!selection) return;
    const hide = () => setSelection(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [selection]);

  const extensions = useMemo(
    () => [
      ...(settings.wrap ? WRAP_EXTENSION : []),
      ...lang,
      codeThemeExtension(settings.themeName, settings.dark),
      selectionExtension,
    ],
    [settings.wrap, settings.themeName, settings.dark, lang, selectionExtension],
  );
  return (
    <>
      <Shell
        value={value}
        extensions={extensions}
        settings={settings}
        className={cn(className, transparentBg && "cm-code-transparent")}
        height={height}
        editable={editable ?? false}
        onChange={onChange}
        onCreateView={(view) => {
          viewRef.current = view;
          // 首次挂载：effect 可能早于 view 创建，这里补一次初始行定位
          if (scrollToLine != null) scrollViewToLine(view, scrollToLine);
        }}
      />
      {/* portal 到 body：面板里若有动画残留的 transform，position:fixed 的基准
          会变成那个祖先，浮层会飘位；body 下才与 viewport 坐标（选区 rect）一致 */}
      {selection && selectionAction
        ? createPortal(
            <button
          type="button"
          data-slot="cm-code-selection-action"
          // 别让点击把编辑器选区清掉：先拿行号再退场
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            selectionAction.onSelect({
              startLine: selection.startLine,
              endLine: selection.endLine,
            });
            // 引用已带走：清掉原生选区与按钮（ref 一并清——否则"重新选回
            // 同一段"会被判成"没变化"，按钮不再浮出）
            window.getSelection?.()?.removeAllRanges();
            lastSelectionRef.current = null;
            setSelection(null);
          }}
          className="bg-popover text-popover-foreground fixed z-40 flex h-7 items-center gap-1.5 rounded-lg border px-2 text-xs whitespace-nowrap shadow-md transition-colors hover:bg-accent"
          style={{
            left: selection.x,
            top: Math.max(8, selection.y - SELECTION_ACTION_OFFSET),
          }}
        >
              <MessageSquarePlus className="size-3.5" />
              {selectionAction.label}
            </button>,
            document.body,
          )
        : null}
    </>
  );
};
