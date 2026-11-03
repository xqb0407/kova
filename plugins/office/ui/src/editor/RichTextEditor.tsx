/**
 * 就地富文本编辑器（text 元素的编辑面）：contentEditable + runs 保真往返。
 *
 * 与旧 textarea 的差别：
 *   - 初始化按 runs 生成带样式 span，编辑中看到的就是真实段落样式；
 *   - 提交时按 DOM 有效样式重新切分 runs（局部加粗/变色不会再被一键抹平）；
 *   - 浮条（TextFormatBar）通过 ref 对"当前选区"套样式；折叠光标也能记住下一字的格式。
 *
 * 事件约定：点击编辑器/格式浮条以外的位置才收尾提交（pointerdown 捕获阶段），
 * 因此点浮条里的下拉/取色器不会把编辑关掉。Esc 取消、⌘/Ctrl+Enter 提交。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { TextEl, TextRun, TextVAlign } from "@/doc";
import { DEFAULT_TEXT_SIZE, textLayout, textLineHeight } from "@/viewspec";
import {
  applyStyleToSelection,
  readRuns,
  runsToHtml,
  styleAtNode,
  styleOfRun,
  type RunStyle,
} from "./richText";

export type RichTextEditorHandle = {
  /** 对当前选区套样式（折叠光标 = 下一字格式） */
  applyStyle: (patch: Partial<RunStyle>) => void;
  /** 当前光标处有效样式 */
  currentStyle: () => RunStyle;
  /** 立即收尾提交（浮条「完成」用；点外提交也走同一条路径） */
  commit: () => void;
};

export type RichTextView = { s: number; tx: number; ty: number };

const vAlignJustify: Record<TextVAlign, string> = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
};

export const RichTextEditor = forwardRef<
  RichTextEditorHandle,
  {
    el: TextEl;
    view: RichTextView;
    /** 容器画布偏移（root = {0,0}） */
    off: { x: number; y: number };
    onCommit: (runs: TextRun[]) => void;
    onCancel: () => void;
    /** 选区/样式变化（浮条点亮态）；rAF 节流 */
    onStyleChange?: (style: RunStyle) => void;
    /** 进入编辑时的鼠标位置（screen 坐标）：光标落到点击处（WPS 行为）；缺省落尾部 */
    caretAt?: { x: number; y: number };
  }
>(function RichTextEditor({ el, view, off, onCommit, onCancel, onStyleChange, caretAt }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  /** 挂载时的缩放即编辑期缩放（编辑中滚轮缩放被 stage 挡住），序列化按它反算字号 */
  const scaleRef = useRef(view.s);
  const baseRunRef = useRef<TextRun>(el.runs[0] ?? { text: "" });
  const doneRef = useRef(false);
  const savedRangeRef = useRef<Range | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onStyleChangeRef = useRef(onStyleChange);
  onStyleChangeRef.current = onStyleChange;
  const rafRef = useRef(0);

  const layout = textLayout(el);

  /** 保存/恢复编辑器内选区：点浮条里的下拉/取色器会把焦点带走，套样式前要先还原 */
  const rememberSelection = useCallback(() => {
    const root = editRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (root.contains(r.commonAncestorContainer)) savedRangeRef.current = r.cloneRange();
  }, []);

  const restoreSelection = useCallback(() => {
    const root = editRef.current;
    const sel = window.getSelection();
    if (!root || !sel) return;
    if (sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)) return;
    if (savedRangeRef.current && root.contains(savedRangeRef.current.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
    }
  }, []);

  const currentStyle = useCallback((): RunStyle => {
    const root = editRef.current;
    if (!root) return styleOfRun(baseRunRef.current);
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer)) {
      return styleAtNode(root, sel.getRangeAt(0).startContainer, scaleRef.current);
    }
    if (savedRangeRef.current && root.contains(savedRangeRef.current.startContainer)) {
      return styleAtNode(root, savedRangeRef.current.startContainer, scaleRef.current);
    }
    return styleAtNode(root, root, scaleRef.current);
  }, []);

  const commit = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const root = editRef.current;
    onCommitRef.current(root ? readRuns(root, scaleRef.current, baseRunRef.current) : []);
  }, []);

  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancelRef.current();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      applyStyle: (patch) => {
        const root = editRef.current;
        if (!root) return;
        const sel = window.getSelection();
        const inside = !!(sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).startContainer));
        if (!inside) {
          root.focus({ preventScroll: true });
          restoreSelection();
        }
        applyStyleToSelection(root, patch, scaleRef.current);
        rememberSelection();
        onStyleChangeRef.current?.(currentStyle());
      },
      currentStyle,
      commit,
    }),
    [commit, currentStyle, rememberSelection, restoreSelection],
  );

  /* 挂载：渲染 runs → HTML，聚焦并把光标落到鼠标点击处（WPS 行为）；无坐标则落尾部。
     不再全选——全选会让下一次输入直接覆盖整段，且光标位置与点击处不符。 */
  useEffect(() => {
    const root = editRef.current;
    if (!root) return;
    root.innerHTML = runsToHtml(el.runs, scaleRef.current);
    root.focus({ preventScroll: true });
    let range: Range | null = null;
    if (caretAt) {
      const d = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      if (d.caretRangeFromPoint) {
        range = d.caretRangeFromPoint(caretAt.x, caretAt.y);
      } else if (d.caretPositionFromPoint) {
        const p = d.caretPositionFromPoint(caretAt.x, caretAt.y);
        if (p) {
          range = document.createRange();
          range.setStart(p.offsetNode, p.offset);
          range.collapse(true);
        }
      }
      if (range && !root.contains(range.startContainer)) range = null;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    savedRangeRef.current = range.cloneRange();
    onStyleChangeRef.current?.(styleOfRun(el.runs[0] ?? { text: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 选区变化 → 浮条样式态（rAF 节流；焦点不在编辑器里时保留上次状态） */
  useEffect(() => {
    const onSelection = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const root = editRef.current;
        const sel = window.getSelection();
        if (!root || !sel || sel.rangeCount === 0) return;
        if (!root.contains(sel.getRangeAt(0).startContainer)) return;
        rememberSelection();
        onStyleChangeRef.current?.(currentStyle());
      });
    };
    document.addEventListener("selectionchange", onSelection);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [currentStyle, rememberSelection]);

  /* 点编辑器/浮条/浮层弹窗以外的位置 → 收尾提交 */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (wrapRef.current?.contains(t)) return;
      if (t.closest?.("[data-sc-formatbar]")) return;
      if (t.closest?.("[data-radix-popper-content-wrapper]")) return;
      commit();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [commit]);

  const insertPlainText = useCallback(
    (text: string) => {
      const root = editRef.current;
      const sel = window.getSelection();
      if (!root || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!root.contains(range.startContainer)) return;
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      const after = document.createRange();
      after.setStart(node, text.length);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      rememberSelection();
    },
    [rememberSelection],
  );

  /** 回车换行：优先走浏览器原生行内换行（<br>），光标与后续输入行为最稳；
   *  序列化把 <br> 还原成 \n（手插 \n 文本节点会被 Chrome 编辑引擎挪位）。 */
  const insertLineBreak = useCallback(() => {
    const root = editRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer)) return;
    if (document.execCommand("insertLineBreak")) {
      rememberSelection();
      return;
    }
    range.deleteContents();
    const br = document.createElement("br");
    range.insertNode(br);
    const after = document.createRange();
    after.setStartAfter(br);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    rememberSelection();
  }, [rememberSelection]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // 编辑面内部按键不冒泡给全局快捷键（导航/删除/nudge 都让位给文字输入）
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (mod && !e.shiftKey && (key === "b" || key === "i" || key === "u")) {
      e.preventDefault();
      const cur = currentStyle();
      const prop = key === "b" ? "bold" : key === "i" ? "italic" : "underline";
      const root = editRef.current;
      if (!root) return;
      applyStyleToSelection(root, { [prop]: !cur[prop] }, scaleRef.current);
      rememberSelection();
      onStyleChangeRef.current?.(currentStyle());
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      insertLineBreak();
      return;
    }
    // ⌘Z 交给 contentEditable 原生撤销（撤销范围只限本次编辑，不会动文档历史）
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
    if (!text) return;
    // 逐行插入：行间用原生 <br>（\n 文本节点在 Chrome 编辑引擎里光标行为不可靠）
    text.split("\n").forEach((line, i) => {
      if (i > 0) insertLineBreak();
      if (line) insertPlainText(line);
    });
  };

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const scale = view.s;
  const left = (off.x + el.x) * scale + view.tx;
  const top = (off.y + el.y) * scale + view.ty;

  return (
    <div
      ref={wrapRef}
      className="sc-rich-edit"
      style={{
        left,
        top,
        width: el.w * scale,
        height: el.h * scale,
        justifyContent: vAlignJustify[layout.vAlign],
        opacity: el.opacity ?? 1,
        transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
        transformOrigin: "center",
      }}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
    >
      <div
        ref={editRef}
        className="sc-rich-edit-inner"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-multiline
        style={{
          fontSize: (el.runs[0]?.size ?? DEFAULT_TEXT_SIZE) * scale,
          lineHeight: textLineHeight(el),
          textAlign: layout.align,
          color: el.runs[0]?.color ?? undefined,
          minHeight: 1,
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    </div>
  );
});
