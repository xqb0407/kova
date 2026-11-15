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

/**
 * Inbox 应答类型不在全局 PiResponse 联合里：looseObject 的索引签名会让
 * `res.type === "running"` 等既有收窄退化。这里走通道原语并在出口收窄。
 */
async function inboxRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await getPiChannel().request(payload);
  if (response.type === "error") throw new Error(response.errorText);
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
  filter: { tab: "all" },
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
    inflight -= 1;
    if (seq !== issueSeq) return; // 更新的一次请求已接管
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
    inflight -= 1;
    if (seq !== issueSeq) return;
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
    inflight -= 1;
    if (seq !== issueSeq) return;
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
    inflight -= 1;
    if (seq !== issueSeq) return;
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
  if (current.detailItemId === itemId) {
    await loadInboxDetail(itemId);
  }
  return res;
}

export async function updateInboxItems(
  itemIds: string[],
  patch: { read?: boolean; archived?: boolean; snoozedUntil?: string | null },
): Promise<InboxUpdateResponse> {
  const res = await inboxRequest<InboxUpdateResponse>({
    type: "inbox_update",
    itemIds,
    patch,
  });
  // 先用应答 counts 收敛徽标，再重拉列表；重拉失败时徽标至少是对的
  current = { ...current, counts: res.counts };
  emit();
  await refreshInbox();
  return res;
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
