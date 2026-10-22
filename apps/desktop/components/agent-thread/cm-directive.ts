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
import { OPEN_ELEMENT_REF_EVENT } from "@/lib/element-refs";
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

/** lucide mouse-pointer-2 图标（页面元素引用芯片：与浏览器拾取器同一视觉语言） */
const ELEMENT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></svg>';

/** lucide square-terminal 图标（浏览器控制台日志芯片） */
const CONSOLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/></svg>';

/** lucide x 图标（芯片悬浮删除按钮里的叉） */
const X_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/** lucide file-code 图标（代码引用芯片：文件视图选区「引用到对话」） */
const FILE_CODE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>';

/** lucide library 图标（资料库引用芯片：「引用到对话」） */
const LIBRARY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></svg>';

/** 非 command 芯片的左侧图标：按指令类型取（未命中回退通用扳手） */
const CHIP_ICONS: Record<string, string> = {
  skill: BOOK_OPEN_SVG,
  element: ELEMENT_SVG,
  console: CONSOLE_SVG,
  code: FILE_CODE_SVG,
  library: LIBRARY_SVG,
};

/** 可交互芯片（自己处理点击：打开详情 / 悬浮删除）；其余类型交给编辑器。
 *  skill 与 agent 提及也走这套：悬浮时左侧图标原位换成 ✕，点击整段删除
 *  ——用户对所有内联指令的预期一致（此前它们在悬浮时毫无反馈，像坏掉了）。
 *  code（「引用到对话」的代码引用）虽渲染成高亮文本而非药丸，但同属可交互：
 *  悬浮叉要按文档范围惰性删除 token，范围变了必须重建 DOM。 */
const INTERACTIVE_TYPES = new Set([
  "skill",
  "agent",
  "element",
  "console",
  "code",
  "library",
]);

/**
 * 芯片悬浮提示：原生 title 在 contenteditable/Electron 里常不弹或延迟很久，
 * 这里用 fixed 定位的 DOM 浮层（样式见 globals.css 的 .aui-directive-tooltip）。
 * 只负责展示被 max-width 截断的完整 label；mousedown/移除时收起，避免残留。
 */
function attachChipTooltip(wrap: HTMLElement, text: string): void {
  if (!text) return;
  let tip: HTMLDivElement | null = null;
  const hide = () => {
    if (!tip) return;
    tip.remove();
    tip = null;
  };
  const show = () => {
    if (tip || !wrap.isConnected) return;
    const rect = wrap.getBoundingClientRect();
    tip = document.createElement("div");
    tip.className = "aui-directive-tooltip";
    tip.textContent = text;
    document.body.appendChild(tip);
    const tipRect = tip.getBoundingClientRect();
    const above = rect.top > tipRect.height + 12;
    const top = above ? rect.top - tipRect.height - 8 : rect.bottom + 8;
    const maxLeft = Math.max(8, window.innerWidth - tipRect.width - 8);
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.left = `${Math.min(maxLeft, Math.max(8, rect.left))}px`;
  };
  wrap.addEventListener("mouseenter", show);
  wrap.addEventListener("mouseleave", hide);
  wrap.addEventListener("mousedown", hide);
}

/** 悬浮删除按钮：hover 时原地替换左侧类型图标，点击把 token 整段从文档删掉。
 *  （图标/叉的显隐规则在 globals.css 的 .aui-directive-chip-interactive 族；
 *  叉与图标同尺寸同位，hover 切换时宽度不跳。） */
function createDeleteButton(widget: ChipWidget): HTMLElement {
  const del = document.createElement("span");
  del.className = "aui-directive-chip-delete";
  del.title = "移除";
  del.innerHTML = X_SVG;
  del.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  del.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const view = widget.view;
    if (!view || widget.from < 0 || widget.to <= widget.from) return;
    view.dispatch({
      changes: { from: widget.from, to: widget.to, insert: "" },
      selection: { anchor: widget.from },
      scrollIntoView: false,
    });
    view.focus();
  });
  return del;
}

class ChipWidget extends WidgetType {
  constructor(
    readonly directiveType: string,
    readonly label: string,
    readonly id: string,
    /** token 在文档里的范围（删除按钮直接按范围 dispatch）；-1 表示不可删 */
    readonly from: number = -1,
    readonly to: number = -1,
    /** 所属编辑器（删除按钮要 dispatch 到它上面） */
    readonly view: EditorView | null = null,
  ) {
    super();
  }
  override eq(other: ChipWidget) {
    // 可交互芯片带范围与视图：范围变了必须重建 DOM（否则删除按钮指向旧位置）
    if (
      other.directiveType === this.directiveType &&
      other.label === this.label &&
      other.id === this.id
    ) {
      if (!INTERACTIVE_TYPES.has(this.directiveType)) return true;
      return other.from === this.from && other.to === this.to;
    }
    return false;
  }
  override toDOM() {
    const wrap = document.createElement("span");
    // 悬浮显示完整标签：统一截断（globals.css 的 max-width）后靠自绘 tooltip 看全文
    attachChipTooltip(wrap, this.label);
    // 智能体提及不用药丸底：改成「机器人图标 + 高亮文本」，与消息行里的 agent
    // 名同一视觉语言；悬浮时图标原位换成 ✕，点击整段删除（同可交互芯片）
    if (this.directiveType === "agent") {
      wrap.className =
        "aui-directive-agent aui-directive-chip-interactive inline-flex items-baseline gap-1 text-blue-400 font-medium";
      wrap.setAttribute("data-directive-type", this.directiveType);
      wrap.setAttribute("data-directive-id", this.id);
      wrap.style.cursor = "pointer";
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      const icon = document.createElement("span");
      icon.className =
        "aui-directive-agent-icon aui-directive-chip-icon inline-flex self-center";
      icon.innerHTML = BOT_SVG;
      wrap.appendChild(icon);
      // DOM 顺序 [图标][叉][文字]：hover 时图标隐、叉显，恰落在图标原位
      wrap.appendChild(createDeleteButton(this));
      const label = document.createElement("span");
      label.className = "aui-directive-chip-label";
      label.textContent = this.label;
      wrap.appendChild(label);
      return wrap;
    }
    // 代码引用（「引用到对话」）：**高亮文本**而非药丸芯片——与智能体提及同一
    // 视觉语言（图标 + 蓝色文字，无底色框）；悬浮时左侧图标原位换成 ✕，点击把
    // 整段引用从输入框删掉（复用可交互芯片的 CSS 族，叉的显隐规则同款）
    if (this.directiveType === "code") {
      wrap.className =
        "aui-directive-code aui-directive-chip-interactive inline-flex items-baseline gap-1 font-medium text-blue-400";
      wrap.setAttribute("data-directive-type", this.directiveType);
      wrap.setAttribute("data-directive-id", this.id);
      wrap.style.cursor = "pointer";
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      const icon = document.createElement("span");
      icon.className = "aui-directive-chip-icon inline-flex self-center";
      icon.innerHTML = CHIP_ICONS[this.directiveType] ?? WRENCH_SVG;
      wrap.appendChild(icon);
      // DOM 顺序 [图标][叉][文字]：hover 时图标隐、叉显，恰落在图标原位
      wrap.appendChild(createDeleteButton(this));
      const label = document.createElement("span");
      label.className = "aui-directive-chip-label";
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
    if (INTERACTIVE_TYPES.has(this.directiveType)) {
      wrap.classList.add("aui-directive-chip-interactive");
      wrap.style.cursor = "pointer";
      // mousedown 阻止默认：不让编辑器抢走这次交互（芯片本体仍由 ignoreEvent 让位）
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      if (this.directiveType === "element") {
        // 元素芯片：点击打开详情 Dialog（选择器即 id 槽，见 lib/element-refs）
        wrap.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent(OPEN_ELEMENT_REF_EVENT, { detail: this.id }),
          );
        });
      }
      // 悬浮删除：**原地替换掉左侧类型图标**（DOM 顺序在图标之后，图标
      // display:none 后叉恰落在原位，芯片宽度不跳）
      wrap.appendChild(createDeleteButton(this));
    }
    // 标签最后 append：可交互芯片的 DOM 顺序是 [图标][叉][文字]——hover 时
    // 图标隐、叉显，叉恰好落在图标原位（若标签在叉之前 append，叉会跑到
    // 芯片右端，与"替换前置图标"的语义相反——上一版就是这个错位）
    const label = document.createElement("span");
    label.className = "aui-directive-chip-label";
    label.textContent = this.label;
    wrap.appendChild(label);
    return wrap;
  }
  override ignoreEvent() {
    // 可交互芯片自己处理点击（打开详情/删除）；其余类型交给编辑器（选中/退格原子删除）
    return INTERACTIVE_TYPES.has(this.directiveType);
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
    builder.add(
      from,
      to,
      Decoration.replace({
        widget: new ChipWidget(
          match[1]!,
          match[2]!,
          match[3] ?? match[2]!,
          from,
          to,
          view,
        ),
      }),
    );
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
