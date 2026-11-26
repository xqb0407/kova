"use client";

import { useSyncExternalStore } from "react";
import type {
  InboxActionResponse,
  InboxChangedFrame,
  InboxCounts,
  InboxDetail,
  InboxFilter,
  InboxItem,
  InboxItemResponse,
  InboxResponse,
  InboxUpdateResponse,
} from "pi-protocol";
import { getPiChannel } from "@/lib/pi/pi-channel";
import type { InboxViewTab } from "./inbox-groups";

/**
 * Inbox 应答类型不在全局 PiResponse 联合里：looseObject 的索引签名会让
 * `res.type === "running"` 等既有收窄退化。这里走通道原语并在出口收窄。
 */
class InboxRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "InboxRequestError";
  }
}

async function inboxRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await getPiChannel().request(payload);
  if (response.type === "error") {
    const code = (response as { error?: { code?: string } }).error?.code;
    throw new InboxRequestError(response.errorText, code);
  }
  return response as unknown as T;
}

/**
 * Inbox 前端镜像 store（docs/agent-inbox.md §8）。
 *
 * 事实源在 sidecar：列表用 list_inbox 拉取，变更用 inbox_changed 徽标直更 +
 * 防抖重拉。这里不按 diff 打补丁，避免多端竞态下把已结算条目又画回来；
 * 操作成功后统一以服务端应答/重拉为准。
 */

export type InboxSnapshot = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  items: InboxItem[];
  counts: InboxCounts;
  /** 服务端全量来源 facets；旧 sidecar 无此字段时前端从 items 兜底 */
  sources: string[];
  filter: InboxFilter;
  nextCursor?: string;
  detail: InboxDetail | null;
  detailItemId: string | null;
  detailLoading: boolean;
  detailError: string | null;
};

const EMPTY_COUNTS: InboxCounts = {
  needsAction: 0,
  unread: 0,
  attention: 0,
  open: 0,
  done: 0,
  archived: 0,
};

const EMPTY: InboxSnapshot = {
  loaded: false,
  loading: false,
  error: null,
  items: [],
  counts: EMPTY_COUNTS,
  sources: [],
  // 页面默认落在「待关注」：服务端按该 Tab 分页，历史条目不再挤占第一页
  filter: { tab: "attention" },
  detail: null,
  detailItemId: null,
  detailLoading: false,
  detailError: null,
};

let current: InboxSnapshot = EMPTY;
const listeners = new Set<() => void>();

/** 请求世代：丢弃早于最近一次筛选/刷新发单的旧应答 */
let issueSeq = 0;
let inflight = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;
let unsubscribeChannel: (() => void) | null = null;
let unsubscribeRestart: (() => void) | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function setSnapshot(next: InboxSnapshot) {
  current = next;
  emit();
}

/**
 * 旧世代应答退场。注意不能只 `return`：旧请求返回时新请求可能已经结束，
 * 它的 `loading: inflight > 0` 记的是“还有旧请求在飞”= true；旧请求再悄悄
 * 返回就没人把 loading 收掉了——刷新按钮/加载更多会永久转圈。
 */
function dropStaleResponse(seq: number): boolean {
  if (seq === issueSeq) return false;
  if (inflight === 0 && current.loading) {
    current = { ...current, loading: false };
    emit();
  }
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInboxSnapshot(): InboxSnapshot {
  return current;
}

export function useInbox(): InboxSnapshot {
  return useSyncExternalStore(subscribe, getInboxSnapshot, getInboxSnapshot);
}

export function useInboxCounts(): InboxCounts {
  return useSyncExternalStore(
    subscribe,
    () => current.counts,
    () => current.counts,
  );
}

/** 侧栏徽标：「待关注」= 需处理 ∪ 未读；旧 sidecar 无 attention 时回落 */
export function inboxBadgeCount(counts: InboxCounts): number {
  if (typeof counts.attention === "number") return counts.attention;
  return counts.needsAction > 0 ? counts.needsAction : counts.unread;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduleRefresh(delay = 200): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshInbox();
  }, delay);
  (refreshTimer as { unref?: () => void }).unref?.();
}

function onInboxChanged(frame: InboxChangedFrame): void {
  // 计数立即生效（徽标不等列表往返）；列表按当前筛选防抖重拉
  current = { ...current, counts: frame.counts };
  emit();
  if (current.loaded) scheduleRefresh();
}

function ensureChannelSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    const channel = getPiChannel();
    const off = channel.subscribeInboxChanged?.(onInboxChanged);
    if (off && typeof (off as Promise<() => void>).then === "function") {
      void (off as Promise<() => void>)
        .then((fn) => {
          unsubscribeChannel = fn;
        })
        .catch((error) => {
          // 订阅失败（通道未就绪/重连中）：允许下一次 ensure 再试
          console.warn("[inbox] subscribe failed", error);
          subscribed = false;
        });
    } else if (typeof off === "function") {
      unsubscribeChannel = off;
    }
    // sidecar 换代（dev 热重启/崩溃重启）后旧投影可能已过期，重拉一次
    const offRestart = channel.subscribeSidecarRestart?.(() => {
      void refreshInbox().catch(() => {});
    });
    if (offRestart && typeof (offRestart as Promise<() => void>).then === "function") {
      void (offRestart as Promise<() => void>)
        .then((fn) => {
          unsubscribeRestart = fn;
        })
        .catch(() => {});
    } else if (typeof offRestart === "function") {
      unsubscribeRestart = offRestart;
    }
  } catch {
    // 通道尚未挂载（启动早期/纯浏览器测试）：退化为操作后重拉
    subscribed = false;
  }
}

/** 首次挂载种子：只拉默认 Tab；已有数据不覆盖 */
export async function ensureInboxLoaded(): Promise<void> {
  ensureChannelSubscription();
  if (current.loaded || current.loading) return;
  await refreshInbox();
}

/** 拉取当前筛选的第一页；世代规则防旧应答覆盖新筛选 */
export async function refreshInbox(): Promise<void> {
  ensureChannelSubscription();
  const seq = ++issueSeq;
  inflight += 1;
  current = {
    ...current,
    loading: true,
    error: null,
    items: current.items,
  };
  emit();
  try {
    const res = await inboxRequest<InboxResponse>({
      type: "list_inbox",
      filter: current.filter,
      limit: 50,
    });
    inflight = Math.max(0, inflight - 1);
    if (dropStaleResponse(seq)) return;
    setSnapshot({
      ...current,
      loaded: true,
      loading: inflight > 0,
      error: null,
      items: res.items,
      counts: res.counts,
      sources: res.sources ?? current.sources,
      nextCursor: res.nextCursor,
    });
  } catch (error) {
    inflight = Math.max(0, inflight - 1);
    if (dropStaleResponse(seq)) return;
    setSnapshot({
      ...current,
      loading: inflight > 0,
      error: errMsg(error),
    });
  }
}

/** 追加下一页（「加载更多」） */
export async function loadMoreInbox(): Promise<void> {
  const cursor = current.nextCursor;
  if (!cursor || current.loading) return;
  const seq = issueSeq;
  inflight += 1;
  current = { ...current, loading: true, error: null };
  emit();
  try {
    const res = await inboxRequest<InboxResponse>({
      type: "list_inbox",
      filter: current.filter,
      limit: 50,
      cursor,
    });
    inflight = Math.max(0, inflight - 1);
    if (dropStaleResponse(seq)) return;
    const seen = new Set(current.items.map((item) => item.id));
    setSnapshot({
      ...current,
      loading: inflight > 0,
      items: [...current.items, ...res.items.filter((item) => !seen.has(item.id))],
      counts: res.counts,
      sources: res.sources ?? current.sources,
      nextCursor: res.nextCursor,
    });
  } catch (error) {
    inflight = Math.max(0, inflight - 1);
    if (dropStaleResponse(seq)) return;
    setSnapshot({ ...current, loading: inflight > 0, error: errMsg(error) });
  }
}

/** 切换筛选（Tab/类型/搜索），清空分页游标并重拉 */
export async function setInboxFilter(filter: InboxFilter): Promise<void> {
  current = {
    ...current,
    filter: { ...filter },
    items: [],
    nextCursor: undefined,
    error: null,
  };
  emit();
  await refreshInbox();
}

/**
 * 切换「待关注 / 历史 / 已归档」Tab：服务端只返回该 Tab 的条目，分页/
 * 「加载更多」都在同一集合内推进。归档条目不再混在历史里；待关注也不会
 * 因为历史条目挤占分页而看起来“消失”或突然多出来。
 */
export async function setInboxTab(tab: InboxViewTab): Promise<void> {
  if (current.filter.tab === tab) return;
  await setInboxFilter({ ...current.filter, tab });
}

export async function loadInboxDetail(itemId: string): Promise<void> {
  current = {
    ...current,
    detailItemId: itemId,
    detail: null,
    detailLoading: true,
    detailError: null,
  };
  emit();
  try {
    const res = await inboxRequest<InboxItemResponse>({ type: "inbox_item", itemId });
    if (current.detailItemId !== itemId) return;
    setSnapshot({
      ...current,
      detailLoading: false,
      detail: res.detail ?? null,
      detailError: null,
      // stale 不是加载失败：详情面板自身会显示「来源已不存在」，
      // 不要把列表头部的错误条也点亮。
      error: null,
    });
    // 详情带回更新的 item（可能已被另一端结算）
    updateItemInList(res.item);
  } catch (error) {
    if (current.detailItemId !== itemId) return;
    setSnapshot({
      ...current,
      detailLoading: false,
      detailError: errMsg(error),
    });
  }
}

export function clearInboxDetail(): void {
  if (!current.detailItemId && !current.detail) return;
  setSnapshot({
    ...current,
    detailItemId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
  });
}

function updateItemInList(item: InboxItem): void {
  const idx = current.items.findIndex((x) => x.id === item.id);
  if (idx < 0) return;
  const items = [...current.items];
  // 已不在当前 Tab 的条目由随后的 refresh 移除；这里只做原位置更新，避免闪烁
  items[idx] = item;
  setSnapshot({ ...current, items });
}

export async function runInboxAction(
  itemId: string,
  action: string,
  payload?: unknown,
): Promise<InboxActionResponse> {
  const res = await inboxRequest<InboxActionResponse>({
    type: "inbox_action",
    itemId,
    action,
    ...(payload === undefined ? {} : { payload }),
  });
  updateItemInList(res.item);
  current = { ...current, counts: res.counts };
  emit();
  // 动作可能结算/移除条目，重拉当前 Tab 与计数
  await refreshInbox();
  // 删除后详情必然 404：不要用一个注定失败的请求把详情区点成错误态
  if (action !== "delete" && current.detailItemId === itemId) {
    await loadInboxDetail(itemId);
  }
  return res;
}

export async function updateInboxItems(
  itemIds: string[],
  patch: { read?: boolean; archived?: boolean; deleted?: boolean; snoozedUntil?: string | null },
  options?: { all?: boolean; filter?: InboxFilter },
): Promise<InboxUpdateResponse> {
  const res = await inboxRequest<InboxUpdateResponse>({
    type: "inbox_update",
    itemIds,
    patch,
    // all=true：服务端按筛选条件跨分页更新（「全部已读」）。itemIds 仍随请求
    // 发送，旧 sidecar 不认 all 时至少处理当前已加载的一页（优雅降级）。
    ...(options?.all
      ? { all: true, filter: options.filter ?? current.filter }
      : {}),
  });
  // 先用应答 counts 收敛徽标，再重拉列表；重拉失败时徽标至少是对的
  current = { ...current, counts: res.counts };
  emit();
  await refreshInbox();
  return res;
}

/**
 * 「全部已读」：跨分页生效，且不被来源/搜索筛选切碎——按钮长在 Tab 行，
 * 语义就是清空整个待关注。includeSnoozed 让 snooze 中的未读也一起标记，
 * 否则 counts.unread 永远清不零，按钮会一直亮着却“点了没反应”。
 * archived=true 触发服务端清扫：已结束仍挂着 requiresAction 的失败报告
 * （子代理/后台命令/自动化）标已读后不会自行离开待关注，只标已读会落进
 * 「按钮灰了、列表不空」的死局——清扫把它们收进已归档（可恢复）。未结算
 * 的审批/提问/目标服务端只标已读、绝不归档（不能把等你决定的事藏掉）。
 */
export async function markAllInboxRead(): Promise<InboxUpdateResponse> {
  const unread = current.items.filter((item) => !item.readAt && !item.archivedAt);
  const ids = unread.map((item) => item.id);
  const options: { all: boolean; filter: InboxFilter } = {
    all: true,
    filter: { tab: "attention", includeSnoozed: true },
  };
  try {
    return await updateInboxItems(ids, { read: true, archived: true }, options);
  } catch (error) {
    // 只有「旧 sidecar 不认 all」或「对阻塞项归档」才降级成只标已读；
    // 网络/超时错误直接抛给上层。旧 sidecar 可能没有结构化 error 字段，
    // 用错误文本兜底识别同一条 INBOX_ACTION_NOT_ALLOWED。
    const fallback =
      error instanceof InboxRequestError &&
      (error.code === "INBOX_ACTION_NOT_ALLOWED" ||
        (!error.code &&
          /INBOX_ACTION_NOT_ALLOWED|cannot archive an open actionable/i.test(
            error.message,
          )));
    if (!fallback) {
      throw error;
    }
    return updateInboxItems(ids, { read: true }, options);
  }
}

/** 测试缝：清空 store 与订阅 */
export function resetInboxStoreForTest(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  unsubscribeChannel?.();
  unsubscribeChannel = null;
  unsubscribeRestart?.();
  unsubscribeRestart = null;
  subscribed = false;
  issueSeq += 1;
  inflight = 0;
  current = EMPTY;
  listeners.clear();
}
