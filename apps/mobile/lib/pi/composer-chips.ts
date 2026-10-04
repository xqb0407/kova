"use client";

/**
 * 输入框的「指令芯片」台账（移动端版）：技能 / 子智能体的选择不在输入框里
 * 插原始指令文本（RN 的 TextInput 没有内联装饰位，`:-skill[..]{..}` 直接显示
 * 成乱码），而是像附件一样挂在这一份台账上——输入框上方的芯片行是它的可视
 * 化，序列化文本 `:type[label]{name=id}` 在**发送那一刻**由 ThreadController
 * 拼进正文（线上格式与桌面/web 完全一致，模型与 sidecar 口径不变）。
 *
 * 订阅走 useSyncExternalStore + 快照（引用只在真变时换）。
 */
import { useSyncExternalStore } from "react";

export type ComposerChip = {
  id: string;
  kind: "skill" | "agent";
  name: string;
  /** 线上序列化文本：`:skill[名]{name=skill:名}` / `:agent[名]{name=agent:名}` */
  directive: string;
};

let snapshot: readonly ComposerChip[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

function commit(next: ComposerChip[]): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** 挂一枚芯片（同名同类去重：连点两次不该出现两枚一样的） */
export function addComposerChip(chip: ComposerChip): void {
  if (snapshot.some((c) => c.directive === chip.directive)) return;
  commit([...snapshot, chip]);
}

export function removeComposerChip(id: string): void {
  const next = snapshot.filter((c) => c.id !== id);
  if (next.length !== snapshot.length) commit(next);
}

/** 发送成功后清空（ThreadController 调用） */
export function clearComposerChips(): void {
  if (snapshot.length === 0) return;
  commit([]);
}

/** 待拼进正文的指令文本（多枚按加入序，空格分隔）；空字符串 = 没有芯片 */
export function composerDirectiveText(): string {
  return snapshot.map((c) => c.directive).join(" ");
}

/**
 * 序列化指令 → 结构化（`:skill[名]{name=skill:名}` ⇒ { kind: "skill", name: "名" }）；
 * 非技能/子智能体（如 `:tool[...]`）返回 null。
 */
export function parseDirective(
  directive: string,
): { kind: "skill" | "agent"; name: string } | null {
  const m = /^:([\w-]{1,64})\[([^\]\n]{1,1024})\]/.exec(directive);
  if (!m) return null;
  const type = m[1] ?? "";
  const name = m[2] ?? "";
  if (type === "skill" || type === "agent") return { kind: type, name };
  return null;
}

/* ------------------------------ 指令解析 ------------------------------ */

/** 与 sidecar / 桌面端同一份正则（pi-protocol 会话标题摘要注释：三处必须同口径）。
 *  单源放这里：芯片台账（写入）与消息渲染（读出）共用，两边口径不可能漂。 */
export const DIRECTIVE_RE =
  /:([\w-]{1,64})\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;

export type MessageDirective = { type: string; label: string };

/**
 * 消息正文里的指令芯片：把 `:skill[名]{name=...}` 这类序列化文本从正文里摘出来，
 * 正文只留人话（用户气泡里显示原始 `:-skill[..]{..}` 就是渲染 bug）。
 * 一条消息里通常只有芯片（纯指令消息），此时正文为空串。
 */
export function splitMessageDirectives(text: string): {
  chips: MessageDirective[];
  text: string;
} {
  const chips: MessageDirective[] = [];
  let stripped = "";
  let last = 0;
  DIRECTIVE_RE.lastIndex = 0;
  for (const m of text.matchAll(DIRECTIVE_RE)) {
    if (m.index === undefined) continue;
    stripped += text.slice(last, m.index);
    last = m.index + m[0].length;
    chips.push({ type: m[1] ?? "", label: m[2] ?? "" });
  }
  if (chips.length === 0) return { chips, text };
  stripped += text.slice(last);
  return { chips, text: stripped.replace(/[ \t]{2,}/g, " ").trim() };
}

export function useComposerChips(): readonly ComposerChip[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

let serial = 0;
export const nextComposerChipId = (): string => `chip-${++serial}`;
