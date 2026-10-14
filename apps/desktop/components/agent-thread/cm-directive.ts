"use client";

/**
 * CodeMirror 指令芯片扩展（composer 与自动化弹窗共用一份）：
 * 把文档里的 `:type[label]{name=id}` 序列化文本渲染成内联视觉元素，
 * 并对外提供触发范围检测 / 插入落点计算两个纯函数。
 *
 * 视觉分流（与消息行同一语言）：
 * - `agent`  → 机器人图标 + 高亮文本（不是芯片）；
 * - `skill`  → book-open 图标的芯片；
 * - 其它类型  → 芯片，未命中图标回退通用扳手；
 * - `command` → 无图标芯片。
 *
 * 之所以用 Decoration.replace 而非 mark：文档里存的是**协议序列化文本**，
 * 必须换成自造 DOM 才能不让用户看到 `:agent[X]{name=agent:X}`。代价是原子化
 * （光标不进入、退格整块删），这是刻意的。
 */
import { RangeSetBuilder, type RangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

/** 默认指令 formatter 的序列化格式：:type[label]{name=id}（id=label 时省略） */
export const DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
export const WHITESPACE_RE = /\s/u;

/** lucide wrench 图标（芯片左侧小扳手，非 command 类型显示） */
const WRENCH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

/** lucide bot 图标（智能体提及左侧小机器人；描边取 currentColor，随高亮文字同色） */
const BOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

/** lucide book-open 图标（技能提及芯片左侧；与 BOT_SVG 同为内联 SVG，描边取 currentColor） */
const BOOK_OPEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';

/** 非 command 芯片的左侧图标：按指令类型取（未命中回退通用扳手） */
const CHIP_ICONS: Record<string, string> = {
  skill: BOOK_OPEN_SVG,
};

class ChipWidget extends WidgetType {
  constructor(
    readonly directiveType: string,
    readonly label: string,
    readonly id: string,
  ) {
    super();
  }
  override eq(other: ChipWidget) {
    return other.directiveType === this.directiveType && other.label === this.label && other.id === this.id;
  }
  override toDOM() {
    const wrap = document.createElement("span");
    // 智能体提及不用芯片：改成「机器人图标 + 高亮文本」，与消息行里的 agent 名同一视觉语言
    if (this.directiveType === "agent") {
      wrap.className =
        "aui-directive-agent inline-flex items-baseline gap-1 text-blue-400 font-medium";
      wrap.setAttribute("data-directive-type", this.directiveType);
      wrap.setAttribute("data-directive-id", this.id);
      const icon = document.createElement("span");
      icon.className = "aui-directive-agent-icon inline-flex self-center";
      icon.innerHTML = BOT_SVG;
      wrap.appendChild(icon);
      const label = document.createElement("span");
      label.textContent = this.label;
      wrap.appendChild(label);
      return wrap;
    }
    wrap.className = "aui-directive-chip";
    wrap.setAttribute("data-directive-type", this.directiveType);
    wrap.setAttribute("data-directive-id", this.id);
    if (this.directiveType !== "command") {
      const icon = document.createElement("span");
      icon.className = "aui-directive-chip-icon";
      icon.innerHTML = CHIP_ICONS[this.directiveType] ?? WRENCH_SVG;
      wrap.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "aui-directive-chip-label";
    label.textContent = this.label;
    wrap.appendChild(label);
    return wrap;
  }
  override ignoreEvent() {
    return false;
  }
}

/** 扫描文档中的指令 token → 芯片替换 decoration；注册为 atomicRanges 使芯片原子化 */
function buildChipDecorations(view: EditorView): RangeSet<Decoration> {
  const text = view.state.doc.toString();
  // 无 ":" 必无指令 token：跳过正则扫描与 RangeSet 构建（纯文本打字的主路径）
  if (!text.includes(":")) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const from = match.index!;
    const to = from + match[0].length;
    builder.add(from, to, Decoration.replace({ widget: new ChipWidget(match[1]!, match[2]!, match[3] ?? match[2]!) }));
  }
  return builder.finish();
}

/** 芯片扩展：任意 CodeMirror 输入框挂上即可获得同款指令视觉 */
export const directiveChipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildChipDecorations(view);
    }
    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      // 组合期间只做位置映射：拼音预编辑不会产生指令 token，全量重扫纯属浪费，
      // 而"每次拼音按键都全量重扫"正是中文输入卡顿的来源之一。
      // 组合结束后的那次变更会走全量重扫，届时一并补齐。
      this.decorations = update.view.composing
        ? this.decorations.map(update.changes)
        : buildChipDecorations(update.view);
    }
  },
  {
    // 声明 decorations 才会让 CM 绘制替换 widget；atomicRanges 仅负责原子化
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/** 复刻库内 detectTrigger 的默认回溯：从光标前回退到 triggerChar（空白终止，前置非空白跳过） */
export function detectTriggerLocal(
  text: string,
  triggerChar: string,
  cursor: number,
): { offset: number; endOffset: number } | null {
  const upTo = text.slice(0, cursor);
  for (let i = upTo.length - 1; i >= 0; i--) {
    if (WHITESPACE_RE.test(upTo[i]!)) return null;
    if (upTo.startsWith(triggerChar, i)) {
      if (i > 0 && !WHITESPACE_RE.test(upTo[i - 1]!)) continue;
      return { offset: i, endOffset: cursor };
    }
  }
  return null;
}

/**
 * 触发范围 → 替换串与落点（纯函数，便于单测）。
 * 只替换 [offset, endOffset] 这一段（触发字符到光标）：**触发字符之前的内容一律
 * 原样保留**——不能把它拼进替换串，否则前面打的字会被复制到芯片之后（历史 bug）。
 * 芯片后若紧贴非空白字符则补一个空格，避免 `:skill[x]内容` 黏成一坨。
 */
export function buildTriggerInsert(
  text: string,
  match: { offset: number; endOffset: number },
  insert: string,
): { replace: string; caret: number } {
  const suffix = text.slice(match.endOffset);
  const trailing = suffix && !WHITESPACE_RE.test(suffix[0]!) ? " " : "";
  const replace = `${insert}${trailing}`;
  return { replace, caret: match.offset + replace.length };
}

/** 输入框基础主题（透明底、继承字体与行高，无内边距——布局交由宿主容器） */
export const directiveInputTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "auto", fontSize: "inherit" },
  "&.cm-editor.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": { padding: "0", margin: "0", minHeight: "1lh", caretColor: "inherit" },
  ".cm-line": { padding: "0" },
});
