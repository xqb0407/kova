"use client";

import { INTERNAL, unstable_useComposerInput, unstable_useTriggerPopoverAriaProps, unstable_useTriggerPopoverRootContextOptional, useAui, useAuiState } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter, type Unstable_TriggerItem } from "@assistant-ui/core";
import { defaultKeymap, history } from "@codemirror/commands";
import { Compartment, EditorState, Prec, RangeSetBuilder, Transaction, type RangeSet } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as cmPlaceholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef, type FC } from "react";
import { toast } from "@/components/ui/toast";
import { extractDataUriImageFiles, validatePromptFile } from "@/lib/attachments/prompt-attachments";
import { addSteeredBadge } from "@/lib/pi/pi-steer-intent";
import { notifyNoModelSelected, useModelGate } from "@/lib/pi/pi-model-gate";

/**
 * CodeMirror 6 版 composer 输入（替代 LexicalComposerInput）：
 * - 与 assistant-ui 触发弹层的接法同官方 Lexical 集成一致：经 INTERNAL 插件注册表
 *   上报扁平光标 offset（检测/搜索/键盘导航全部由弹层托管）；弹层打开时 keydown
 *   先委托插件层（↑↓ 导航、Enter/Tab 选中、Escape 关闭）。
 * - @ 提及选中 → 注册 selectItemOverride 自管插入：把触发文本替换为
 *   `:type[label]{name=id}` 序列化文本，用 Decoration.replace 渲染成内联芯片
 *   （atomicRanges 保证光标整体跳过、Backspace 整体删除）。
 * - / 指令（Action 行为）无需 override：库剥离触发文本后回调 onExecute。
 * - 外部 setText（技能/工具前置引导文本、排队条、引用）经最小前后缀 diff 回写
 *   CM 文档，光标按映射保留；组合期间跳过外部写入（compositionend 后对账）。
 */
type CmComposerInputProps = {
  /** Controls how Enter submits. @default "enter" */
  submitMode?: "enter" | "ctrlEnter" | "none";
  /** Whether Escape cancels editing. @default true */
  cancelOnEscape?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
};

/** 默认指令 formatter 的序列化格式：:type[label]{name=id}（id=label 时省略） */
const DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;
const WHITESPACE_RE = /\s/u;

/**
 * 外部 → 输入框的文本插入桥。
 * 触发弹层（`/` 与 `@`）走库内置的 selectItemOverride，但 composer 动作区的
 * + 菜单（技能 / 专家 / 连接器）在弹层之外，库没有对应的公开入口；这些菜单项
 * 要落在「光标处」而非追加到文末——用户可能已经把光标移到草稿中间改字。
 * 这里登记已挂载的 EditorView，插入时优先取持有焦点的那一个（主 composer 与
 * 逐条编辑 composer 同时在场时的判据），插入后归还焦点，光标停在插入内容之后。
 */
type ComposerViewHandle = {
  view: EditorView;
  hasFocus: () => boolean;
};
const composerViews = new Set<ComposerViewHandle>();

/** 返回是否找到可插入的输入框（false = 输入框未挂载，调用方应放弃本次插入） */
export function insertIntoComposer(text: string): boolean {
  const handles = [...composerViews];
  const target = handles.find((h) => h.hasFocus()) ?? handles[0];
  const view = target?.view;
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  // 与两侧已有字符之间补一个空格：芯片紧贴汉字会被 DIRECTIVE_RE 的
  // 「标签内不得含 ]」之外的边界吃掉，紧贴换行又会多出一段空白
  const prefix = from > 0 && !WHITESPACE_RE.test(doc.sliceString(from - 1, from)) ? " " : "";
  const suffix = to < doc.length && !WHITESPACE_RE.test(doc.sliceString(to, to + 1)) ? " " : "";
  const insert = `${prefix}${text}${suffix}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
    annotations: Transaction.userEvent.of("input.complete"),
  });
  view.focus();
  return true;
}


/** lucide wrench 图标（芯片左侧小扳手，非 command 类型显示） */
const WRENCH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

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
    wrap.className = "aui-directive-chip";
    wrap.setAttribute("data-directive-type", this.directiveType);
    wrap.setAttribute("data-directive-id", this.id);
    if (this.directiveType !== "command") {
      const icon = document.createElement("span");
      icon.className = "aui-directive-chip-icon";
      icon.innerHTML = WRENCH_SVG;
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
  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  DIRECTIVE_RE.lastIndex = 0;
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const from = match.index!;
    const to = from + match[0].length;
    builder.add(from, to, Decoration.replace({ widget: new ChipWidget(match[1]!, match[2]!, match[3] ?? match[2]!) }));
  }
  return builder.finish();
}

const chipPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildChipDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildChipDecorations(update.view);
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
function detectTriggerLocal(text: string, triggerChar: string, cursor: number): { offset: number; endOffset: number } | null {
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

const baseTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "auto", fontSize: "inherit" },
  "&.cm-editor.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": { padding: "0", margin: "0", minHeight: "1lh", caretColor: "inherit" },
  ".cm-line": { padding: "0" },
});

export const CmComposerInput: FC<CmComposerInputProps> = ({
  submitMode = "enter",
  cancelOnEscape = true,
  placeholder,
  autoFocus,
  className,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const { value, setText, send, canSend, isDisabled } = unstable_useComposerInput();
  const aria = unstable_useTriggerPopoverAriaProps();
  const registry = INTERNAL.useComposerInputPluginRegistryOptional();
  const popoverRoot = unstable_useTriggerPopoverRootContextOptional();
  // 模型不可用闸门：Enter 提交在此拦下（发送键同一口径，见 pi-model-gate）
  const gate = useModelGate();
  const noModel = !gate.usable;
  const noModelHint = gate.hint;

  const ariaComp = useRef(new Compartment()).current;
  const placeholderComp = useRef(new Compartment()).current;
  const editableComp = useRef(new Compartment()).current;

  // 闭包镜像：view 创建后 handler 里读最新 props/runtime（避免重建 view）
  const latestRef = useRef({ submitMode, cancelOnEscape, canSend, aui, registry, setText, send, threadId, noModel, noModelHint });
  latestRef.current = { submitMode, cancelOnEscape, canSend, aui, registry, setText, send, threadId, noModel, noModelHint };
  const valueRef = useRef(value);
  valueRef.current = value;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  /** 最小前后缀 diff 回写外部 setText（保光标；技能/工具前置文本时草稿不被甩尾） */
  const reconcile = (next: string) => {
    const view = viewRef.current;
    if (!view || view.composing || view.state.doc.toString() === next) return;
    const old = view.state.doc.toString();
    let start = 0;
    const minLen = Math.min(old.length, next.length);
    while (start < minLen && old[start] === next[start]) start++;
    let endOld = old.length;
    let endNew = next.length;
    while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) {
      endOld--;
      endNew--;
    }
    view.dispatch({
      changes: { from: start, to: endOld, insert: next.slice(start, endNew) },
      annotations: Transaction.remote.of(true),
    });
  };

  // 外部值 → CM（含挂载初值；view.composing 时跳过，compositionend 兜底对账）
  useEffect(() => {
    reconcile(value);
  }, [value]);

  // 编辑器一次性创建
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let destroyed = false;
    // 最近一次组合结束时刻（回声 Enter 判定用，见 anyKeyHandler）+ 本次组合
    // 是否以 Enter 提交（回声只在这种组合后出现，见 anyKeyHandler）
    let compositionEndedAt = 0;
    let composingEnterSeen = false;

    const anyKeyHandler = (event: KeyboardEvent): boolean => {
      if (event.isComposing || event.keyCode === 229) {
        if (event.key === "Enter") composingEnterSeen = true;
        return false;
      }
      const s = latestRef.current;
      // 输入法确认的回声 Enter（compositionend 后短窗口内补发的 isComposing=false
      // 按键）：仅当本次组合以 Enter 提交时吞掉——回声只产生于这种组合；
      // 无差别时间窗会把「空格/数字选词后快速按回车发送」的真实按键一并吞掉
      // （按两下才发出去的根源）。返回 true 让 CM preventDefault（不拦会白换一行）
      if (
        event.key === "Enter" &&
        composingEnterSeen &&
        performance.now() - compositionEndedAt <= 120
      ) {
        composingEnterSeen = false;
        return true;
      }
      // 弹层打开时导航/选中/关闭优先（与 textarea 路径同序）
      if (s.registry) {
        for (const plugin of s.registry.getPlugins()) {
          if (plugin.handleKeyDown(event)) return true;
        }
      }
      if (event.key === "Escape" && s.cancelOnEscape) {
        const composer = s.aui.composer;
        if (composer.getState().canCancel) {
          composer.cancel();
          event.preventDefault();
          return true;
        }
        return false;
      }
      if (event.key === "Enter") {
        const thread = s.aui.thread.getState();
        // 模型不可用：所有提交路径（按提交模式 / steer）在有草稿时一律拦下并
        // toast 说明原因；纯 Shift+Enter 是换行语义，照常放行。拦下的按键照吞
        // ——放行会插一个换行，看起来像「已经发出去了」
        const plainShiftEnter = event.shiftKey && !event.ctrlKey && !event.metaKey;
        if (s.noModel && s.noModelHint && s.canSend && !plainShiftEnter) {
          notifyNoModelSelected(s.noModelHint);
          return true;
        }
        // 运行中 Shift+⌘/Ctrl+Enter = 并入当前轮（steer 车道）：
        // sidecar 忙线程把消息注入活跃轮（不排队、不占队列上限、不中止当前回复）。
        // 车道必须经 send options 显式声明：store 暴露 queue adapter 后，
        // 不带 steer 选项的运行中发送会被 core append 默认路由成 steer
        // （message.steer ?? isRunning），排队语义要显式 steer:false
        if (
          event.shiftKey &&
          (event.ctrlKey || event.metaKey) &&
          thread.isRunning &&
          s.submitMode !== "none" &&
          s.canSend
        ) {
          event.preventDefault();
          const chatId = s.threadId;
          if (chatId) {
            // 已并入徽标（迁移 4a）：新链路 sidecar 不回传 data-steered 信号，
            // steer 发送即时本地记账，宿主轮流收尾时由队列栏清空
            const text = s.aui.composer.getState().text;
            if (text.trim()) addSteeredBadge(chatId, text);
          }
          s.send({ steer: true });
          return true;
        }
        if (event.shiftKey) return false;
        // 运行中不再拦 Enter：按提交模式发送 → steer:false 进排队车道，
        // sidecar 忙线程自动排队（Shift+Enter 换行、并入在上一分支）
        let shouldSubmit = false;
        if (s.submitMode === "ctrlEnter") shouldSubmit = event.ctrlKey || event.metaKey;
        else if (s.submitMode === "enter") shouldSubmit = !event.ctrlKey && !event.metaKey;
        if (shouldSubmit) {
          event.preventDefault();
          s.send({ steer: false });
          return true;
        }
        return false;
      }
      return false;
    };

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          baseTheme,
          history(),
          // Tab 不做缩进（交还浏览器默认移动焦点）；弹层打开时 Tab 选中走插件层
          keymap.of(defaultKeymap.filter((b) => b.key !== "Tab" && b.key !== "Shift-Tab")),
          Prec.highest(keymap.of([{ any: (_view, event) => anyKeyHandler(event) }])),
          EditorView.lineWrapping,
          chipPlugin,
          placeholderComp.of(cmPlaceholder(placeholderRef.current ?? "")),
          EditorView.contentAttributes.of({ spellcheck: "false" }),
          ariaComp.of(EditorView.contentAttributes.of({})),
          editableComp.of(EditorView.editable.of(!isDisabled)),
          EditorView.updateListener.of((update) => {
            if (destroyed) return;
            if (update.docChanged) {
              latestRef.current.setText(update.state.doc.toString());
            }
            // 组合期间不上报光标（与 textarea 路径一致，避免弹层随拼音闪动）
            if (!update.view.composing) {
              const reg = latestRef.current.registry;
              const pos = update.state.selection.main.head;
              if (reg) for (const plugin of reg.getPlugins()) plugin.setCursorPosition(pos);
            }
          }),
          EditorView.domEventHandlers({
            paste: (event, activeView) => {
              const s = latestRef.current;
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length === 0) {
                // 剪贴板没有文件条目、文本里却带 data URI 图片（从 devtools/看图应用
                // 复制）：转成附件，别把 base64 当草稿文本插进来——旧链路原样进 CM，
                // 发送后用户消息里就是一大段 base64（图片该走附件通道出缩略图）。
                if (!s.aui.thread.getState().capabilities.attachments) return false;
                const pasted = event.clipboardData?.getData("text/plain") ?? "";
                if (!pasted.includes("data:image/")) return false;
                const extracted = extractDataUriImageFiles(pasted);
                if (extracted.files.length === 0) return false;
                event.preventDefault();
                let converted = 0;
                for (const file of extracted.files) {
                  const err = validatePromptFile(file);
                  if (err) {
                    toast.error(err);
                    continue;
                  }
                  converted += 1;
                  void s.aui.composer.addAttachment(file).catch(() => {});
                }
                // 全部被闸门拒收时保留原文（不吞用户内容，toast 已说明原因）；
                // 否则把剥掉 URI 的剩余文字插回光标处（内联场景常伴随说明文字）
                const rest = converted > 0 ? extracted.rest : pasted;
                if (rest.trim()) activeView.dispatch(activeView.state.replaceSelection(rest));
                return true;
              }
              if (!s.aui.thread.getState().capabilities.attachments) return false;
              event.preventDefault();
              // 附件前置校验（图片/文档种类与大小）：不合格 toast 说明，不让垃圾进草稿；
              // 合格项交 composer 附件（发送时经 prompt-attachments.ts 组装下发，
              // 图片内联多模态 / 文档由 sidecar 落盘给 agent）
              for (const file of files) {
                const err = validatePromptFile(file);
                if (err) toast.error(err);
              }
              const accepted = files.filter((file) => !validatePromptFile(file));
              if (accepted.length === 0) return true;
              void Promise.all(
                accepted.map((file) =>
                  s.aui.composer.addAttachment(file).catch(() => {}),
                ),
              );
              return true;
            },
            compositionstart: () => {
              composingEnterSeen = false;
              return false;
            },
            compositionend: () => {
              compositionEndedAt = performance.now();
              // 组合期被跳过的外部写入在此对账（微任务避免与更新循环交叠）
              queueMicrotask(() => reconcile(valueRef.current));
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    // 登记到插入桥（+ 菜单等弹层之外的入口要用，见 insertIntoComposer）
    const handle: ComposerViewHandle = {
      view,
      hasFocus: () => view.hasFocus,
    };
    composerViews.add(handle);

    if (autoFocus) {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    }

    return () => {
      destroyed = true;
      composerViews.delete(handle);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ARIA（弹层开合/高亮变化）→ contenteditable 属性（CM Attrs 仅接受字符串值）
  useEffect(() => {
    const attrs: Record<string, string> = {};
    for (const [key, val] of Object.entries(aria)) {
      if (val != null) attrs[key] = String(val);
    }
    viewRef.current?.dispatch({
      effects: ariaComp.reconfigure(EditorView.contentAttributes.of(attrs)),
    });
  }, [aria, ariaComp]);

  // 禁用态 → editable
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableComp.reconfigure(EditorView.editable.of(!isDisabled)),
    });
  }, [isDisabled, editableComp]);

  // placeholder 变更（当前各调用点为静态，防御性支持）
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderComp.reconfigure(cmPlaceholder(placeholder ?? "")),
    });
  }, [placeholder, placeholderComp]);

  // 运行开始回到输入框（仅主 composer；对齐 Lexical FocusPlugin 行为）。
  // 组合期间（拼音预编辑）绝不动光标/抢焦点——selection 事务会打断输入法
  // 会话，预编辑拼音被固化成文本（WebKit/WKWebView 上尤其致命）；已在
  // 焦点内（排队 turn 激活时正在打下一条）同样无需打扰
  useEffect(() => {
    if (!autoFocus) return;
    return aui.on("thread.runStart", () => {
      if (aui.composer.getState().type !== "thread") return;
      const view = viewRef.current;
      if (!view) return;
      if (view.composing || view.hasFocus) return;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    });
  }, [aui, autoFocus]);

  // 弹层选中 → 芯片插入（override 范式同 react-lexical 的 DirectivePlugin）：
  // - @ 提及（directive 行为）：整体替换触发文本为序列化芯片文本；
  // - / 菜单（action 行为）：skill/tool 同款芯片插入。库默认路径的剥离
  //   setText 经 tap store 异步生效，onExecute 里 getState() 读到的仍是
  //   未剥离文本（触发字符残留），故这里用 CM 文档+光标重算触发范围自行剥离；
  //   command 条目返回 false 交回库默认路径（剥离 + onExecute 前端动作）。
  useEffect(() => {
    if (!popoverRoot) return;
    const unsubs = new Map<string, () => void>();
    const wire = (trigger: {
      readonly char: string;
      readonly behavior?: { readonly kind: string; readonly formatter?: typeof unstable_defaultDirectiveFormatter };
      readonly resource: { registerSelectItemOverride(fn: (item: Unstable_TriggerItem) => boolean): () => void };
    }) => {
      const behavior = trigger.behavior;
      if (!behavior) return;
      const formatter = behavior.formatter ?? unstable_defaultDirectiveFormatter;
      const handlesItem =
        behavior.kind === "directive"
          ? () => true
          : (item: Unstable_TriggerItem) => item.type !== "command";
      unsubs.set(
        trigger.char,
        trigger.resource.registerSelectItemOverride((item) => {
          if (!handlesItem(item)) return false;
          const view = viewRef.current;
          if (!view) return false;
          const text = view.state.doc.toString();
          const head = view.state.selection.main.head;
          const match = detectTriggerLocal(text, trigger.char, head);
          if (!match) return false;
          const insert = formatter.serialize(item);
          const rest = (text.slice(0, match.offset) + text.slice(match.endOffset)).replace(/^\s+/, "");
          const full = rest ? `${insert} ${rest}` : insert;
          view.dispatch({
            changes: { from: match.offset, to: match.endOffset, insert: full },
            selection: {
              anchor: match.offset + insert.length + (rest ? 1 : 0),
            },
            annotations: Transaction.userEvent.of("input.complete"),
          });
          return true;
        }),
      );
    };
    for (const trigger of popoverRoot.getTriggers().values()) wire(trigger);
    const unsubLifecycle = popoverRoot.subscribeLifecycle({
      added: (trigger) => wire(trigger),
      removed: (char) => {
        unsubs.get(char)?.();
        unsubs.delete(char);
      },
    });
    return () => {
      unsubLifecycle();
      for (const unsub of unsubs.values()) unsub();
      unsubs.clear();
    };
  }, [popoverRoot]);

  return <div ref={hostRef} className={className} data-slot="aui-cm-input" />;
};
