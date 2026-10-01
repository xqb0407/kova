/**
 * steer 意图标记（旧链路的 composer → transport 单跳信号，「并入当前轮」用）：
 * 旧 AI SDK 链路不透传 SendOptions.steer，才走模块级标记。react-pi 新链路
 * 车道由 ComposerSendOptions.steer 显式声明（core append 按 message.steer ??
 * isRunning 选 steer/enqueue 车道），已无人再 mark；consumeSteerIntent 保留
 * 在 transport 侧作兼容位（恒 false），徽标（下方）仍是并入反馈的唯一展示。
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

/** 登记一条「已并入」徽标（steer 发起成功后调用）。写时复制：快照按引用比较，
 *  原位 push 不产生新引用（useSyncExternalStore 判定未变、不重渲） */
export function addSteeredBadge(chatId: string, text: string): void {
  steeredBadges.set(chatId, [...(steeredBadges.get(chatId) ?? []), text]);
  for (const listener of badgeListeners.get(chatId) ?? []) listener();
}

/** 回收回队：排队快照里重新出现同文本条目（sidecar 轮末回收，并入失败自动
 *  降级为排队）时摘掉对应「已并入」徽标——队列条恢复显示，徽标让位（并入其实
 *  没成功）。与 isRunning 下降沿的全量清空互补：那条覆盖收尾时刻，这条覆盖
 *  「宿主轮还在跑但条目已回队」的窗口 */
export function removeSteeredBadge(chatId: string, text: string): void {
  const list = steeredBadges.get(chatId);
  if (!list) return;
  const idx = list.indexOf(text);
  if (idx === -1) return;
  const next = [...list.slice(0, idx), ...list.slice(idx + 1)];
  if (next.length === 0) steeredBadges.delete(chatId);
  else steeredBadges.set(chatId, next);
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
