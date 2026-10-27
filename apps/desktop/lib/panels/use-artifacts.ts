"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuiState, type ThreadMessage } from "@assistant-ui/react";
import {
  collectTurnArtifactCandidates,
  finalizeArtifactCandidates,
  mergeArtifactCandidates,
  resolveTurnStartMs,
  type ArtifactCandidate,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import { statArtifactPaths } from "@/lib/panels/artifact-stats";
import {
  useCheckpointArtifactCandidates,
  type CheckpointArtifactRequest,
} from "@/lib/panels/use-checkpoint-artifacts";
import { getTurnIndex, getTurnParts } from "@/lib/panels/message-turns";
import { useRunCheckpoints } from "@/lib/pi/pi-checkpoints";
import {
  getSubagentArtifactPaths,
  useSubagentArtifactVersion,
} from "@/lib/subagent/subagent-runs";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 候选 → Host stat → 最终列表。
 * stat 前不渲染（避免卡片先闪一批再被替换）；没有 Host stat 的环境
 * （web/dev-preview）由 finalize 走“不校验、只保留 write/edit/子代理”的降级。
 */
export function useResolvedArtifacts(
  candidates: readonly ArtifactCandidate[],
  cwd: string | null,
  options: { visibleLimit?: number } = {},
): { artifacts: MessageArtifact[]; settled: boolean } {
  const visibleLimit = options.visibleLimit;
  const key = useMemo(
    () =>
      JSON.stringify(
        candidates.map((candidate) => [
          candidate.absPath,
          candidate.source,
          candidate.order.toFixed(3),
        ]),
      ),
    [candidates],
  );
  const [state, setState] = useState<{
    key: string;
    signature: string;
    artifacts: MessageArtifact[];
  } | null>(null);
  // 候选数组的**身份**在父组件每次渲染都会换（依赖链上游是流式消息），effect
  // 若把它放进依赖，就会与 tap store 的 forceStoreRerender 泵叠成嵌套更新
  //（Maximum update depth，2026-10-27 主区崩溃）。effect 只认内容 key：
  // 身份变化不重跑；key 变化 = 内容真变了，此时 ref 里的就是最新候选。
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  useEffect(() => {
    let cancelled = false;
    const candidates = candidatesRef.current;
    const publish = (artifacts: MessageArtifact[]) => {
      // 其他轮流式时 messages 数组换身份会让已完成轮重跑本 effect；最终列表
      // 没变化时用相同 state 引用 bailout，避免每个 token 重渲一次产物卡。
      const signature = JSON.stringify(
        artifacts.map((artifact) => [
          artifact.absPath,
          artifact.source,
          artifact.size,
          artifact.openMode,
        ]),
      );
      setState((previous) =>
        previous?.key === key && previous?.signature === signature
          ? previous
          : { key, signature, artifacts },
      );
    };
    if (!cwd || candidates.length === 0) {
      publish([]);
      return;
    }
    void statArtifactPaths(
      cwd,
      candidates.map((candidate) => candidate.absPath),
    ).then(
      (stats) => {
        if (cancelled) return;
        publish(
          finalizeArtifactCandidates(candidates, stats, {
            turnStartMs: 0,
            ...(visibleLimit !== undefined ? { visibleLimit } : {}),
          }),
        );
      },
      () => {
        if (!cancelled) publish([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // candidates 走 ref（见上）：key 已编码全部内容，身份变化不重跑是有意为之
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, key, visibleLimit]);

  if (!state || state.key !== key) return { artifacts: [], settled: false };
  return { artifacts: state.artifacts, settled: true };
}

/**
 * 会话级产物：逐轮跑同一套候选（write/edit/子代理/正文引用），再按路径
 * 跨轮去重。order 用「轮序号 × 1e6 + 轮内顺序」编码，最新轮/最新产物在前。
 * 产物页签用它替换旧的 write-only 汇总。
 */
export function useThreadArtifacts(
  messages: readonly ThreadMessage[],
  cwd: string | null,
): { artifacts: MessageArtifact[]; settled: boolean } {
  const subagentVersion = useSubagentArtifactVersion();
  // 流式期间 messages 每个 token 换新身份；产物页签不需要逐 token 重扫全线程，
  // 用进入运行前的快照，run 结束后再整体重算一次。
  const running = useAuiState((s) => s.thread.isRunning);
  const scanMessagesRef = useRef(messages);
  useEffect(() => {
    if (!running) scanMessagesRef.current = messages;
  }, [messages, running]);
  const scanMessages = running ? scanMessagesRef.current : messages;
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const checkpoints = useRunCheckpoints(threadId ?? undefined);
  const checkpointRequests = useMemo<CheckpointArtifactRequest[]>(() => {
    if (!cwd || checkpoints.length === 0) return [];
    const index = getTurnIndex(scanMessages);
    // 稳定 id（pi-msg:<seq>）优先匹配，跨 compaction/截断等列表变化不漂移；
    // 老条目没有 id，回落渲染下标
    const byId = new Map<string, (typeof checkpoints)[number]>();
    const byAnchor = new Map<number, (typeof checkpoints)[number]>();
    for (const entry of checkpoints) {
      if (entry.anchorMessageId) byId.set(entry.anchorMessageId, entry);
      else if (entry.anchorIndex != null) byAnchor.set(entry.anchorIndex, entry);
    }
    const requests: CheckpointArtifactRequest[] = [];
    index.turns.forEach((turn, turnIndex) => {
      const startMessage = scanMessages[turn.start];
      const entry =
        (startMessage?.role === "user"
          ? byId.get(String(startMessage.id))
          : undefined) ?? byAnchor.get(turn.start);
      if (!entry) return;
      requests.push({
        hash: entry.hash,
        turnStartMs: resolveTurnStartMs(scanMessages, turn.start, 0),
        orderBase: turnIndex * 1_000_000 + 999_999,
      });
    });
    return requests;
  }, [scanMessages, checkpoints, cwd]);
  const checkpointCandidates = useCheckpointArtifactCandidates(
    cwd,
    checkpointRequests,
  );

  const candidates = useMemo(() => {
    if (!cwd) return [];
    const index = getTurnIndex(scanMessages);
    const all: ArtifactCandidate[] = [];
    index.turns.forEach((turn, turnIndex) => {
      const parts = getTurnParts(scanMessages, turn.key);
      if (!parts.length) return;
      const subagentPaths = new Map<string, string[]>();
      for (const part of parts) {
        if (part.type !== "tool-call" || part.toolName !== "Task") continue;
        const paths = getSubagentArtifactPaths(part.toolCallId);
        if (paths.length > 0) subagentPaths.set(part.toolCallId, paths);
      }
      const turnStartMs = resolveTurnStartMs(scanMessages, turn.start, 0);
      const list = collectTurnArtifactCandidates({
        parts,
        cwd,
        turnStartMs,
        subagentPaths,
        includeTextReferences: isDesktop(),
      });
      for (const candidate of list) {
        all.push({
          ...candidate,
          order: turnIndex * 1_000_000 + candidate.order,
        });
      }
    });
    // 会话级清单允许更多条目；stat 仍按 20 一批分块。
    return mergeArtifactCandidates(
      [...all, ...checkpointCandidates],
      60,
    );
  }, [scanMessages, cwd, subagentVersion, checkpointCandidates]);
  return useResolvedArtifacts(candidates, cwd, { visibleLimit: 60 });
}
