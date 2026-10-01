/**
 * steer 意图标记（composer → transport 的单跳信号，「并入当前轮」用）：
 * assistant-ui 的 SendOptions.steer 在 AI SDK 链路不透传（useAISDKRuntime 无
 * queue/steer 消费），transport.sendMessages 也收不到 send options，所以走
 * 模块级标记：发送前 mark（⌥点击 / Shift+⌘+Enter，仅运行中），transport
 * sendMessages 时 consume 并随 prompt 协议帧带 steer 字段给 sidecar。
 *
 * 标记一次性（消费即清除，只影响下一次发送）；两处调用点都有 canSend/
 * isRunning 守卫，标记悬空（标了没发出去）的窗口被压到最小。
 */
import { useSyncExternalStore } from "react";

const pending = new Set<string>();

/** 标记该线程的下一次发送为「并入当前轮」（仅运行中调用） */
export function markSteerNextSend(chatId: string): void {
  pending.add(chatId);
}

/** transport 消费：该线程下一次发送是否带 steer 标记（取走即清） */
export function consumeSteerIntent(chatId: string): boolean {
  const has = pending.delete(chatId);
  return has;
}

/** 只读窥探（不移除）：入队预期 gate 用——键盘 steer 发送已标记时跳过 gate，
 *  避免本该即时显示的并入消息被守门隐藏 */
export function peekSteerIntent(chatId: string): boolean {
  return pending.has(chatId);
}

// ---------------------------------------------------------------------------
// 「已并入当前回复」徽标（迁移 4a）：新链路 sidecar 不再回传 data-steered
// 信号（steer 流走退化收尾，chunk 对 react-pi 不可见），徽标改为前端本地
// 记账：steer 发起成功（队列条并入 / 运行中 steer 发送）后登记文本，队列栏
// 展示；宿主轮 isRunning 下降沿清空（并入内容已随本轮回复呈现，不再回填
// 独立气泡）。快照/重启后丢失可接受（与旧路径 registry 行为一致）。
// ---------------------------------------------------------------------------

type BadgeListener = () => void;
/** chatId → 并入文本（FIFO，多条折叠为一行展示） */
const steeredBadges = new Map<string, string[]>();
const badgeListeners = new Map<string, Set<BadgeListener>>();
const EMPTY_BADGES: string[] = [];

/** 登记一条「已并入」徽标（steer 发起成功后调用） */
export function addSteeredBadge(chatId: string, text: string): void {
  const list = steeredBadges.get(chatId) ?? [];
  list.push(text);
  steeredBadges.set(chatId, list);
  for (const listener of badgeListeners.get(chatId) ?? []) listener();
}

/** 宿主轮流收尾：清空该线程徽标（并入内容已随回复呈现） */
export function clearSteeredBadges(chatId: string): void {
  if (!steeredBadges.delete(chatId)) return;
  for (const listener of badgeListeners.get(chatId) ?? []) listener();
}

/** 队列栏订阅徽标（该线程的并入文本列表） */
export function useSteeredBadges(chatId: string): string[] {
  return useSyncExternalStore(
    (onChange) => {
      let set = badgeListeners.get(chatId);
      if (!set) {
        set = new Set();
        badgeListeners.set(chatId, set);
      }
      set.add(onChange);
      return () => {
        const current = badgeListeners.get(chatId);
        if (!current) return;
        current.delete(onChange);
        if (current.size === 0) badgeListeners.delete(chatId);
      };
    },
    () => steeredBadges.get(chatId) ?? EMPTY_BADGES,
    () => EMPTY_BADGES,
  );
}
