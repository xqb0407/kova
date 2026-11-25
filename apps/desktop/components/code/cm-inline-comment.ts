"use client";

/**
 * CodeMirror 行下内联评论编辑器：block widget 插在评论范围末行之后，
 * 随代码一起滚动/换行；React 通过 createPortal 渲染到 widget 的挂载点，
 * 这样编辑器本身仍是普通 React 组件（Button/Textarea/i18n）。
 */
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

export type InlineCommentDraft = {
  startLine: number;
  endLine: number;
};

export type InlineCommentHostChange = {
  token: number;
  /** null = 该 widget 被销毁；React 侧按 token 判断是否清空当前挂载点 */
  el: HTMLElement | null;
};

export const setInlineCommentDraft = StateEffect.define<InlineCommentDraft | null>();

const DRAFT_LINE = Decoration.line({ class: "cm-code-comment-range" });

let nextWidgetToken = 0;

type InlineCommentState = {
  draft: InlineCommentDraft | null;
  deco: DecorationSet;
};

class InlineCommentWidget extends WidgetType {
  constructor(
    readonly draft: InlineCommentDraft,
    readonly token: number,
    readonly onHostChange: (change: InlineCommentHostChange) => void,
  ) {
    super();
  }

  override eq(other: InlineCommentWidget) {
    return (
      other.draft.startLine === this.draft.startLine &&
      other.draft.endLine === this.draft.endLine
    );
  }

  override toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-code-comment-inline";
    const mount = document.createElement("div");
    wrap.appendChild(mount);
    this.onHostChange({ token: this.token, el: mount });
    return wrap;
  }

  override destroy() {
    this.onHostChange({ token: this.token, el: null });
  }

  // widget 内的 textarea/button 自己处理事件，不要让 CodeMirror 抢
  override ignoreEvent() {
    return true;
  }
}

/**
 * 创建内联评论扩展。宿主通过 view.dispatch({effects: setInlineCommentDraft.of(...)})
 * 打开/关闭；widget 的挂载点经 onHostChange 交给 React。
 */
export function createInlineCommentExtension(options: {
  onHostChange: (change: InlineCommentHostChange) => void;
}): Extension {
  return StateField.define<InlineCommentState>({
    create: () => ({ draft: null, deco: Decoration.none }),
    update(value, tr) {
      let draft = value.draft;
      for (const effect of tr.effects) {
        if (effect.is(setInlineCommentDraft)) draft = effect.value;
      }
      if (!draft) return { draft: null, deco: Decoration.none };

      const doc = tr.state.doc;
      const startLine = Math.min(
        Math.max(1, Math.min(draft.startLine, draft.endLine)),
        doc.lines,
      );
      const endLine = Math.min(
        Math.max(1, Math.max(draft.startLine, draft.endLine)),
        doc.lines,
      );
      if (startLine > endLine) {
        return { draft: null, deco: Decoration.none };
      }

      const builder = new RangeSetBuilder<Decoration>();
      for (let line = startLine; line <= endLine; line += 1) {
        const info = doc.line(line);
        builder.add(info.from, info.from, DRAFT_LINE);
      }
      const end = doc.line(endLine);
      builder.add(
        end.to,
        end.to,
        Decoration.widget({
          widget: new InlineCommentWidget(
            { startLine, endLine },
            ++nextWidgetToken,
            options.onHostChange,
          ),
          block: true,
          side: 1,
        }),
      );

      return {
        draft: { startLine, endLine },
        deco: builder.finish(),
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
  });
}
