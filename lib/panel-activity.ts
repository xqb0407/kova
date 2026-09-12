"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useAui, type ThreadMessage } from "@assistant-ui/react";

/**
 * Agent 活动派生层：把当前线程消息流里的 tool-call parts 归并为
 * Codex 风格右侧面板（components/agent-thread/agent-panel）需要的两路数据：
 * - terminal：bash 命令流水（命令 / 输出 / 运行中 / 失败）
 * - files：edit/write 按文件聚合的变更（逐次 diff 条目 + 累计 ±行数）
 *
 * 数据源就是 runtime 消息本身：实时流（stream.ts 的 tool-input/output chunk）
 * 与历史重建（transcript.ts 回填 args/result）形状一致，刷新/切线程零成本恢复，
 * sidecar 无需新增任何协议事件。read/glob/grep/web 属查询噪音，不收录。
 *
 * 性能（性能迭代计划·迭代1）：派生为**增量**——
 * 1. 消息级缓存：assistant-ui 消息对象不可变，引用相等 ⇒ 贡献直接复用；
 *    流式期间只有最后一条消息会被替换，历史消息零重算（旧实现每个 token
 *    全量重扫 + 重跑所有 edit 的 LCS diff）。
 * 2. part 级缓存：消息被替换时逐 part 比对（args/result 字符串值相等即复用
 *    entry 与 diff 统计），文本 delta 不再牵动已完成工具调用的重算。
 * 3. 派生结果引用稳定：内容未变时返回同一 PanelActivity 对象，配合
 *    useSyncExternalStore 的 Object.is 比较，纯文本流式期间四个消费方
 *    （header 角标 / files / terminal 标签 / activity 视图）零重渲染。
 */

/** sidecar bash 失败标记：非零退出码 `\n[exit code: N]`、超时 `\n[timeout]`（同 ToolFallback 的判定） */
const FAILED_RE = /\[exit code: \d+\]|\[timeout\]/;

export type TerminalEntry = {
  toolCallId: string;
  command: string;
  /** 已完成时才有：合并后的 stdout/stderr */
  output: string | null;
  running: boolean;
  failed: boolean;
};

export type FileChangeEntry = {
  toolCallId: string;
  op: "edit" | "write";
  oldText: string | null;
  newText: string;
  running: boolean;
  failed: boolean;
  /** 失败时展示的错误输出 */
  output: string | null;
  /** 本次变更的行级统计（write 为全增） */
  added: number;
  removed: number;
};

export type FileChangeGroup = {
  path: string;
  entries: FileChangeEntry[];
  added: number;
  removed: number;
  running: boolean;
  failed: boolean;
};

export type PanelActivity = {
  terminal: TerminalEntry[];
  files: FileChangeGroup[];
  /** 面板关闭时 Header 角标用：在途未完成的收录工具数 */
  runningCount: number;
};

const EMPTY_ACTIVITY: PanelActivity = {
  terminal: [],
  files: [],
  runningCount: 0,
};

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** tool-call part 的 result（output-available 回填的字符串） */
function resultText(result: unknown): string | null {
  if (result == null) return null;
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/* ------------------------------ 行级 diff ------------------------------ */

export type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

const MAX_DIFF_CELLS = 400 * 400; // LCS 动态表预算，超限退化为"删旧增新"

/**
 * LCS 行级 diff：先掐公共前后缀，再对中段做动态规划；规模超限直接
 * 整块替换（旧全删、新全增）。edit 的 old/new 一般只有几行到几十行，够用。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix += 1;
  let suffixA = a.length;
  let suffixB = b.length;
  while (
    suffixA > prefix &&
    suffixB > prefix &&
    a[suffixA - 1] === b[suffixB - 1]
  ) {
    suffixA -= 1;
    suffixB -= 1;
  }
  const midA = a.slice(prefix, suffixA);
  const midB = b.slice(prefix, suffixB);

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i++) out.push({ kind: "ctx", text: a[i] });

  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    for (const line of midA) out.push({ kind: "del", text: line });
    for (const line of midB) out.push({ kind: "add", text: line });
  } else if (midA.length === 0 || midB.length === 0) {
    for (const line of midA) out.push({ kind: "del", text: line });
    for (const line of midB) out.push({ kind: "add", text: line });
  } else {
    // LCS DP（行号短于对侧才可能匹配；Uint32 一维表）
    const m = midA.length;
    const n = midB.length;
    const dp = new Uint32Array((m + 1) * (n + 1));
    const at = (i: number, j: number) => dp[i * (n + 1) + j];
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * (n + 1) + j] =
          midA[i] === midB[j]
            ? at(i + 1, j + 1) + 1
            : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "ctx", text: midA[i] });
        i += 1;
        j += 1;
      } else if (at(i + 1, j) >= at(i, j + 1)) {
        out.push({ kind: "del", text: midA[i] });
        i += 1;
      } else {
        out.push({ kind: "add", text: midB[j] });
        j += 1;
      }
    }
    while (i < m) out.push({ kind: "del", text: midA[i++] });
    while (j < n) out.push({ kind: "add", text: midB[j++] });
  }

  for (let k = suffixB; k < b.length; k++) out.push({ kind: "ctx", text: b[k] });
  return out;
}

/* ------------------------------ 增量派生 store ------------------------------ */

/** 单条消息的派生贡献（消息引用不变 ⇒ 直接复用） */
type MessageContribution = {
  ref: ThreadMessage;
  terminal: TerminalEntry[];
  /** 按消息序出现：path + 共享缓存的 entry 引用 */
  files: { path: string; entry: FileChangeEntry }[];
  running: number;
  /** 本消息登记的 toolCallId（缓存驱逐用） */
  toolCallIds: string[];
};

export type PanelActivityStore = {
  /** 从消息数组派生；内容未变时返回同一引用（快照稳定性所在） */
  derive(messages: readonly ThreadMessage[]): PanelActivity;
  stats(): { messages: number; parts: number };
  reset(): void;
};

/**
 * 建一个派生 store（模块级默认实例 + 测试可独立建）。
 * 缓存全部按"当前消息集合"驱逐：线程切换 = 消息 id 全换 → 旧缓存清零，
 * 不会跨线程累积。
 */
export function createPanelActivityStore(): PanelActivityStore {
  const byMessage = new Map<string, MessageContribution>();
  /** toolCallId → 内容指纹 + 派生结果（消息被替换时逐 part 命中） */
  const byToolCall = new Map<
    string,
    {
      /** bash：command + 终态指纹；edit/write：old/new/result/err 指纹 */
      a: string | null;
      b: string | null;
      c: string | null;
      err: boolean;
      /** 指纹一致 ⇒ entry 与统计直接复用（含 LCS diff 结果） */
      entry: TerminalEntry | FileChangeEntry;
    }
  >();
  let lastMessages: readonly ThreadMessage[] | null = null;
  let lastActivity: PanelActivity = EMPTY_ACTIVITY;

  /** 指纹三槽 = (旧文/命令, 新文, result)；字符串 === 为值比较 */
  function cachedTerminal(
    toolCallId: string,
    command: string,
    result: string | null,
    err: boolean,
  ): TerminalEntry {
    const hit = byToolCall.get(toolCallId);
    if (hit && hit.a === command && hit.c === result && hit.err === err) {
      return hit.entry as TerminalEntry;
    }
    const entry: TerminalEntry = {
      toolCallId,
      command,
      output: result,
      running: result === null,
      failed: err || (result !== null && FAILED_RE.test(result)),
    };
    if (hit) {
      hit.a = command;
      hit.c = result;
      hit.err = err;
      hit.entry = entry;
    } else {
      byToolCall.set(toolCallId, { a: command, b: null, c: result, err, entry });
    }
    return entry;
  }

  function cachedFile(
    toolCallId: string,
    op: "edit" | "write",
    oldText: string | null,
    newText: string,
    result: string | null,
    err: boolean,
  ): { entry: FileChangeEntry } {
    const hit = byToolCall.get(toolCallId);
    if (
      hit &&
      hit.a === oldText &&
      hit.b === newText &&
      hit.c === result &&
      hit.err === err
    ) {
      return { entry: hit.entry as FileChangeEntry };
    }
    let added = 0;
    let removed = 0;
    if (oldText !== null) {
      for (const line of diffLines(oldText, newText)) {
        if (line.kind === "add") added += 1;
        else if (line.kind === "del") removed += 1;
      }
    } else {
      added = newText.length ? newText.split("\n").length : 0;
    }
    const entry: FileChangeEntry = {
      toolCallId,
      op,
      oldText,
      newText,
      running: result === null,
      failed: err || (result !== null && FAILED_RE.test(result)),
      output: result,
      added,
      removed,
    };
    if (hit) {
      hit.a = oldText;
      hit.b = newText;
      hit.c = result;
      hit.err = err;
      hit.entry = entry;
    } else {
      byToolCall.set(toolCallId, { a: oldText, b: newText, c: result, err, entry });
    }
    return { entry };
  }

  function computeMessage(message: ThreadMessage): MessageContribution {
    const terminal: TerminalEntry[] = [];
    const files: { path: string; entry: FileChangeEntry }[] = [];
    const toolCallIds: string[] = [];
    let running = 0;
    if (message.role !== "assistant") {
      return { ref: message, terminal, files, running, toolCallIds };
    }
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      const args = (part.args ?? {}) as Record<string, unknown>;
      const result = resultText(part.result);
      const done = result !== null;
      const err = part.isError === true;
      const id = part.toolCallId;

      if (part.toolName === "bash") {
        // 流式参数未成形前（args.command 还没解析出来）不展示，避免半截命令闪烁
        const command = asString(args.command);
        if (!command) continue;
        const entry = cachedTerminal(id, command, result, err);
        terminal.push(entry);
        toolCallIds.push(id);
        if (!done) running += 1;
        continue;
      }

      if (part.toolName === "edit" || part.toolName === "write") {
        const path = asString(args.file_path);
        const newText =
          part.toolName === "edit"
            ? asString(args.new_string)
            : asString(args.content);
        if (!path || newText === null) continue;
        const oldText =
          part.toolName === "edit" ? asString(args.old_string) : null;
        const { entry } = cachedFile(id, part.toolName, oldText, newText, result, err);
        files.push({ path, entry });
        toolCallIds.push(id);
        if (!done) running += 1;
      }
    }
    return { ref: message, terminal, files, running, toolCallIds };
  }

  function groupsEqual(a: FileChangeGroup[], b: FileChangeGroup[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (
        x.path !== y.path ||
        x.added !== y.added ||
        x.removed !== y.removed ||
        x.running !== y.running ||
        x.failed !== y.failed ||
        x.entries.length !== y.entries.length
      )
        return false;
      for (let k = 0; k < x.entries.length; k++)
        if (x.entries[k] !== y.entries[k]) return false;
    }
    return true;
  }

  function derive(messages: readonly ThreadMessage[]): PanelActivity {
    // 引用未变（含非消息类 store 更新触发的 getSnapshot）⇒ 零工作直返
    if (messages === lastMessages) return lastActivity;
    lastMessages = messages;

    const terminal: TerminalEntry[] = [];
    const groupOrder: string[] = [];
    const groupEntries = new Map<string, FileChangeEntry[]>();
    let runningCount = 0;

    for (const message of messages) {
      let c = byMessage.get(message.id);
      if (!c || c.ref !== message) {
        c = computeMessage(message);
        byMessage.set(message.id, c);
      }
      for (const t of c.terminal) terminal.push(t);
      runningCount += c.running;
      for (const f of c.files) {
        let list = groupEntries.get(f.path);
        if (!list) {
          list = [];
          groupOrder.push(f.path);
          groupEntries.set(f.path, list);
        }
        list.push(f.entry);
      }
    }

    const files: FileChangeGroup[] = groupOrder.map((path) => {
      const entries = groupEntries.get(path)!;
      let added = 0;
      let removed = 0;
      let running = false;
      let failed = false;
      for (const e of entries) {
        added += e.added;
        removed += e.removed;
        if (e.running) running = true;
        if (e.failed) failed = true;
      }
      return { path, entries, added, removed, running, failed };
    });

    // 线程切换/历史替换：被移除的消息与工具调用缓存即刻驱逐，不跨线程累积
    const activeMsg = new Set(messages.map((m) => m.id));
    for (const id of [...byMessage.keys()])
      if (!activeMsg.has(id)) byMessage.delete(id);
    const activeTools = new Set<string>();
    for (const id of activeMsg) {
      const c = byMessage.get(id);
      for (const t of c?.toolCallIds ?? []) activeTools.add(t);
    }
    for (const id of [...byToolCall.keys()])
      if (!activeTools.has(id)) byToolCall.delete(id);

    // 内容未变（纯文本流式）⇒ 保持引用，消费方不重渲染
    const same =
      lastActivity.runningCount === runningCount &&
      groupsEqual(lastActivity.files, files) &&
      lastActivity.terminal.length === terminal.length &&
      lastActivity.terminal.every((e, i) => e === terminal[i]);
    if (same) return lastActivity;

    lastActivity = { terminal, files, runningCount };
    return lastActivity;
  }

  return {
    derive,
    stats: () => ({ messages: byMessage.size, parts: byToolCall.size }),
    reset: () => {
      byMessage.clear();
      byToolCall.clear();
      lastMessages = null;
      lastActivity = EMPTY_ACTIVITY;
    },
  };
}

/* ------------------------------ React 绑定 ------------------------------ */

const defaultStore = createPanelActivityStore();

/**
 * 订阅当前线程的工具活动（terminal + files）。共享模块级增量 store：
 * 四个消费方各自订阅但派生只算一次（谁先被 store 事件驱动谁摊到计算）；
 * 派生结果引用稳定时 useSyncExternalStore 按 Object.is 短路，
 * 纯文本流式期间消费方零重渲染。
 */
export function usePanelActivity(): PanelActivity {
  const aui = useAui();
  const getSnapshot = useCallback(
    () => defaultStore.derive(aui.thread.getState().messages),
    [aui],
  );
  return useSyncExternalStore(
    aui.subscribe,
    getSnapshot,
    () => EMPTY_ACTIVITY,
  );
}
