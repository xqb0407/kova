"use client";

import { useEffect, useSyncExternalStore } from "react";
import { piRequest, type PiResponse } from "@/lib/pi/pi-bridge";
import {
  getPiChannel,
  type SubagentActivityItem,
  type SubagentRunStatus,
} from "@/lib/pi/pi-channel";
import { getPanelTabs, openPanelTab, setActivePanelTab } from "@/lib/panels/panel-tabs";

/**
 * 子智能体运行状态 store（sidecar Task 委派的投影，面板 tab 与消息行的事实源）。
 *
 * 三条数据路（互补，任一先到都能立起条目）：
 * 1. prompt 流内 data-subagentDelegation chunk（Task 启动时发起）：
 *    toolCallId ↔ delegationId 绑定 + 元信息；刷新 attach 会回放，
 *    transport postTransform 拦截后喂 applyDelegationChunk。
 * 2. 无 id 通知行 subagent_activity（subscribeSubagentActivity，桌面通道）：
 *    delegate 的思考/正文增量、工具起止、轮次、结算终态，实时流式进 blocks。
 * 3. get_subagent_activity 快照（打开 tab 时按需拉）：刷新后补历史活动、
 *    点开已完成的委派；查无记录（sidecar 重启/被清理）置 expired。
 *
 * 历史重建（get_history）没有绑定 chunk：TaskToolUI 从结果文本解析
 * "Delegation <8位> started" 兜底，store 按 ≥4 位前缀认领条目。
 */

export type { SubagentActivityItem, SubagentRunStatus };

/** 归并后的活动块：thinking/text 增量在 store 内就地合并（数组不随 token 增长） */
export type SubagentBlock =
  | { kind: "turn"; n: number; at: number }
  /** 已发送的插入消息（SendMessage / 对话页输入；渲染成 user 气泡） */
  | { kind: "message"; text: string; at: number }
  | {
      kind: "thinking" | "text";
      id: string;
      text: string;
      done: boolean;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      argsSummary?: string;
      /** write/edit 的结构化路径（新 sidecar 提供；老记录回退 argsSummary） */
      filePath?: string;
      resultSummary?: string;
      failed?: boolean;
      done: boolean;
      at: number;
    };

export type SubagentRunState = {
  delegationId: string;
  agentName: string;
  description?: string;
  status: SubagentRunStatus;
  startedAt?: number;
  completedAt?: number;
  turns: number;
  toolCalls: number;
  /** 最终报告（status 条目 / 快照带回） */
  report?: string;
  blocks: SubagentBlock[];
  /** 快照已拉取过（成功或 expired），避免重复请求 */
  hydrated: boolean;
  /** 快照查无此委派（重启/记录被清）：面板显示过期空态 */
  expired: boolean;
  /** 终态且留有存档历史：面板输入行可 resume（running 时无关） */
  canResume: boolean;
  /** 本轮运行起点（resume 标记时间）；running 时缺省回落 startedAt */
  activeSince?: number;
};

/** 本地活动块上限（sidecar 缓冲 400；实时流再高一个量级封顶，防长任务撑爆） */
const MAX_LOCAL_BLOCKS = 1200;

const runs = new Map<string, SubagentRunState>();
/** toolCallId -> delegationId（data-subagentDelegation 绑定） */
const bindings = new Map<string, string>();
const listeners = new Set<() => void>();
const hydrating = new Set<string>();
/**
 * 产物卡只关心“有没有新的 write/edit 完成”，不关心思考/正文逐 token 增量。
 * 因此单独维护 artifactVersion：tool end 与结算时 +1，增量不 +1。
 * notify 仍然逐条广播，但 useSyncExternalStore 发现快照没变就不会重渲。
 */
let artifactVersion = 0;

function notify() {
  for (const l of listeners) l();
}

/** 外部（产物卡）订阅子代理活动；返回退订函数 */
export function subscribeSubagentRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSubagentArtifactVersion(): number {
  return artifactVersion;
}

/** 子代理产物版本（useSyncExternalStore）；后台委派晚完成时产物卡能补上。 */
export function useSubagentArtifactVersion(): number {
  return useSyncExternalStore(
    subscribeSubagentRuns,
    getSubagentArtifactVersion,
    () => 0,
  );
}

/**
 * 子代理写出的交付路径：只取已完成的 write/edit 工具块。
 * 优先用 sidecar 的结构化 filePath（新记录）；老记录回退从 argsSummary 提取
 * （write/edit 的首个参数就是 file_path）。是否交付物、是否存在由产物派生层再校验。
 */
export function getSubagentArtifactPaths(toolCallId: string): string[] {
  const run = getSubagentRun(bindings.get(toolCallId));
  if (!run) return [];
  const paths: string[] = [];
  for (const block of run.blocks) {
    if (block.kind !== "tool") continue;
    if (!block.done || block.failed) continue;
    if (block.toolName !== "write" && block.toolName !== "edit") continue;
    const path = block.filePath?.trim() || block.argsSummary?.trim();
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

function defaultState(delegationId: string): SubagentRunState {
  return {
    delegationId,
    agentName: "",
    status: "running",
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    blocks: [],
    hydrated: false,
    expired: false,
    canResume: false,
  };
}

/** 浅拷贝更新（useSyncExternalStore 快照要求引用不可变） */
function updateRun(
  delegationId: string,
  mutate: (draft: SubagentRunState) => void,
): void {
  const cur = runs.get(delegationId) ?? defaultState(delegationId);
  const next: SubagentRunState = { ...cur, blocks: [...cur.blocks] };
  mutate(next);
  runs.set(delegationId, next);
  notify();
}

/** 把一条归一化活动条目并进 blocks（live 通知与快照回放共用同一 reducer） */
function applyItemTo(draft: SubagentRunState, item: SubagentActivityItem): void {
  // 有活动 = 记录真实存在：快照瞬时失败（sidecar 离线）后靠直播自愈
  draft.expired = false;
  switch (item.kind) {
    case "turn": {
      draft.turns = Math.max(draft.turns, item.n);
      draft.blocks.push({ kind: "turn", n: item.n, at: item.at });
      break;
    }
    case "thinking":
    case "text": {
      const blocks = draft.blocks;
      if (item.op === "start") {
        blocks.push({
          kind: item.kind,
          id: item.id,
          text: "",
          done: false,
          startedAt: item.at,
        });
      } else if (item.op === "delta") {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === item.kind && b.id === item.id && !b.done) {
            blocks[i] = { ...b, text: b.text + (item.delta ?? "") };
            break;
          }
        }
        // 找不到开放块（start 丢了）：以 delta 直接起一块
        if (!blocks.some((b) => b.kind === item.kind && b.id === item.id)) {
          blocks.push({
            kind: item.kind,
            id: item.id,
            text: item.delta ?? "",
            done: false,
            startedAt: item.at,
          });
        }
      } else {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === item.kind && b.id === item.id && !b.done) {
            blocks[i] = { ...b, done: true, endedAt: item.at };
            break;
          }
        }
      }
      break;
    }
    case "tool": {
      const blocks = draft.blocks;
      if (item.op === "start") {
        // 实时计数（live 行显示用）；status 终态条目与快照会以权威值覆盖
        draft.toolCalls += 1;
        blocks.push({
          kind: "tool",
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          argsSummary: item.argsSummary,
          ...(item.filePath ? { filePath: item.filePath } : {}),
          done: false,
          at: item.at,
        });
      } else {
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]!;
          if (b.kind === "tool" && b.toolCallId === item.toolCallId) {
            blocks[i] = {
              ...b,
              resultSummary: item.resultSummary,
              failed: item.failed,
              done: true,
            };
            break;
          }
        }
        // 只有工具结束才可能新增可交付路径（write/edit 的 argsSummary）。
        artifactVersion += 1;
      }
      break;
    }
    case "status": {
      draft.status = item.status;
      draft.turns = item.turns;
      draft.toolCalls = item.toolCalls;
      if (item.status === "running") {
        // resume 开始标记：本轮计时从此刻起，上一轮的终态报告必须清掉，
        // 否则中断后 buildSubagentTranscript 会把旧报告当成这一轮的结果。
        draft.completedAt = undefined;
        draft.activeSince = item.at;
        draft.canResume = false;
        draft.report = undefined;
      } else {
        draft.completedAt = item.at;
        draft.activeSince = undefined;
        // 旧 sidecar 没有这个字段：不覆盖快照记录给出的 canResume（快照是
        // 权威值）；缺失时保持原值，避免把有历史的老记录误标成不可续聊。
        if (item.canResume !== undefined) draft.canResume = item.canResume;
        // 终态报告以本条为准（失败/中止轮没有报告，不能留上一轮的）
        draft.report = item.report;
      }
      artifactVersion += 1;
      break;
    }
    case "message": {
      // 本地发送的乐观插入由 sendSubagentMessage 的 pending 集合去重：
      // 广播先到则跳过（乐观插入已在），本地后发则插入。
      if (isPendingSentMessage(draft.delegationId, item.text)) break;
      draft.blocks.push({ kind: "message", text: item.text, at: item.at });
      break;
    }
  }
  if (draft.blocks.length > MAX_LOCAL_BLOCKS) {
    draft.blocks.splice(0, draft.blocks.length - MAX_LOCAL_BLOCKS);
  }
}

/** transport postTransform 拦截 data-subagentDelegation（旁路 chunk 不进消息流） */
export function applyDelegationChunk(data: unknown): void {
  const d = data as {
    toolCallId?: unknown;
    delegationId?: unknown;
    agentName?: unknown;
    description?: unknown;
  };
  if (typeof d?.toolCallId !== "string" || typeof d?.delegationId !== "string") return;
  bindings.set(d.toolCallId, d.delegationId);
  const agentName = typeof d.agentName === "string" ? d.agentName : "";
  const description = typeof d.description === "string" ? d.description : undefined;
  updateRun(d.delegationId, (draft) => {
    if (agentName) draft.agentName = agentName;
    if (description) draft.description = description;
  });
}

/** 历史重建兜底：Task 结果文本里的 8 位短 id（"Delegation abc12345 started"） */
export function parseDelegationIdFromResult(text: string): string | undefined {
  return /Delegation ([0-9a-f]{8}) started/.exec(text)?.[1];
}

/** 完整 id 直查；≥4 位前缀在已知条目里找唯一匹配（与 sidecar findDelegation 同语义） */
export function resolveDelegationId(idOrPrefix: string | undefined): string | undefined {
  if (!idOrPrefix) return undefined;
  if (runs.has(idOrPrefix)) return idOrPrefix;
  if (idOrPrefix.length < 4) return undefined;
  let found: string | undefined;
  for (const id of runs.keys()) {
    if (id.startsWith(idOrPrefix)) {
      if (found) return undefined; // 歧义前缀不猜
      found = id;
    }
  }
  return found;
}

export function getSubagentRun(idOrPrefix: string | undefined): SubagentRunState | undefined {
  const id = resolveDelegationId(idOrPrefix);
  return id ? runs.get(id) : undefined;
}

export function getSubagentRunByToolCall(toolCallId: string): SubagentRunState | undefined {
  return getSubagentRun(bindings.get(toolCallId));
}

/** binding 反查：delegationId → toolCallId（面板据此在主会话消息流里定位那条 Task 工具行，
 *  取它的 args.task 作为"派活说明"）。无绑定时返回 undefined，调用方回退按结果文本匹配 */
export function toolCallIdForDelegation(idOrPrefix: string): string | undefined {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  for (const [toolCallId, delegationId] of bindings) {
    if (delegationId === id) return toolCallId;
  }
  return undefined;
}

/**
 * 快照水合（幂等，防并发重入）：打开 tab / 只见到活动没见到绑定时调用。
 * meta 以快照为准（权威）；blocks 本地已有则不覆盖（live 尾随在前）。
 */
export async function hydrateSubagentSnapshot(idOrPrefix: string): Promise<void> {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  if (runs.get(id)?.hydrated || hydrating.has(id)) return;
  hydrating.add(id);
  try {
    const res = await piRequest<
      Extract<PiResponse, { type: "subagent_activity_snapshot" }>
    >({ type: "get_subagent_activity", delegationId: id });
    // 规范键迁移：前缀/短 id 查询建的别名条目并回全量 id 名下——否则后续
    // 按完整 delegationId 广播的活动会另立门户，别名 tab 收不到增量尾巴
    const canonical = res.record.delegationId || id;
    if (canonical !== id) {
      const alias = runs.get(id);
      runs.delete(id);
      if (alias) {
        const cur = runs.get(canonical);
        runs.set(canonical, {
          ...cur,
          delegationId: canonical,
          agentName: cur?.agentName || alias.agentName,
          description: cur?.description ?? alias.description,
          blocks: cur?.blocks.length ? cur.blocks : alias.blocks,
          startedAt: cur?.startedAt ?? alias.startedAt,
          status: cur && cur.status !== "running" ? cur.status : alias.status,
          completedAt: cur?.completedAt ?? alias.completedAt,
          turns: Math.max(cur?.turns ?? 0, alias.turns),
          toolCalls: Math.max(cur?.toolCalls ?? 0, alias.toolCalls),
          report: cur?.report ?? alias.report,
          hydrated: false, // 快照载荷随即写入正式条目
          expired: false,
          canResume: cur?.canResume ?? alias.canResume,
          activeSince: cur?.activeSince ?? alias.activeSince,
        });
      }
    }
    updateRun(canonical, (draft) => {
      draft.agentName = res.record.agentName || draft.agentName;
      draft.description = res.record.description ?? draft.description;
      draft.status = res.record.status as SubagentRunStatus;
      draft.startedAt = res.record.startedAt;
      draft.completedAt = res.record.completedAt;
      draft.turns = res.record.turns;
      draft.toolCalls = res.record.toolCalls;
      // 快照记录是权威：报告缺失（中断/失败）时必须清掉内存里的旧报告
      draft.report = res.record.report;
      draft.canResume =
        res.record.status !== "running" && res.record.canResume === true;
      draft.activeSince =
        res.record.status === "running" ? res.record.activeSince : undefined;
      if (draft.blocks.length === 0) {
        for (const item of res.items as SubagentActivityItem[]) {
          applyItemTo(draft, item);
        }
      }
      draft.hydrated = true;
    });
  } catch {
    // 查无记录（sidecar 重启/被清理）或旧 sidecar 无此命令：标记过期，不再重试
    updateRun(id, (draft) => {
      draft.hydrated = true;
      draft.expired = true;
    });
  } finally {
    hydrating.delete(id);
  }
}

let watchStarted = false;

/** 幂等启动活动通知订阅（首个 Task 行/面板 tab 挂载时触发；WS 通道无能力则空转） */
export function startSubagentRunsWatch(): void {
  if (watchStarted) return;
  const channel = getPiChannel();
  if (!channel.subscribeSubagentActivity) return;
  watchStarted = true;
  void (async () => {
    const teardown = await channel.subscribeSubagentActivity!((delegationId, item) => {
      if (!runs.has(delegationId)) {
        // 没赶上绑定 chunk（别的窗口启动的委派）：立条目并拉快照补 meta
        runs.set(delegationId, defaultState(delegationId));
        void hydrateSubagentSnapshot(delegationId);
      }
      updateRun(delegationId, (draft) => applyItemTo(draft, item));
    });
    void teardown; // 与页面同生命周期，不退订
  })();
}

/** 打开（或激活）该委派的「子智能体」面板 tab：一个委派一个 tab，支持并行多开 */
export function openSubagentTab(idOrPrefix: string, title?: string): void {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  const { tabs } = getPanelTabs();
  const existing = tabs.find((t) => t.type === "subagent" && t.delegationId === id);
  if (existing) {
    setActivePanelTab(existing.id);
  } else {
    openPanelTab("subagent", { delegationId: id, title });
  }
  // 面板收起时唤起（同 tool-panel 的入口行为）
  window.dispatchEvent(new Event("agent-panel:open"));
}

/**
 * 对话页给委派发消息：running=插话（下个模型边界消费）、finished=resume 续聊。
 * 发送前先乐观插 message 块（保证时间线顺序）；sidecar 的 activity 广播到达时
 * 跳过同一条。去重窗口必须覆盖到广播晚于响应的情形：应答先到不能立刻清占位，
 * 否则随后到达的广播会再插一条（重复气泡）。占位由广播消费或 TTL 清理。
 */
type PendingSent = { text: string };
const PENDING_SENT_TTL_MS = 15_000;
const pendingSent = new Map<string, PendingSent[]>();

function addPendingSent(id: string, text: string): PendingSent {
  const entry: PendingSent = { text };
  const queue = pendingSent.get(id) ?? [];
  queue.push(entry);
  pendingSent.set(id, queue);
  const timer = setTimeout(() => removePendingSent(id, entry), PENDING_SENT_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
  return entry;
}

function removePendingSent(id: string, entry: PendingSent): void {
  const queue = pendingSent.get(id);
  if (!queue) return;
  const index = queue.indexOf(entry);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) pendingSent.delete(id);
}

export async function sendSubagentMessage(
  idOrPrefix: string,
  text: string,
): Promise<{ ok: boolean; resumed: boolean }> {
  const id = resolveDelegationId(idOrPrefix) ?? idOrPrefix;
  const body = text.trim();
  if (!body) return { ok: false, resumed: false };
  // 气泡在发请求前就插入：广播先到时不能被"跳过"到响应之后才上屏，
  // 否则它会被排进子智能体已经开始的输出后面（时间线倒序）。
  const at = Date.now();
  updateRun(id, (draft) => {
    draft.blocks.push({ kind: "message", text: body, at });
  });
  const entry = addPendingSent(id, body);
  try {
    const res = await piRequest<
      Extract<PiResponse, { type: "subagent_message_sent" }>
    >({ type: "send_subagent_message", delegationId: id, text: body });
    const target = res.delegationId || id;
    if (res.resumed) {
      updateRun(target, (draft) => {
        draft.status = "running";
        // 上一轮的终态不能带进新一轮：header 计时/输入行都按 running 走
        draft.completedAt = undefined;
        draft.canResume = false;
        draft.activeSince = at;
        draft.report = undefined;
      });
    }
    return { ok: res.ok, resumed: res.resumed };
  } catch (err) {
    // 请求失败：撤回乐观气泡与占位，错误交给输入行展示
    removePendingSent(id, entry);
    updateRun(id, (draft) => {
      for (let i = draft.blocks.length - 1; i >= 0; i--) {
        const block = draft.blocks[i]!;
        if (block.kind === "message" && block.text === body && block.at === at) {
          draft.blocks.splice(i, 1);
          break;
        }
      }
    });
    throw err;
  }
}

/**
 * 广播到的 message 条目是否是本地刚发的（乐观期去重）。
 * 队列语义：命中即消费一条——同文本连发两次时两条广播各认领各的占位。
 */
export function isPendingSentMessage(delegationId: string, text: string): boolean {
  const queue = pendingSent.get(delegationId);
  if (!queue?.length) return false;
  const index = queue.findIndex((entry) => entry.text === text);
  if (index < 0) return false;
  queue.splice(index, 1);
  if (queue.length === 0) pendingSent.delete(delegationId);
  return true;
}

/** 运行秒数（running 取当下，结算取 completedAt）；无 startedAt 返回 0 */
export function subagentElapsedSeconds(
  run: SubagentRunState | undefined,
  now: number = Date.now(),
): number {
  if (!run?.startedAt) return 0;
  // resume 轮从本轮标记起算；终态仍用原始 startedAt 算总时长
  const start = run.status === "running" ? (run.activeSince ?? run.startedAt) : run.startedAt;
  const end = run.status === "running" ? now : (run.completedAt ?? now);
  return Math.max(0, Math.round((end - start) / 1000));
}

function subscribeRuns(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 消息行 hook：toolCallId → 绑定的委派条目 */
export function useSubagentRunByToolCall(toolCallId: string): SubagentRunState | undefined {
  useEffect(() => {
    startSubagentRunsWatch();
  }, []);
  return useSyncExternalStore(
    subscribeRuns,
    () => getSubagentRunByToolCall(toolCallId),
    () => undefined,
  );
}

/** 面板 tab hook：按 id/前缀取条目；条目未立起或没赶上活动流时拉快照补水合 */
export function useSubagentRun(idOrPrefix: string | undefined): SubagentRunState | undefined {
  useEffect(() => {
    startSubagentRunsWatch();
    if (idOrPrefix) void hydrateSubagentSnapshot(idOrPrefix);
  }, [idOrPrefix]);
  return useSyncExternalStore(
    subscribeRuns,
    () => getSubagentRun(idOrPrefix),
    () => undefined,
  );
}
