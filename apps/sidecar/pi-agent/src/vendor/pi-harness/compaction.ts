/**
 * Vendored from `@earendil-works/pi-agent-core@0.99.2`:
 *   dist/harness/compaction/compaction.js
 *   dist/harness/messages.js
 * License: MIT (see NOTICE.md in this directory).
 *
 * 1.0.0 把 experimental harness 从 pi-agent-core 移除后，Kova 仍需要这组
 * compaction 估算/切点 helper。这里保留 0.99.2 的语义（chars/4、provider
 * usage + trailing 估算），并保留 Kova 原有的 malformed block 守卫。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export type ContextUsageEstimate = {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
};

export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/** Kova 的转录行全部是 message；type 放宽只为保持上游 while-loop 语义。 */
export interface CutPointEntry {
  type: string;
  message: AgentMessage;
}

type LooseMessage = Record<string, any>;

const ESTIMATED_IMAGE_CHARS = 4800;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function calculateContextTokens(usage: Usage): number {
  const u = usage as Usage & { totalTokens?: number };
  return (
    u.totalTokens ||
    u.input + u.output + u.cacheRead + u.cacheWrite
  );
}

function getAssistantUsage(message: LooseMessage): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  const usage = message.usage as Usage | undefined;
  if (
    message.stopReason !== "aborted" &&
    message.stopReason !== "error" &&
    usage &&
    calculateContextTokens(usage) > 0
  ) {
    return usage;
  }
  return undefined;
}

function getLastAssistantUsageInfo(
  messages: readonly AgentMessage[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i] as LooseMessage);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(
  messages: readonly AgentMessage[],
): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]!);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

function estimateTextAndImageContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown } | null;
    if (block?.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    } else if (block?.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  const msg = message as LooseMessage;
  switch (msg.role) {
    case "user":
    case "custom":
    case "toolResult":
      return Math.ceil(estimateTextAndImageContentChars(msg.content) / 4);
    case "assistant": {
      let chars = 0;
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of content) {
        const block = raw as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          name?: unknown;
          arguments?: unknown;
        } | null;
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          chars += block.text.length;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          chars += block.name.length + safeJsonStringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      const command = typeof msg.command === "string" ? msg.command : "";
      const output = typeof msg.output === "string" ? msg.output : "";
      return Math.ceil((command.length + output.length) / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      const summary = typeof msg.summary === "string" ? msg.summary : "";
      return Math.ceil(summary.length / 4);
    }
    default:
      return 0;
  }
}

function findValidCutPoints(
  entries: readonly CutPointEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const role = (entry.message as LooseMessage).role;
    switch (role) {
      case "bashExecution":
      case "custom":
      case "branchSummary":
      case "compactionSummary":
      case "user":
      case "assistant":
        cutPoints.push(i);
        break;
      case "toolResult":
        break;
    }
  }
  return cutPoints;
}

function findTurnStartIndex(
  entries: readonly CutPointEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const role = (entry.message as LooseMessage).role;
    if (role === "user" || role === "bashExecution") return i;
  }
  return -1;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
  entries: readonly CutPointEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]!;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    accumulatedTokens += estimateTokens(entry.message);
    if (accumulatedTokens >= keepRecentTokens) {
      for (const candidate of cutPoints) {
        if (candidate >= i) {
          cutIndex = candidate;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry?.type === "compaction") break;
    if (prevEntry?.type === "message") break;
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage =
    cutEntry?.type === "message" &&
    (cutEntry.message as LooseMessage).role === "user";
  const turnStartIndex = isUserMessage
    ? -1
    : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}
