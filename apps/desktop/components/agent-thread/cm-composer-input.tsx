"use client";

import { INTERNAL, unstable_useComposerInput, unstable_useTriggerPopoverAriaProps, unstable_useTriggerPopoverRootContextOptional, useAui, useAuiState } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter, type Unstable_TriggerItem } from "@assistant-ui/core";
import { defaultKeymap, history } from "@codemirror/commands";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { useEffect, useRef, type FC } from "react";
import { toast } from "@/components/ui/toast";
import { extractDataUriImageFiles, validatePromptFile } from "@/lib/attachments/prompt-attachments";
import { notifyNoModelSelected, useModelGate } from "@/lib/pi/pi-model-gate";
import { usePiQueue } from "@/lib/pi/pi-runtime";
import { blockSendIfQueueFull } from "@/lib/pi/pi-queue-limit";
import { hasMissingLibraryRefs } from "@/lib/workspace/library-ref-guard";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useMcpServers } from "@/lib/mcp/mcp";
import {
  buildTriggerInsert,
  detectTriggerLocal,
  DIRECTIVE_RE,
  directiveChipPlugin,
  directiveInputTheme,
  WHITESPACE_RE,
} from "./cm-directive";

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
 *   CM 文档，光标按映射保留；组合期间双向暂停（外部写入跳过、文档变更不写
 *   store），compositionend 时把 CM 文档推回 store 对账。
 */
type CmComposerInputProps = {
  /** Controls how Enter submits. @default "enter" */
  submitMode?: "enter" | "ctrlEnter" | "none";
  /** Whether Escape cancels editing. @default true */
  cancelOnEscape?: boolean;
  /**
   * 独立模式（自动化弹窗等非会话宿主）：Enter 只换行、Escape 不取消本轮，
   * 提交交给宿主自己的按钮；其余（芯片插入、触发菜单）与会话内完全一致。
   */
  standalone?: boolean;
  /**
   * 优化进行中等外部锁定态：输入框不可编辑、Enter/Escape 一律吞掉。
   * 与 isDisabled 不同——只掐键盘提交/编辑，不打断组合输入以外的库状态，
   * 遮罩期间发送路径（s.send 是 JS 直调、不受 contenteditable 约束）也在
   * 这里拦下。
   */
  blocked?: boolean;
  /**
   * 队列容量守卫（v3.1，见 pi-queue-limit）：仅会话主 composer 开启——Enter
   * 提交进排队车道且排队已满时拦下提示（草稿保留）。消息编辑器、自动化
   * 字段等非排队宿主不开：编辑不走队列车道，误拦会挡住与队列无关的操作。
   */
  queueGuard?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
};

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

/**
 * 把焦点还给输入框（提示词优化回填后用）：优先已持有焦点的那个，
 * 否则取最早登记的实例（主 composer 通常先挂载）。
 */
export function focusComposer(): void {
  const handles = [...composerViews];
  const target = handles.find((h) => h.hasFocus()) ?? handles[0];
  target?.view.focus();
}

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

/** composer 状态 API 的最小形状（资料库页等 Composer 未挂载的场景写入草稿） */
type ComposerApi = {
  composer: {
    getState(): { text?: string };
    setText(text: string): void;
  };
};

/** 直接写入 runtime 草稿（追加在文末）：资料库页没有挂载 composer 输入框，
 *  CM 插入桥不可用；runtime 的 composer state 仍在线程作用域里活着，切回
 *  对话页时 CmComposerInput 挂载会把 value reconcile 进编辑器。 */
export function appendDirectiveToComposer(
  aui: ComposerApi,
  directive: string,
): boolean {
  try {
    const current = aui.composer.getState().text ?? "";
    aui.composer.setText(
      current.trim() ? `${current.trimEnd()} ${directive}` : directive,
    );
    return true;
  } catch {
    return false;
  }
}

/** 插入引用的统一入口：输入框在场落光标处，不在场退回草稿追加 */
export function insertOrAppendDirective(
  aui: ComposerApi,
  directive: string,
): boolean {
  return insertIntoComposer(directive) || appendDirectiveToComposer(aui, directive);
}


export const CmComposerInput: FC<CmComposerInputProps> = ({
  submitMode = "enter",
  cancelOnEscape = true,
  standalone = false,
  blocked = false,
  placeholder,
  autoFocus,
  className,
  queueGuard = false,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const aui = useAui();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const workspace = useWorkspace();
  const mcp = useMcpServers(workspace);
  const { value, setText, send, canSend, isDisabled } = unstable_useComposerInput();
  const aria = unstable_useTriggerPopoverAriaProps();
  const registry = INTERNAL.useComposerInputPluginRegistryOptional();
  const popoverRoot = unstable_useTriggerPopoverRootContextOptional();
  // 模型不可用闸门：Enter 提交在此拦下（发送键同一口径，见 pi-model-gate）
  const gate = useModelGate();
  const noModel = !gate.usable;
  const noModelHint = gate.hint;
  // 队列容量守卫的数据源：排队条已满时拦截发送（发送键同一口径）
  const { queue: queueState } = usePiQueue();
  const queueCount = queueState.followUp.length;

  const ariaComp = useRef(new Compartment()).current;
  const placeholderComp = useRef(new Compartment()).current;
  const editableComp = useRef(new Compartment()).current;

  // 闭包镜像：view 创建后 handler 里读最新 props/runtime（避免重建 view）
  const latestRef = useRef({ submitMode, cancelOnEscape, standalone, blocked, canSend, aui, registry, setText, send, threadId, noModel, noModelHint, queueCount, queueGuard });
  latestRef.current = { submitMode, cancelOnEscape, standalone, blocked, canSend, aui, registry, setText, send, threadId, noModel, noModelHint, queueCount, queueGuard };
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

    // 光标上报（触发 @ / 弹层检测）从输入事件里挪出去并每帧合并一次。
    // 点击/拖选都会改选区，而插件 setCursorPosition 是 React state 更新：
    // 同步跑会算进 pointer 事件的 INP processing（实测 composer 点击 116ms）。
    // caret 由 CodeMirror 自己先画；弹层检测晚一帧无感，连续移动还能合并。
    let cursorFrame: number | null = null;
    let cursorTimer: ReturnType<typeof setTimeout> | null = null;
    let cursorPending = -1;
    const reportCursor = (pos: number) => {
      cursorPending = pos;
      if (cursorFrame !== null || cursorTimer !== null) return;
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = null;
        // rAF 仍在绘制前：直接跑插件检测/React 更新会把 caret 与焦点反馈一起
        // 推迟（trace 里点击后紧跟的 83ms React 任务就是它）。再让出一拍，
        // 先让点击这一帧完成绘制，弹层检测晚一个任务执行。
        cursorTimer = setTimeout(() => {
          cursorTimer = null;
          if (destroyed) return;
          const reg = latestRef.current.registry;
          if (!reg) return;
          const pending = cursorPending;
          for (const plugin of reg.getPlugins()) plugin.setCursorPosition(pending);
        }, 0);
      });
    };

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
      // 外部锁定态（提示词优化进行中）：Enter（换行/steer/发送全变体）与
      // Escape（取消 composer）一律吞掉——s.send 是 JS 直调，contenteditable
      // 层的 editable=false 拦不住它
      if (s.blocked && (event.key === "Enter" || event.key === "Escape")) {
        return true;
      }
      // 弹层打开时导航/选中/关闭优先（与 textarea 路径同序）
      if (s.registry) {
        for (const plugin of s.registry.getPlugins()) {
          if (plugin.handleKeyDown(event)) return true;
        }
      }
      if (event.key === "Escape" && s.cancelOnEscape && !s.standalone) {
        const composer = s.aui.composer;
        if (composer.getState().canCancel) {
          composer.cancel();
          event.preventDefault();
          return true;
        }
        return false;
      }
      if (event.key === "Enter") {
        // 独立宿主（自动化弹窗等）：Enter 只换行，提交交给宿主自己的按钮
        if (s.standalone) return false;
        const thread = s.aui.thread.getState();
        // 模型不可用：所有提交路径（按提交模式 / steer）在有草稿时一律拦下并
        // toast 说明原因；纯 Shift+Enter 是换行语义，照常放行。拦下的按键照吞
        // ——放行会插一个换行，看起来像「已经发出去了」
        const plainShiftEnter = event.shiftKey && !event.ctrlKey && !event.metaKey;
        if (s.noModel && s.noModelHint && s.canSend && !plainShiftEnter) {
          notifyNoModelSelected(s.noModelHint);
          return true;
        }
        // 资料库引用失效守卫：有失效引用（bar 在输入框上方列着）就不发，
        // 用户点 bar 上的「移除失效引用」后再发
        if (s.canSend && !plainShiftEnter && hasMissingLibraryRefs(s.threadId)) {
          toast.error("有引用已失效，请先移除");
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
          // 队列容量守卫（见 pi-queue-limit）：此刻发送进排队车道且已满 →
          // 拦下提示——sidecar 静默拒绝 + 草稿已清 = 丢一条消息。
          // steer 车道（上一分支）不占队列容量，不做守卫
          const willQueue = thread.isRunning || s.queueCount > 0;
          if (
            s.queueGuard &&
            s.canSend &&
            blockSendIfQueueFull(willQueue, s.queueCount)
          ) {
            return true;
          }
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
          directiveInputTheme,
          history(),
          // Tab 不做缩进（交还浏览器默认移动焦点）；弹层打开时 Tab 选中走插件层
          keymap.of(defaultKeymap.filter((b) => b.key !== "Tab" && b.key !== "Shift-Tab")),
          Prec.highest(keymap.of([{ any: (_view, event) => anyKeyHandler(event) }])),
          EditorView.lineWrapping,
          directiveChipPlugin,
          placeholderComp.of(cmPlaceholder(placeholderRef.current ?? "")),
          EditorView.contentAttributes.of({ spellcheck: "false" }),
          ariaComp.of(EditorView.contentAttributes.of({})),
          editableComp.of(EditorView.editable.of(!isDisabled)),
          EditorView.updateListener.of((update) => {
            if (destroyed) return;
            if (update.docChanged) {
              // 组合期间不写 store：拼音预编辑每键都出文档变更，写回会让整棵
              // composer 子树重渲染、拖卡输入法（compositionend 时补发一次）。
              // 远端回写（reconcile 自己发起的）不再回声，省掉一轮
              // setText → 重渲染 → reconcile 的往返。
              const remote = update.transactions.some((tr) =>
                tr.annotation(Transaction.remote),
              );
              if (!update.view.composing && !remote) {
                latestRef.current.setText(update.state.doc.toString());
              }
            }
            // 组合期间不上报光标（与 textarea 路径一致，避免弹层随拼音闪动）
            if (!update.view.composing) {
              reportCursor(update.state.selection.main.head);
            }
          }),
          EditorView.domEventHandlers({
            paste: (event, activeView) => {
              const s = latestRef.current;
              // 图片闸按本 composer 所在会话判定：主对话与副屏各挂一个实例，
              // 闸门内部的模块级登记会被后挂载者覆盖，必须显式传线程 id。
              const threadId = s.aui.threads.getState().mainThreadId;
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
                  const err = validatePromptFile(file, threadId);
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
                const err = validatePromptFile(file, threadId);
                if (err) toast.error(err);
              }
              const accepted = files.filter(
                (file) => !validatePromptFile(file, threadId),
              );
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
              // 组合期双向都暂停（外部写入跳过、文档变更不写 store），这里把 CM 文档
              // 推回 store 对账。**不能反过来**用 store 值 reconcile：组合期 store 是
              // 陈旧的，那样会把刚输入的中文整段冲掉（微任务避免与更新循环交叠）。
              // 时序（冒烟实锤）：queueMicrotask 会在库自身的 composition teardown
              // 之前跑——补发的 setText/光标上报被随后的复位冲掉，`/` 菜单停在
              // 组合前的查询，选字回车后不刷新、再回车误选（裸文本+重复芯片）。
              // 改宏任务让库先完成 teardown，再补 store 文本 + 光标上报
              //（rAF 双保险再报一次，抵消 reportCursor 自带的合并防抖窗口）。
              setTimeout(() => {
                const v = viewRef.current;
                if (destroyed || !v) return;
                latestRef.current.setText(v.state.doc.toString());
                reportCursor(v.state.selection.main.head);
                requestAnimationFrame(() => {
                  if (destroyed || !v) return;
                  reportCursor(v.state.selection.main.head);
                });
              }, 0);
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
      if (cursorFrame !== null) cancelAnimationFrame(cursorFrame);
      if (cursorTimer !== null) clearTimeout(cursorTimer);
      composerViews.delete(handle);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MCP 清单变化后清掉指向已删除服务器/插件的 tool 芯片：服务器被卸载/删除后
  // 这些芯片发出去只会让模型报「工具不存在」。只在成功拿到完整清单时做；加载中/
  // 出错时保持原样，避免把暂时不可用的条目误删。芯片本身就是可交互指令，删除
  // 不涉及正文其它文本。
  useEffect(() => {
    if (!mcp.loaded || mcp.loading || mcp.error) return;
    if (isDisabled || blocked) return;
    if ((mcp.workspaceCwd ?? null) !== (workspace ?? null)) return;
    const view = viewRef.current;
    if (!view || view.composing) return;
    const text = view.state.doc.toString();
    if (!text.includes(":tool[")) return;
    const known = new Set(
      [...mcp.servers, ...mcp.pluginServers].map((s) => s.name),
    );
    const ranges: { from: number; to: number }[] = [];
    for (const match of text.matchAll(DIRECTIVE_RE)) {
      if (match[1] !== "tool") continue;
      const id = match[3] ?? "";
      if (!id.startsWith("tool:")) continue;
      const server = id.slice("tool:".length).split(":")[0] ?? "";
      if (!server || known.has(server)) continue;
      ranges.push({ from: match.index!, to: match.index! + match[0].length });
    }
    if (ranges.length === 0) return;
    view.dispatch({
      changes: ranges,
      annotations: Transaction.userEvent.of("delete.directive"),
    });
  }, [
    mcp.loaded,
    mcp.loading,
    mcp.error,
    mcp.workspaceCwd,
    mcp.servers,
    mcp.pluginServers,
    workspace,
    isDisabled,
    blocked,
  ]);

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

  // 禁用/锁定态 → editable（blocked = 优化进行中；只锁编辑与提交，不打断库状态）
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableComp.reconfigure(
        EditorView.editable.of(!isDisabled && !blocked),
      ),
    });
  }, [isDisabled, blocked, editableComp]);

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
          const { replace, caret } = buildTriggerInsert(text, match, insert);
          view.dispatch({
            changes: { from: match.offset, to: match.endOffset, insert: replace },
            selection: { anchor: caret },
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
