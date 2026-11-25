"use client";

/**
 * CodeMirror 已提交评论卡片：每个待发送评论在末行下方占一个 block widget，
 * React 通过 createPortal 渲染卡片。卡片与输入框芯片共用 store。
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

export type CodeCommentCardItem = {
  id: string;
  startLine: number;
  endLine: number;
};

export type CodeCommentCardHostChange = {
  id: string;
  token: number;
  el: HTMLElement | null;
};

let nextWidgetToken = 0;

export const setCodeCommentCards = StateEffect.define<
  readonly CodeCommentCardItem[]
>();

class CommentCardWidget extends WidgetType {
  readonly token = ++nextWidgetToken;

  constructor(
    readonly id: string,
    readonly onHostChange: (change: CodeCommentCardHostChange) => void,
  ) {
    super();
  }

  override eq(other: CommentCardWidget) {
    return other.id === this.id;
  }

  override toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-code-comment-card";
    const mount = document.createElement("div");
    wrap.appendChild(mount);
    this.onHostChange({ id: this.id, token: this.token, el: mount });
    return wrap;
  }

  override destroy() {
    this.onHostChange({ id: this.id, token: this.token, el: null });
  }

  override ignoreEvent() {
    return true;
  }
}

export function createCommentCardsExtension(options: {
  onHostChange: (change: CodeCommentCardHostChange) => void;
}): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(_value, tr) {
      let cards: readonly CodeCommentCardItem[] | null = null;
      for (const effect of tr.effects) {
        if (effect.is(setCodeCommentCards)) cards = effect.value;
      }
      if (!cards) {
        // 文档变化时沿用上一轮的 cards 不可行（StateField 不存 items），
        // 因此这个 effect 由宿主在每次 comments 变化时重发；这里仅在无 effect
        // 时保留现有装饰。
        return _value.map(tr.changes);
      }
      const doc = tr.state.doc;
      const ranges = cards.flatMap((card) => {
        if (doc.lines === 0) return [];
        const endLine = Math.min(
          Math.max(1, Math.max(card.startLine, card.endLine)),
          doc.lines,
        );
        const end = doc.line(endLine);
        return [
          Decoration.widget({
            widget: new CommentCardWidget(card.id, options.onHostChange),
            block: true,
            side: 1,
          }).range(end.to),
        ];
      });
      return Decoration.set(ranges, true);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
