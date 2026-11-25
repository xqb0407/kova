"use client";

/**
 * CodeMirror 行号槽评论入口：悬停行出现「+」，点击评论单行；按住 + 向下/
 * 向上拖动可选中多行，松开后把行范围交给宿主弹评论浮层。
 *
 * 实现要点：
 * - 有行号时把加号注册进 lineNumbers 的 marker facet，直接**替换该行行号**
 *   （CodeMirror 的 lineMarker 遇到带 toDOM 的 marker 就不画数字），不额外占列；
 *   行号关闭时退回独立窄 gutter，保证功能不丢；
 * - hover 行存 StateField，gutter/marker 依据它增量重绘；
 * - 拖动范围用 Decoration.line 画行底色，拖动时隐藏加号，避免和手势抢
 *   pointer 事件；
 * - mousedown 在 view.dom 的捕获阶段拦下：既不让 CodeMirror 进入文本选区，
 *   也不触发宿主已有的「引用到对话」选区浮层。
 */
import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  lineNumberMarkers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

export type CodeCommentGutterRequest = {
  startLine: number;
  endLine: number;
  /** 松开时的视口坐标：评论浮层以它为锚点 */
  anchor: { x: number; y: number };
};

export type CodeCommentGutterOptions = {
  /** 加号 title / aria-label（i18n） */
  label: string;
  /** 编辑器是否显示行号：决定加号覆盖行号还是走独立 gutter 回退 */
  lineNumbers: boolean;
  onRequest: (request: CodeCommentGutterRequest) => void;
};

type CommentGutterState = {
  hoverLine: number | null;
  drag: { from: number; to: number } | null;
};

const setHoverLine = StateEffect.define<number | null>();
const setDragRange = StateEffect.define<{ from: number; to: number } | null>();

const commentGutterState = StateField.define<CommentGutterState>({
  create: () => ({ hoverLine: null, drag: null }),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setHoverLine)) {
        if (next.hoverLine !== effect.value) {
          next = { ...next, hoverLine: effect.value };
        }
      } else if (effect.is(setDragRange)) {
        next = { ...next, drag: effect.value };
      }
    }
    if (tr.docChanged) {
      // 文档变了：行号可能整体平移，拖动中的范围不再可信；hover 行夹回有效范围
      if (next.drag) next = { ...next, drag: null };
      if (next.hoverLine != null) {
        next = {
          ...next,
          hoverLine: Math.min(next.hoverLine, tr.state.doc.lines),
        };
      }
    }
    return next;
  },
});

const DRAG_LINE_DECORATION = Decoration.line({
  class: "cm-code-comment-range",
});

/** 拖动范围行底色：直接读 commentGutterState（字段顺序保证它先更新） */
const dragDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, tr) {
    const drag = tr.state.field(commentGutterState).drag;
    if (!drag) return Decoration.none;
    const doc = tr.state.doc;
    const start = Math.max(1, Math.min(drag.from, drag.to));
    const end = Math.min(doc.lines, Math.max(drag.from, drag.to));
    if (start > end) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    for (let line = start; line <= end; line += 1) {
      const info = doc.line(line);
      builder.add(info.from, info.from, DRAG_LINE_DECORATION);
    }
    return builder.finish();
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CommentPlusMarker extends GutterMarker {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: GutterMarker) {
    return other instanceof CommentPlusMarker && other.label === this.label;
  }

  override toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    // 仅在鼠标悬停行存在，不参与 Tab 序列（避免"看不见的焦点站"）
    button.tabIndex = -1;
    button.className = "cm-comment-gutter-plus";
    button.title = this.label;
    button.setAttribute("aria-label", this.label);
    // 文本加号比 SVG 更贴行号槽的等宽网格，也避免额外图标依赖
    button.textContent = "+";
    return button;
  }
}

class CommentGutterSpacer extends GutterMarker {
  override toDOM() {
    const spacer = document.createElement("span");
    spacer.className = "cm-comment-gutter-spacer";
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }
}

/** clientY → 文档行号（跨 gutter/content 都成立，不依赖 event.target） */
function lineAtViewportY(view: EditorView, clientY: number): number {
  const block = view.lineBlockAtHeight(clientY - view.documentTop);
  return view.state.doc.lineAt(block.from).number;
}

class CommentGutterPlugin {
  private hoverLine: number | null = null;
  private drag: { anchor: number; current: number } | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly onRequest: (request: CodeCommentGutterRequest) => void,
  ) {
    view.dom.addEventListener("mousemove", this.handleMouseMove);
    view.dom.addEventListener("mouseleave", this.handleMouseLeave);
    view.dom.addEventListener("mousedown", this.handleMouseDown, true);
    // 拖到窗口外松手（或 Cmd+Tab）时收不到 mouseup，靠 blur 收尾
    window.addEventListener("blur", this.handleWindowBlur);
  }

  update(update: ViewUpdate) {
    // 拖动中发生文档变化：字段已自动清掉范围，这里只收掉本地手势与监听，
    // 不在 update 阶段 dispatch（避免重入）。
    if (update.docChanged && this.drag) {
      this.drag = null;
      this.removeDragListeners();
    }
  }

  destroy() {
    this.view.dom.removeEventListener("mousemove", this.handleMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.handleMouseLeave);
    this.view.dom.removeEventListener("mousedown", this.handleMouseDown, true);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.removeDragListeners();
    this.drag = null;
  }

  private setHover(line: number | null) {
    if (this.hoverLine === line) return;
    this.hoverLine = line;
    this.view.dispatch({ effects: setHoverLine.of(line) });
  }

  private handleMouseMove = (event: MouseEvent) => {
    if (this.drag) return;
    this.setHover(lineAtViewportY(this.view, event.clientY));
  };

  private handleMouseLeave = () => {
    if (this.drag) return;
    this.setHover(null);
  };

  private handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".cm-comment-gutter-plus")) return;

    // 捕获阶段就吃掉：不产生原生文字选区，也不让行号槽的默认行为介入
    event.preventDefault();
    event.stopPropagation();

    const anchor = this.hoverLine ?? lineAtViewportY(this.view, event.clientY);
    this.drag = { anchor, current: anchor };
    this.hoverLine = null;
    this.view.dispatch({
      effects: [setHoverLine.of(null), setDragRange.of({ from: anchor, to: anchor })],
    });
    window.addEventListener("mousemove", this.handleDragMove, true);
    window.addEventListener("mouseup", this.handleDragEnd, true);
  };

  private handleDragMove = (event: MouseEvent) => {
    const drag = this.drag;
    if (!drag) return;
    event.preventDefault();
    const line = lineAtViewportY(this.view, event.clientY);
    if (line === drag.current) return;
    this.drag = { anchor: drag.anchor, current: line };
    this.view.dispatch({
      effects: setDragRange.of({ from: drag.anchor, to: line }),
    });
  };

  private handleDragEnd = (event: MouseEvent) => {
    const drag = this.drag;
    if (!drag) return;
    event.preventDefault();
    const line = lineAtViewportY(this.view, event.clientY);
    this.finishDrag();
    this.onRequest({
      startLine: Math.min(drag.anchor, line),
      endLine: Math.max(drag.anchor, line),
      anchor: { x: event.clientX, y: event.clientY },
    });
  };

  /** 窗口失焦：放弃本次拖动，不弹浮层 */
  private handleWindowBlur = () => {
    if (this.drag) this.finishDrag();
  };

  private removeDragListeners() {
    window.removeEventListener("mousemove", this.handleDragMove, true);
    window.removeEventListener("mouseup", this.handleDragEnd, true);
  }

  private finishDrag() {
    this.drag = null;
    this.removeDragListeners();
    this.view.dispatch({ effects: [setDragRange.of(null), setHoverLine.of(null)] });
  }
}

/**
 * 评论 gutter 扩展。宿主只在具备「插入评论」能力时挂载；不挂时编辑器完全
 * 保持原样（设置页预览、资料库查看器等）。
 */
export function codeCommentGutter(
  options: CodeCommentGutterOptions,
): Extension {
  const plusMarker = new CommentPlusMarker(options.label);
  const spacerMarker = new CommentGutterSpacer();

  /**
   * 行号 gutter 的 marker：带 toDOM 的 marker 会让 lineNumbers 的
   * lineMarker 返回 null，于是这一行的数字被加号完整替换；行号槽宽度仍由
   * initialSpacer 按最大行号决定，不会抖动。
   */
  const lineNumberMarkerField = StateField.define<RangeSet<GutterMarker>>({
    create: () => RangeSet.empty,
    update(_value, tr) {
      const state = tr.state.field(commentGutterState);
      if (state.drag || state.hoverLine == null) return RangeSet.empty;
      const doc = tr.state.doc;
      if (doc.lines === 0) return RangeSet.empty;
      const lineNumber = Math.min(Math.max(1, state.hoverLine), doc.lines);
      return RangeSet.of([plusMarker.range(doc.line(lineNumber).from)]);
    },
    provide: (field) => lineNumberMarkers.from(field),
  });

  const markerExtension = options.lineNumbers
    ? lineNumberMarkerField
    : gutter({
        class: "cm-comment-gutter",
        initialSpacer: () => spacerMarker,
        lineMarker(view, line) {
          const state = view.state.field(commentGutterState);
          if (state.drag || state.hoverLine == null) return null;
          return view.state.doc.lineAt(line.from).number === state.hoverLine
            ? plusMarker
            : null;
        },
        lineMarkerChange: (update) =>
          update.startState.field(commentGutterState) !==
          update.state.field(commentGutterState),
      });

  return [
    commentGutterState,
    dragDecorationField,
    markerExtension,
    ViewPlugin.fromClass(
      class extends CommentGutterPlugin {
        constructor(view: EditorView) {
          super(view, options.onRequest);
        }
      },
    ),
  ];
}
