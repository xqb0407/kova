"use client";

import { useMemo } from "react";
import { useAuiState, type ThreadMessage } from "@assistant-ui/react";

/**
 * Agent 活动派生层：把当前线程消息流里的 tool-call parts 归并为
 * Codex 风格右侧面板（components/agent-thread/agent-panel）需要的两路数据：
 * - terminal：bash 命令流水（命令 / 输出 / 运行中 / 失败）
 * - files：edit/write 按文件聚合的变更（逐次 diff 条目 + 累计 ±行数）
 *
 * 数据源就是 runtime 消息本身：实时流（stream.ts 的 tool-input/output chunk）
 * 与历史重建（transcript.ts 回填 args/result）形状一致，刷新/切线程零成本恢复，
 * sidecar 无需新增任何协议事件。read/glob/grep/web 属查询噪音，不收录。
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

/* ------------------------------ 消息扫描 ------------------------------ */

function collect(messages: readonly ThreadMessage[]): PanelActivity {
  const terminal: TerminalEntry[] = [];
  const fileGroups = new Map<string, FileChangeGroup>();
  let runningCount = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      const args = (part.args ?? {}) as Record<string, unknown>;
      const result = resultText(part.result);
      const done = result !== null;
      const failed =
        part.isError === true || (result !== null && FAILED_RE.test(result));

      if (part.toolName === "bash") {
        // 流式参数未成形前（args.command 还没解析出来）不展示，避免半截命令闪烁
        const command = asString(args.command);
        if (!command) continue;
        terminal.push({
          toolCallId: part.toolCallId,
          command,
          output: result,
          running: !done,
          failed,
        });
        if (!done) runningCount += 1;
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
        let group = fileGroups.get(path);
        if (!group) {
          group = {
            path,
            entries: [],
            added: 0,
            removed: 0,
            running: false,
            failed: false,
          };
          fileGroups.set(path, group);
        }
        group.entries.push({
          toolCallId: part.toolCallId,
          op: part.toolName === "edit" ? "edit" : "write",
          oldText,
          newText,
          running: !done,
          failed,
          output: result,
          added,
          removed,
        });
        group.added += added;
        group.removed += removed;
        group.running ||= !done;
        group.failed ||= failed;
        if (!done) runningCount += 1;
      }
    }
  }

  return {
    terminal,
    files: [...fileGroups.values()],
    runningCount,
  };
}

/**
 * 订阅当前线程的工具活动（terminal + files）。整体在 useMemo 里重算，
 * 依赖 messages 引用；单测线程消息量级小，逐 token 重扫可接受。
 */
export function usePanelActivity(): PanelActivity {
  const messages = useAuiState((s) => s.thread.messages);
  return useMemo(
    () => (messages.length ? collect(messages) : EMPTY_ACTIVITY),
    [messages],
  );
}
