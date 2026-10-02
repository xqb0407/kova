/**
 * 主题变更后的生效与广播（管理页 handler 与 AI 管理工具共用）。
 *
 * 变更落盘后要走的是同一条链：
 *   引用面重映射（改名 / 归一名合并清扫 / 删除）→ refreshThemes 刷快照 →
 *   重排全部活动会话的系统提示词（design 段主题句跟随增减）→ 无 id 广播帧
 *   （清单 + 受影响会话的选中）给各窗口。
 *
 * 顺序契约：调用方先完成落盘与 id 应答帧，再 finishThemeMutation 广播——与旧版
 * handler 内联实现逐帧一致（应答在前、广播在后；重复收帧幂等覆写）。
 *
 * 本模块引 agent/modes 做提示词重排，故不能被 modes 依赖的模块反向引入：
 * AI 管理工具（design-md/mgmt-tools）经 sessions/resolve 注入依赖，避免模块环。
 */
import { running } from "../sessions/registry";
import { composeModeSystemPrompt } from "../agent/modes";
import { setLeadingSystemMessage } from "../agent/context";
import { send } from "../protocol/stream";
import { sessionPrefsSet } from "../storage/hostdb";
import { refreshThemes, type DesignThemeSnapshot, type ThemeRef } from "./store";
import { encodeThemeColumn, setLastUsedDesignTheme } from "./state";
import { remapThemeRefs, type RemappedThread } from "./ref-integrity";
import type { Running } from "../types";

/** 管理页改主题（save/delete/fork）后全量热替换：快照变了，所有 design 档
 *  会话的主题句（名称/描述/被删后的消失）都要跟上 */
export function recomposeAllRuns(): void {
  for (const run of running.values()) {
    const prompt = composeModeSystemPrompt(run.mode, run.cwd, run.appMode, run.agent.state.model, run.designTheme);
    setLeadingSystemMessage(run.agent.state.messages, prompt);
    if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
  }
}

/** 会话级选中落点：改 run 字段 + 只重排该会话提示词 + 偏好列/最近使用落库
 *  （fire-and-forget，与 persistModePrefs 同款容错） */
export function applySessionTheme(run: Running, ref: ThemeRef | null): void {
  run.designTheme = ref;
  const prompt = composeModeSystemPrompt(run.mode, run.cwd, run.appMode, run.agent.state.model, run.designTheme);
  setLeadingSystemMessage(run.agent.state.messages, prompt);
  if (run.loopContext) setLeadingSystemMessage(run.loopContext.messages, prompt);
  void sessionPrefsSet(run.sessionId, { designTheme: encodeThemeColumn(ref) }).catch(() => {});
  void setLastUsedDesignTheme(ref).catch(() => {});
}

/** 会话级选中 + 无 id 广播帧（AI 管理工具的「保存并应用」路径；
 *  管理页 set 另有 id 应答帧，见 handlers/design-md.ts） */
export function selectAndBroadcastSessionTheme(run: Running, ref: ThemeRef | null): void {
  applySessionTheme(run, ref);
  broadcastThemeSet({ threadId: run.threadId, sessionId: run.sessionId, theme: ref });
}

/**
 * 多窗口/远程推送：无 id 自发通知帧（本地各窗口走 Rust pi-chunk-batch 原样
 * 广播，远程连接走 remote.rs 白名单）。发起方窗口已收带 id 应答，再收到同
 * 数据推送帧属幂等覆写不冲突。set 推送带 threadId 供他窗胶囊直更；
 * 清单推送只在 save/delete（set 不改清单）。
 */
export function broadcastThemeSnapshot(snap: DesignThemeSnapshot): void {
  send({ type: "design_themes", ...snap });
}

export function broadcastThemeSet(t: {
  threadId: string;
  sessionId: string;
  theme: ThemeRef | null;
}): void {
  send({ type: "design_theme_set", threadId: t.threadId, sessionId: t.sessionId, theme: t.theme });
}

/** 一次主题变更的生效结果：新快照 + 被重映射的驻留会话（广播选中帧用） */
export type ThemeMutation = { snap: DesignThemeSnapshot; changed: RemappedThread[] };

/**
 * 保存后的生效链（改名 replaceId / 归一名合并清扫 clobbered 的引用先重映射，
 * 再刷快照、重排提示词）。只做生效，不发帧——应答与广播由调用方按原顺序补。
 */
export async function applyThemeSave(
  ref: ThemeRef,
  options: { replaceId?: string; clobbered: string[] },
): Promise<ThemeMutation> {
  // 改名（frontmatter name 变化 → 新 id）：指向旧 id 的一切引用重映射到新
  // id，用户正在用的主题不断链（未驻留会话/驻留 run/最近使用 kv 一起跟齐）
  const changed =
    options.replaceId && options.replaceId !== ref.id
      ? await remapThemeRefs({ scope: "user", id: options.replaceId }, ref)
      : [];
  // 归一名撞车清扫（大小写不敏感文件系统上 "Kova"/"kova" 同一文件、或旧
  // stem 不同但同名）：被合并掉的其他 id 的引用同样跟到新 id，不留悬空
  for (const oldId of options.clobbered) {
    if (oldId === ref.id || oldId === options.replaceId) continue;
    changed.push(...(await remapThemeRefs({ scope: "user", id: oldId }, ref)));
  }
  const snap = await refreshThemes();
  recomposeAllRuns();
  return { snap, changed };
}

/** 删除后的生效链：引用了该主题的一切落点收口为「显式不使用」 */
export async function applyThemeDelete(id: string): Promise<ThemeMutation> {
  const changed = await remapThemeRefs({ scope: "user", id }, null);
  const snap = await refreshThemes();
  recomposeAllRuns();
  return { snap, changed };
}

/** 广播一次变更：清单快照 + 受重映射影响的会话选中（应答之后调用） */
export function finishThemeMutation(m: ThemeMutation): void {
  broadcastThemeSnapshot(m.snap);
  for (const t of m.changed) broadcastThemeSet(t);
}
