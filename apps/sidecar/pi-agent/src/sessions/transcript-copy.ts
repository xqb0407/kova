/**
 * 会话转录复制（分支会话 fork_session / 划词辅助会话 create_side_session 共用）。
 *
 * 规则与 fork 原有行为逐条一致：header 行不拷、撕裂尾行丢弃、未知行型不拷；
 * turn_timing 行不占 seq，按锚点是否落在分叉点内单独带上；数据行原样保留
 * seq——seq 是文件内编号空间，跨会话不冲突。
 *
 * hidden=true 时（辅助会话）给 message/compaction 行加行级 hidden 标记并把
 * ui 置空：模型上下文照常读取 agent 行，UI 投影（thread_snapshot/get_history）
 * 跳过。写入前仍走同一套 artifact 收养与回执路径改写。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  isAutoContinueMessage,
  isCapabilityReminderMessage,
  isGoalInternalMessage,
  isSubagentReportMessage,
} from "pi-protocol";
import { sessionPath } from "../storage/storage";
import {
  adoptSessionArtifacts,
  collectArtifactReferences,
  removeSessionArtifacts,
  rewriteArtifactReferences,
} from "./artifact-store";
import { readTranscriptHeaderRemote } from "./transcript";

export type TranscriptCopyOptions = {
  sourceSessionId: string;
  /** 位置分叉：只复制该转录 seq 及之前的行（同回合收尾行由复制逻辑延展带上） */
  upToSeq?: number;
  /** 辅助会话：复制行标成 hidden（模型可见、UI 不显示），ui 置空 */
  hidden?: boolean;
};

export type TranscriptCopyResult = {
  newId: string;
  /** 已改写 artifact 路径、可直接写入新转录的 JSONL 行（不含 header） */
  lines: string[];
  /** 实际复制的消息行数（索引计数用） */
  messageCount: number;
  /** 复制行里的最大 seq（无消息行时 undefined；边界提醒取 maxSeq + 1） */
  maxSeq?: number;
  remote: ReturnType<typeof readTranscriptHeaderRemote>;
};

/** 辅助会话继承上下文后追加的边界提醒（模型可见、UI 隐藏）。 */
export const SIDE_CHAT_BOUNDARY_TEXT = [
  "The preceding conversation was inherited from the parent task for reference only.",
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  "Modify the workspace only when the user explicitly asks you to do so in this side chat.",
].join(" ");

/**
 * 复制源会话转录到全新 sessionId。调用方负责写 header、插索引行与清理失败现场。
 */
export async function copyTranscriptForBranch(
  options: TranscriptCopyOptions,
): Promise<TranscriptCopyResult> {
  const { sourceSessionId, hidden } = options;
  const sourceFile = sessionPath(sourceSessionId);
  if (!existsSync(sourceFile)) {
    throw new Error(`transcript not found: ${sourceSessionId}`);
  }
  const upToSeq = options.upToSeq;
  const dataLines: string[] = [];
  let messageCount = 0;
  let maxSeq: number | undefined;
  let afterAnchor = false;
  // 先定新 id：artifact 收养要在写转录前完成（回执路径要改写成新目录）
  const newId = randomUUID();
  const artifactRefs = new Set<string>();
  for (const line of readFileSync(sourceFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: { type?: string; seq?: number; agent?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || row.type === "header") continue;
    // 轮工时行不占 seq：按锚点（轮首 user 行）是否落在分叉点内决定是否带走。
    // 不带走的话分支会话的历史轮只能回落时间戳推导（中止轮还会缺结束时刻）。
    if (row.type === "turn_timing") {
      const anchor = (row as { anchorSeq?: unknown }).anchorSeq;
      if (
        typeof anchor === "number" &&
        (upToSeq === undefined || anchor <= upToSeq)
      ) {
        dataLines.push(line);
      }
      continue;
    }
    if (typeof row.seq !== "number") continue;
    if (upToSeq !== undefined && row.seq > upToSeq) {
      if (afterAnchor) continue;
      // 每条消息行都带 agent（模型面原文，user 行也不例外，见 persist），
      // 「真正的用户输入」这一界标只能按 agent.role 判定
      const payload =
        row.type === "message"
          ? (row.agent as { role?: string } | undefined)
          : undefined;
      const sameRunTail =
        !!payload &&
        (payload.role !== "user" ||
          isAutoContinueMessage(payload) ||
          isGoalInternalMessage(payload) ||
          isCapabilityReminderMessage(payload) ||
          isSubagentReportMessage(payload));
      if (!sameRunTail) {
        afterAnchor = true;
        continue;
      }
      if (row.type === "message") {
        collectArtifactReferences(row.agent, artifactRefs);
        messageCount += 1;
        maxSeq = maxSeq === undefined ? row.seq : Math.max(maxSeq, row.seq);
      }
      dataLines.push(line);
      continue;
    }
    if (row.type === "message") {
      if (!row.agent) continue;
      collectArtifactReferences(row.agent, artifactRefs);
      messageCount += 1;
      maxSeq = maxSeq === undefined ? row.seq : Math.max(maxSeq, row.seq);
    } else if (row.type === "compaction") {
      // 压缩摘要也会随分叉复制：摘要里的回执路径同样要收养/改写，
      // 否则父会话淘汰后，分叉里摘要引用的 artifact 就不可读了。
      const summary = (row as { summary?: unknown }).summary;
      if (typeof summary === "string") {
        collectArtifactReferences(summary, artifactRefs);
      }
      maxSeq = maxSeq === undefined ? row.seq : Math.max(maxSeq, row.seq);
    } else {
      continue;
    }
    dataLines.push(line);
  }
  // artifact 收养：硬链被引用的文件到新会话目录，并把复制行里的回执路径
  // 改写过去（父会话删除/淘汰后分叉仍可读）。文件已不存在时保留原路径。
  const artifactMapping = await adoptSessionArtifacts({
    sourceSessionId,
    targetSessionId: newId,
    references: artifactRefs,
  });
  const rewritten = rewriteArtifactReferences(dataLines, artifactMapping);
  const lines = hidden
    ? rewritten.map((line) => {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (row.type === "message" || row.type === "compaction") {
            row.hidden = true;
            if (row.type === "message") row.ui = null;
          }
          return JSON.stringify(row);
        } catch {
          return line;
        }
      })
    : rewritten;
  return {
    newId,
    lines,
    messageCount,
    ...(maxSeq !== undefined ? { maxSeq } : {}),
    remote: readTranscriptHeaderRemote(sourceSessionId),
  };
}

/** 写入复制后的转录文件（header + body）。写失败时清理已收养的 artifact 目录。 */
export async function writeCopiedTranscript(
  newId: string,
  header: Record<string, unknown>,
  lines: readonly string[],
): Promise<void> {
  try {
    writeFileSync(
      sessionPath(newId),
      JSON.stringify(header) + "\n" + (lines.length ? lines.join("\n") + "\n" : ""),
    );
  } catch (error) {
    // 收养已把文件链进新会话目录；写转录失败时清掉，避免留下无主目录
    await removeSessionArtifacts(newId).catch(() => undefined);
    throw error;
  }
}
