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
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
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
import { useT } from "@/lib/i18n";
import {
  codeCommentGutter,
  type CodeCommentGutterRequest,
} from "./cm-comment-gutter";
import { CodeCommentEditor } from "./code-comment-editor";
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

/* --------------------------- 查找高亮（Ctrl+F 后端） --------------------------- */

/** 普通命中/当前命中的 decoration class（样式在 codemirror.css） */
const MATCH_MARK = Decoration.mark({ class: "cm-find-match" });
const CURRENT_MARK = Decoration.mark({
  class: "cm-find-match cm-find-match-current",
});

/** 单文档命中上限：查一个高频词不该把百万行日志全染色 */
const CM_FIND_MAX = 9999;

/**
 * 计算命中 decoration：regex 全文扫描（大小写不敏感、query 已转义），
 * 第 active 个命中用当前样式，其余普通样式。同时返回命中位置数组
 * （供滚动定位与编辑态重算索引）。
 */
function buildFindDeco(
  doc: Text,
  query: string,
  active: number,
): DecorationSet {
  if (!query) return Decoration.none;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(escaped, "gi");
  } catch {
    return Decoration.none;
  }
  const text = doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  let n = 0;
  for (let m = re.exec(text); m && n < CM_FIND_MAX; m = re.exec(text)) {
    const from = m.index;
    const to = from + m[0].length;
    if (to === from) break; // 空匹配防御（理论不可达：query 非空）
    builder.add(from, to, n === active ? CURRENT_MARK : MATCH_MARK);
    n += 1;
  }
  return builder.finish();
}

/**
 * Ctrl+F 查找高亮（外部驱动式）：不引 @codemirror/search——它自带的面板
 * UI 与查找条重复，且 basicSetup 已把 searchKeymap 关掉。宿主组件持有
 * query/active，经 props 进来后 dispatch effect 重建 DecorationSet。
 * 命中位置由宿主在 dispatch 前用同一扫描函数自查（update 里无法回传）。
 */
const setFindEffect = StateEffect.define<{ query: string; active: number }>();

const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindEffect)) {
        return buildFindDeco(tr.state.doc, e.value.query, e.value.active);
      }
    }
    // 映射到新文档位置（编辑态打字后旧高亮平移，宿主随后会重算）
    return deco.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 只算命中位置（宿主驱动与 updateListener 共用；与 buildFindDeco 同口径） */
function scanFindPositions(doc: Text, query: string): number[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(escaped, "gi");
  } catch {
    return [];
  }
  const text = doc.toString();
  const positions: number[] = [];
  for (let m = re.exec(text); m && positions.length < CM_FIND_MAX; m = re.exec(text)) {
    if (m[0].length === 0) break;
    positions.push(m.index);
  }
  return positions;
}
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

/** 查找驱动：query 打开查找，nav 变化跳到下一个/上一个（nonce 重复触发也生效） */
export type CodeMirrorReplace = {
  /** one = 替换当前命中并跳到下一处；all = 全部替换 */
  mode: "one" | "all";
  /** 替换为的文本（空串 = 删除命中） */
  value: string;
  /** 执行信号：nonce 变化即执行一次（同值重放不执行） */
  nonce: number;
};

/** 查找驱动：query 打开查找，nav 变化跳到下一个/上一个（nonce 重复触发也生效） */
export type CodeMirrorFind = {
  query: string;
  /** 0-based；宿主维护，-1 = 还没跳过（首条由这里定位） */
  active: number;
  /** 跳转方向；nonce 同方向重复点击也要生效 */
  nav?: { dir: 1 | -1; nonce: number };
  /** 替换驱动（可编辑的源码态才由宿主下发；nonce 变化执行一次） */
  replace?: CodeMirrorReplace;
  /** 命中上报：count（null = 无查询）；active = 实际生效的当前下标（宿主
   *  以此同步计数条——cm 端是跳转的权威，宿主不乐观推进，避免双重跳） */
  onHits?: (count: number | null, active?: number) => void;
};

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

/** 代码行评论（悬停 + / 拖动多行）：返回 false = 插入失败，浮层保持打开 */
export type CodeCommentAction = {
  onSubmit: (
    range: { startLine: number; endLine: number },
    comment: string,
  ) => boolean;
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
  /** 传了才启用行号槽评论 +（悬停单行 / 按住拖选多行） */
  commentAction?: CodeCommentAction;
  /** 去掉主题实色底（编辑器+行号槽），透出所在容器背景（右侧面板文件视图用） */
  transparentBg?: boolean;
  /** 变化时滚动到该行并居中（引用芯片「跳到行」用；undefined = 不动） */
  scrollToLine?: number;
  /** 同一行重复点击也要重新滚动：每次引用点击换一个数 */
  scrollNonce?: number;
  /** Ctrl+F 查找驱动（文件视图查找条用；不传 = 无查找高亮） */
  find?: CodeMirrorFind;
}> = ({
  value,
  path,
  className,
  forceDark,
  height,
  editable,
  onChange,
  selectionAction,
  commentAction,
  transparentBg,
  scrollToLine,
  scrollNonce,
  find,
}) => {
  const settings = useCodeSettings(forceDark);
  const lang = useLanguage(path);
  const t = useT();
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [commentDraft, setCommentDraft] =
    useState<CodeCommentGutterRequest | null>(null);
  const commentEnabled = Boolean(commentAction);
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

  // 编辑态打字（docChanged）：query 还开着就重扫一遍——命中数/位置都会变。
  // decoration 经 findField.update 的 deco.map 平移兜底；这里只更新计数与
  // 夹取后的当前下标，**不滚动**（打字时把视口拽到命中处会打断输入）。
  const findUpdateExtension = useMemo(
    () =>
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const f = findRef.current;
        if (!f || f.query === "") return;
        const positions = scanFindPositions(u.state.doc, f.query);
        findPositionsRef.current = positions;
        const clamped =
          positions.length === 0
            ? -1
            : Math.min(Math.max(lastActiveRef.current, 0), positions.length - 1);
        lastActiveRef.current = clamped;
        f.onHits?.(positions.length, clamped);
      }),
    [],
  );

  // 评论入口按能力开关：没有 commentAction 的调用方（设置页预览、资料库
  // 查看器等）不挂 gutter，编辑器视觉/交互与之前完全一致。
  const commentGutterExtension = useMemo(
    () =>
      commentEnabled
        ? codeCommentGutter({
            label: t("chat.codeComment.add"),
            onRequest: setCommentDraft,
          })
        : [],
    [commentEnabled, t],
  );

  const extensions = useMemo(
    () => [
      ...(settings.wrap ? WRAP_EXTENSION : []),
      ...lang,
      codeThemeExtension(settings.themeName, settings.dark),
      selectionExtension,
      findField,
      findUpdateExtension,
      commentGutterExtension,
    ],
    [
      settings.wrap,
      settings.themeName,
      settings.dark,
      lang,
      selectionExtension,
      findUpdateExtension,
      commentGutterExtension,
    ],
  );

  /* ------------------------- 查找驱动（props → effects） ------------------------- */

  // onHits 经 ref 取最新：effect 不因回调换新而重跑
  const findRef = useRef(find);
  findRef.current = find;
  /** 最近一次扫描的命中位置：编辑态打字（docChanged）后重算当前索引要用 */
  const findPositionsRef = useRef<number[]>([]);
  /** 上次下发的 {query, active}：相等就不再 dispatch（打字高频路径） */
  const lastAppliedRef = useRef<{ query: string; active: number } | null>(null);
  /** 上次执行的导航 nonce：单调递增（宿主只 +1，不回拨）——首帧若把初始值
   *  误判成"待执行导航"，count 为空会空转吞掉本次查询，所以两侧都用 0 起步 */
  const lastNavNonceRef = useRef<number>(0);
  /** 上一次导航后的下标（cm 端权威）：updateListener 上报夹取值用 */
  const lastActiveRef = useRef(-1);
  /** 上一次生效的查询：区分"查询变了要落首条"与"重渲染/打字触发的同参重放"，
   *  后者绝不能滚动（否则编辑态每敲一键都被拽到命中处） */
  const lastQueryRef = useRef<string | null>(null);
  /** 上一次执行的替换 nonce：单调递增（宿主只 +1，不回拨） */
  const lastReplaceNonceRef = useRef<number>(0);

  /** 扫描命中（与 findField.update 同一函数）+ 下发 + 滚到当前命中 */
  const applyFind = useCallback(
    (view: EditorView, query: string, active: number, scrollTo: boolean) => {
      const last = lastAppliedRef.current;
      if (last && last.query === query && last.active === active) {
        // 同参重放（如关闭后再开同一查询）：不重扫，但滚动意图要满足
        if (scrollTo) {
          const positions = findPositionsRef.current;
          if (positions.length > 0) {
            const idx = Math.min(Math.max(active, 0), positions.length - 1);
            view.dispatch({
              effects: EditorView.scrollIntoView(positions[idx]!, {
                y: "center",
              }),
            });
          }
        }
        return;
      }
      lastAppliedRef.current = { query, active };
      const positions = scanFindPositions(view.state.doc, query);
      findPositionsRef.current = positions;
      view.dispatch({
        effects: setFindEffect.of({ query, active }),
      });
      findRef.current?.onHits?.(query ? positions.length : null, positions.length ? active : -1);
      if (scrollTo && positions.length > 0) {
        const idx = Math.min(Math.max(active, 0), positions.length - 1);
        view.dispatch({
          effects: EditorView.scrollIntoView(positions[idx]!, {
            y: "center",
          }),
        });
      }
    },
    [],
  );

  // query/active 变化 → 重算高亮；nav.nonce 变化 → 跳下一条/上一条。
  // 跳转下标在这里取模后经 onHits 回报（cm 端是跳转权威，宿主不乐观推进）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const f = findRef.current;
    // 查找关闭（find=undefined）：清掉残留高亮。lastApplied 非空说明确实
    // 高亮过（避免从未用查找的调用方在挂载时多打一次空 dispatch）
    if (!f) {
      if (lastAppliedRef.current) {
        lastActiveRef.current = -1;
        lastQueryRef.current = "";
        applyFind(view, "", -1, false);
      }
      return;
    }
    // 清词：清高亮并重置基线（nonce 不回拨——宿主侧单调递增，回拨会
    // 把"下一条查询的首帧"误判成待执行导航）
    if (f.query === "") {
      lastActiveRef.current = -1;
      lastQueryRef.current = "";
      applyFind(view, "", -1, false);
      return;
    }
    if (f.nav && f.nav.nonce !== lastNavNonceRef.current) {
      lastNavNonceRef.current = f.nav.nonce;
      const count = findPositionsRef.current.length;
      if (count === 0) return;
      // 宿主 active=-1（还没跳过）时：下一个落 0、上一个落最后一条
      const base = f.active < 0 ? (f.nav.dir === 1 ? -1 : 0) : f.active;
      const next = (base + f.nav.dir + count) % count;
      lastActiveRef.current = next;
      applyFind(view, f.query, next, true);
      f.onHits?.(count, next);
      return;
    }
    // 非导航：查询真变了才滚动落首条；同参重放（重渲染/打字）不拽视口
    const queryChanged = lastQueryRef.current !== f.query;
    lastQueryRef.current = f.query;
    applyFind(view, f.query, Math.max(f.active, 0), queryChanged);
  }, [find, applyFind]);

  // 替换驱动（props → effects）：replace.nonce 变化执行一次。
  // - all：命中位取自**原文档**（scanFindPositions，升序互不重叠），一次
  //   dispatch 批量替换——ChangeSet.of 对数组按原文档坐标处理，没有逐条
  //   替换的偏移错位，且整次替换是一个撤销步骤。
  // - one：替换当前命中后跳到下一处（替换点之后的第一条；value 自带 query
  //   时跳过替换词内部，没有则绕回全文第一条，全部替换完则清空当前态）。
  // 替换引发的 docChanged 走 updateListener 重扫计数；这里同步装饰与滚动，
  // 并经 onHits 把新下标/计数回给宿主（cm 端仍是跳转权威）。只读快照由
  // 宿主 canReplace 门控，不会收到 replace 信号。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const f = findRef.current;
    if (!f?.replace) return;
    if (f.replace.nonce === lastReplaceNonceRef.current) return;
    lastReplaceNonceRef.current = f.replace.nonce;
    const query = f.query;
    const value = f.replace.value;
    if (!query) return;

    if (f.replace.mode === "all") {
      const positions = scanFindPositions(view.state.doc, query);
      if (positions.length === 0) return;
      view.dispatch({
        changes: positions.map((from) => ({
          from,
          to: from + query.length,
          insert: value,
        })),
      });
      // 替换后主动重扫并重设装饰/当前下标：不依赖 updateListener 的回报与
      // deco.map 平移——替换词自带 query（如 a → aa）时，平移出的旧装饰覆盖
      // 不了新增命中，会出现"部分命中没有高亮"的半残态
      const nextPositions = scanFindPositions(view.state.doc, query);
      findPositionsRef.current = nextPositions;
      const landed =
        nextPositions.length > 0
          ? Math.min(Math.max(f.active, 0), nextPositions.length - 1)
          : -1;
      lastActiveRef.current = landed;
      lastAppliedRef.current = { query, active: landed };
      view.dispatch({ effects: setFindEffect.of({ query, active: landed }) });
      if (landed >= 0) {
        view.dispatch({
          effects: EditorView.scrollIntoView(nextPositions[landed]!, {
            y: "center",
          }),
        });
      }
      f.onHits?.(nextPositions.length, landed);
      return;
    }

    const positions = findPositionsRef.current;
    if (positions.length === 0) return;
    const idx = Math.min(Math.max(f.active, 0), positions.length - 1);
    const from = positions[idx]!;
    view.dispatch({
      changes: { from, to: from + query.length, insert: value },
    });
    const nextPositions = scanFindPositions(view.state.doc, query);
    findPositionsRef.current = nextPositions;
    const nextIdx = nextPositions.findIndex((p) => p >= from + value.length);
    const landed = nextIdx >= 0 ? nextIdx : nextPositions.length > 0 ? 0 : -1;
    lastActiveRef.current = landed;
    lastAppliedRef.current = { query, active: landed };
    view.dispatch({ effects: setFindEffect.of({ query, active: landed }) });
    if (landed >= 0) {
      view.dispatch({
        effects: EditorView.scrollIntoView(nextPositions[landed]!, {
          y: "center",
        }),
      });
    }
    f.onHits?.(nextPositions.length, landed);
  }, [find]);

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
      {commentDraft && commentAction ? (
        <CodeCommentEditor
          pathLabel={path.split(/[\\/]/).pop() || path}
          startLine={commentDraft.startLine}
          endLine={commentDraft.endLine}
          anchor={commentDraft.anchor}
          onSubmit={(comment) => {
            const ok = commentAction.onSubmit(
              {
                startLine: commentDraft.startLine,
                endLine: commentDraft.endLine,
              },
              comment,
            );
            if (ok) setCommentDraft(null);
            return ok;
          }}
          onCancel={() => setCommentDraft(null)}
        />
      ) : null}
    </>
  );
};
