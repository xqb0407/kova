"use client";

/**
 * CodeMirror 指令芯片扩展（composer 与自动化弹窗共用一份）：
 * 把文档里的 `:type[label]{name=id}` 序列化文本渲染成内联视觉元素，
 * 并对外提供触发范围检测 / 插入落点计算两个纯函数。
 *
 * 视觉分流（与消息行同一语言）：
 * - `agent`  → 子代理头像（显式或按名默认，与列表/面板同一张脸）+ 高亮文本
 *   （不是芯片）；清单未加载时回退机器人图标；
 * - `skill`/`tool`/`library` → 图标与触发弹层里该条目的图标一致
 *   （资料库按文件名取彩色类型图标）；
 * - 其它类型  → 芯片，未命中图标回退通用扳手；
 * - `command` → 无图标芯片。
 *
 * 之所以用 Decoration.replace 而非 mark：文档里存的是**协议序列化文本**，
 * 必须换成自造 DOM 才能不让用户看到 `:agent[X]{name=agent:X}`。代价是原子化
 * （光标不进入、退格整块删），这是刻意的。
 */
import { RangeSetBuilder, Transaction, type RangeSet } from "@codemirror/state";
import { getIcon } from "material-file-icons";
import { OPEN_ELEMENT_REF_EVENT } from "@/lib/element-refs";
import { resolveSubagentAvatarSrc } from "@/lib/subagent/avatar";
import { getSubagentAvatarByName } from "@/lib/subagent/subagents";
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

/** lucide zap 图标（命令芯片左侧闪电；与 `/` 弹层里命令条目的 Zap 图标一致） */
const ZAP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>';

/** lucide bot 图标（智能体提及左侧小机器人；描边取 currentColor，随高亮文字同色） */
const BOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

/** lucide book-open 图标（技能提及芯片左侧；与 BOT_SVG 同为内联 SVG，描边取 currentColor） */
const BOOK_OPEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';

/** lucide plug 图标（MCP 工具芯片：与 `/` 弹层里该条目的 Plug 图标一致） */
const PLUG_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>';

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

/** lucide git-commit-horizontal 图标（提交引用芯片：图谱「添加到对话」） */
const COMMIT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/></svg>';

/** lucide library 图标（资料库引用芯片的兜底：文件名解析不到类型时） */
const LIBRARY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></svg>';

/** 资料库芯片的文件类型图标：与 @ 提及弹层、文件树同一套彩色图标
 *  （material-file-icons 的静态数据集，按文件名解析扩展名）。
 *  lib 引用插入时弹层显示什么图标，芯片就显示什么图标。
 *  SVG 按图标名去重缓存：getIcon 每次可能返回新字符串，缓存后同图标共享
 *  同一份标记，芯片重建时不必反复生成。 */
const fileIconSvgByName = new Map<string, string>();
function libraryFileIconSvg(label: string): string {
  try {
    const hit = getIcon(label);
    let svg = fileIconSvgByName.get(hit.name);
    if (!svg) {
      svg = hit.svg;
      fileIconSvgByName.set(hit.name, svg);
    }
    return svg;
  } catch {
    return LIBRARY_SVG;
  }
}

/** 非 command 芯片的左侧图标：与触发弹层里对应的条目图标保持同一套
 *  （skill=BookOpen、tool=Plug、agent=Bot；资料库按文件名取彩色类型图标）。
 *  其余类型（element/console/code）不来自弹层，沿用各自语义图标；
 *  未命中回退通用扳手。 */
const CHIP_ICONS: Record<string, string> = {
  skill: BOOK_OPEN_SVG,
  tool: PLUG_SVG,
  element: ELEMENT_SVG,
  console: CONSOLE_SVG,
  code: FILE_CODE_SVG,
  commit: COMMIT_SVG,
  command: ZAP_SVG,
};

function chipIconHtml(type: string, label: string): string {
  if (type === "library") return libraryFileIconSvg(label);
  return CHIP_ICONS[type] ?? WRENCH_SVG;
}

/**
 * 智能体芯片图标：解析得到头像（显式设置的或按名称默认分配的）就画圆角小图，
 * 与列表/面板里的头像同一张脸；解析不到（清单还没加载）由调用方回退机器人。
 * 返回 null = 用 SVG 兜底。data URL 不含引号，内联进 innerHTML 安全。
 */
function agentAvatarHtml(label: string): string | null {
  const src = resolveSubagentAvatarSrc(getSubagentAvatarByName(label), label);
  if (!src) return null;
  return `<img src="${src}" alt="" draggable="false" style="width:16px;height:16px;border-radius:50%;object-fit:cover;display:block">`;
}

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
  "commit",
  // 自定义命令芯片：与技能/引用同款交互（图标 + 悬停叉 + 拖拽换位）
  "command",
]);

/**
 * 芯片悬浮提示：原生 title 在 contenteditable/Electron 里常不弹或延迟很久，
 * 这里用 fixed 定位的 DOM 浮层（样式见 globals.css 的 .aui-directive-tooltip）。
 * 只负责展示被 max-width 截断的完整 label；mousedown/移除时收起，避免残留。
 */
function attachChipTooltip(wrap: HTMLElement, text: string): void {
  if (!text) return;
  let tip: HTMLDivElement | null = null;
  let watchTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup(): void {
    if (watchTimer !== null) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("resize", hide);
    window.removeEventListener("blur", hide);
  }
  function hide(): void {
    cleanup();
    if (!tip) return;
    tip.remove();
    tip = null;
  }
  function show(): void {
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
    // 芯片被删除（退格/发送清空/编辑器重渲染）时不一定有 mouseleave：
    // 可见期间轮询连接状态，脱离文档立即收起
    watchTimer = setInterval(() => {
      if (!wrap.isConnected) hide();
    }, 200);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    // 窗口失焦（切到别的应用）时也收起，避免回来时浮层还挂在旧位置
    window.addEventListener("blur", hide);
  }

  wrap.addEventListener("mouseenter", show);
  wrap.addEventListener("mouseleave", hide);
  // 捕获阶段：删除按钮的 mousedown 会 stopPropagation，冒泡阶段收不到
  wrap.addEventListener("mousedown", hide, true);
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

/**
 * 芯片拖拽换位：按住芯片拖到文本里任意位置松手，整段 token 移到落点。
 *
 * 不用 HTML5 `draggable`：CodeMirror 在 contentDOM 上自行处理 mousedown（选区
 * 与拖选），原生 dragstart 起不来；可交互芯片的 mousedown 也已被拦截（自身
 * 交互语义），所以这里在拦下的手势上手写指针拖拽：
 * - 超过 4px 位移才算拖动（否则按单击处理，不误吞点击）；
 * - 拖动中源芯片半透明，落点插入光标跟随指针（不用克隆体拖影：离开容器会
 *   丢掉芯片样式，只剩一张裸文字快照）；
 * - 落点用 `posAtCoords` 换算；落在自身范围/编辑区外 = 取消，原样不动；
 * - 与 `insertIntoComposer` 同一条空格规则：紧贴非空白字符时补空格，否则
 *   指令 token 会与相邻文本粘连解析不出来；
 * - 移走时把源位置紧贴的空白一并收掉（每侧最多一个空格/制表符），否则反复
 *   拖动会把补上的空格留在原地累积。
 * 单击（未拖动）把光标放到芯片左/右边界并聚焦——可交互芯片原本吞掉了这次
 * 点击，光标进不了文本（2026-10 用户反馈）；element 芯片的单击另有打开详情的
 * 语义，不抢。
 */
function attachChipDrag(wrap: HTMLElement, widget: ChipWidget): void {
  const view = widget.view;
  const from = widget.from;
  const to = widget.to;
  if (!view || from < 0 || to <= from) return;
  const DRAG_THRESHOLD_PX = 4;

  // 彻底掐掉原生拖拽：contenteditable 里 contenteditable=false 的芯片在
  // Chromium 下会被当成可拖内容——原生 dragstart 一旦起来会吞掉 mousemove/
  // mouseup（页面收不到落点事件，换位不生效、自制拖影也不清理），还会叠出
  // 一张系统拖影。mousedown 的 preventDefault 不足以阻止它。
  wrap.setAttribute("draggable", "false");
  wrap.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  wrap.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    /** 落点插入光标：跟随指针实时显示芯片将落到文本的哪个位置 */
    let caret: HTMLElement | null = null;

    const cleanup = (): void => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onCancel, true);
      caret?.remove();
      caret = null;
      wrap.style.opacity = "";
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onCancel = (): void => cleanup();

    const onMove = (ev: MouseEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        dragging = true;
        // 不复制克隆体：拖影一旦挂在 body 下就丢掉容器的芯片样式，只剩一张
        // 裸文字快照（2026-10 用户反馈「不要这个样式」）。拖动反馈只留两件：
        // 源芯片半透明 + 落点插入光标。
        wrap.style.opacity = "0.35";
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      ev.preventDefault();
      // 落点光标：落在自身范围/编辑区外时隐藏
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      const eligible = pos != null && !(pos >= from && pos <= to);
      if (!eligible) {
        if (caret) caret.style.display = "none";
        return;
      }
      const coords = view.coordsAtPos(pos);
      if (!coords) {
        if (caret) caret.style.display = "none";
        return;
      }
      if (!caret) {
        caret = document.createElement("div");
        caret.className = "aui-directive-drop-caret";
        caret.style.position = "fixed";
        caret.style.width = "2px";
        caret.style.borderRadius = "1px";
        caret.style.background = "rgb(37 99 235)";
        caret.style.zIndex = "9999";
        caret.style.pointerEvents = "none";
        document.body.appendChild(caret);
      }
      caret.style.display = "";
      caret.style.left = `${coords.left - 1}px`;
      caret.style.top = `${coords.top}px`;
      caret.style.height = `${Math.max(12, coords.bottom - coords.top)}px`;
      // 编辑器自身的插入光标也挪到落点：否则旧光标停在拖动前的位置，
      // 用户看到的是「光标没跟着走」。仅改选区不改文档，不触发草稿同步。
      const sel = view.state.selection.main;
      if (sel.head !== pos || !sel.empty) {
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
      }
    };

    const onUp = (ev: MouseEvent): void => {
      const wasDragging = dragging;
      cleanup();
      if (!wasDragging) {
        // 单击：光标落到芯片左/右半边对应的边界（element 芯片有自己的点击语义）
        if (widget.directiveType !== "element") {
          const rect = wrap.getBoundingClientRect();
          const anchor = ev.clientX < rect.left + rect.width / 2 ? from : to;
          view.dispatch({ selection: { anchor }, scrollIntoView: false });
          view.focus();
        }
        return;
      }
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos == null) return;
      const doc = view.state.doc;
      // 删除源 token 时把紧贴的空白一并收掉（每侧最多一个空格/制表符）：
      // 拖到文本中间会在两侧补空格，再拖走时若只删 token，那对空格就留在
      // 原地越攒越多（2026-10 用户反馈「文本中间出现了空格」）。换行不并
      // ——那是用户的分段结构。
      const SPACE_ONLY = /^[ \t]$/;
      const wsBefore = from > 0 && SPACE_ONLY.test(doc.sliceString(from - 1, from));
      const wsAfter = to < doc.length && SPACE_ONLY.test(doc.sliceString(to, to + 1));
      const delFrom = wsBefore ? from - 1 : from;
      const delTo = wsAfter ? to + 1 : to;
      // 落在空出来的槽位（含边界）或编辑区外 = 取消
      if (pos >= delFrom && pos <= delTo) return;
      const token = doc.sliceString(from, to);
      const before = pos > 0 ? doc.sliceString(pos - 1, pos) : "";
      const after = pos < doc.length ? doc.sliceString(pos, pos + 1) : "";
      const prefix = before && !WHITESPACE_RE.test(before) ? " " : "";
      const suffix = after && !WHITESPACE_RE.test(after) ? " " : "";
      const insert = `${prefix}${token}${suffix}`;
      if (pos < delFrom) {
        view.dispatch({
          changes: [
            { from: pos, insert },
            { from: delFrom, to: delTo, insert: "" },
          ],
          selection: { anchor: pos + insert.length },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input.complete"),
        });
      } else {
        view.dispatch({
          changes: [
            { from: delFrom, to: delTo, insert: "" },
            { from: pos, insert },
          ],
          selection: { anchor: pos - (delTo - delFrom) + insert.length },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input.complete"),
        });
      }
      view.focus();
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onCancel, true);
  });
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
    // 可交互芯片（智能体 / 技能 / 资料库 / 控制台 / 元素）统一成「图标 + 蓝色
    // 标题 + 标题后的 hover 叉」文字提及形态（2026-10 用户指定参考样式）：
    // 布局为纯内联 / inline-block，行高与选中高亮跟正文一致；不再用药丸底。
    // 智能体（agent）走同一套，只多一个 aui-directive-agent 类做 hover 兼容。
    if (INTERACTIVE_TYPES.has(this.directiveType)) {
      wrap.className =
        "aui-directive-chip-mention aui-directive-chip-interactive aui-directive-chip-editor text-blue-500 dark:text-blue-400 font-medium" +
        (this.directiveType === "agent" ? " aui-directive-agent" : "");
      wrap.setAttribute("data-directive-type", this.directiveType);
      wrap.setAttribute("data-directive-id", this.id);
      wrap.style.cursor = "pointer";
      // mousedown 阻止默认：不让编辑器抢走这次交互（芯片本体仍由 ignoreEvent 让位）
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      const icon = document.createElement("span");
      icon.className = "aui-directive-chip-icon";
      const agentAvatar = this.directiveType === "agent" ? agentAvatarHtml(this.label) : null;
      icon.innerHTML =
        agentAvatar ??
        (this.directiveType === "agent"
          ? BOT_SVG
          : chipIconHtml(this.directiveType, this.label));
      // 彩色文件图标是 100% 尺寸的内联 SVG，容器必须给固定盒子；
      // lucide 图标自带 16px，无需额外尺寸。头像 img 同理（自带 16px 方盒）。
      if (agentAvatar || this.directiveType === "library") {
        icon.style.width = "16px";
        icon.style.height = "16px";
        icon.style.lineHeight = "0";
      }
      wrap.appendChild(icon);
      // DOM 顺序 [图标][叉][标题]：hover 时叉**顶替前置图标**（二选一，
      // 不放尾部），两者同尺寸同位置，切换时芯片宽度零跳动
      wrap.appendChild(createDeleteButton(this));
      const label = document.createElement("span");
      label.className = "aui-directive-chip-label";
      label.textContent = this.label;
      wrap.appendChild(label);
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
      // 按住拖到文本里任意位置换位（松手落点即目标位）；未拖动时按单击处理
      attachChipDrag(wrap, this);
      return wrap;
    }
    // 非交互（command / 未知类型）：保留药丸外观，无删除叉、无拖拽
    wrap.className = "aui-directive-chip aui-directive-chip-editor";
    wrap.setAttribute("data-directive-type", this.directiveType);
    wrap.setAttribute("data-directive-id", this.id);
    const icon = document.createElement("span");
    icon.className = "aui-directive-chip-icon";
    icon.innerHTML = chipIconHtml(this.directiveType, this.label);
    wrap.appendChild(icon);
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
