"use client";

import { useSyncExternalStore } from "react";
import {
  piRequest,
  type PiDesignThemeDocResponse,
  type PiDesignThemesResponse,
  type PiThemeRef,
  type PiDesignThemeSavedResponse,
  type PiDesignThemeSetResponse,
} from "@/lib/pi/pi-bridge";
import {
  getPiChannel,
  type PiDesignThemePush,
} from "@/lib/pi/pi-channel";
import {
  piSessionPrefsMap,
  piSessionRegistry,
  prefsSessionIdFor,
} from "@/lib/pi/pi-thread-adapter";

/**
 * 设计主题（设置 → 智能体 → 设计主题；composer 主题胶囊）：前端镜像 store。
 * 事实源在 sidecar design-md/——内置层是随产品分发的主题包 zip（首启解压、按
 * catalog.version 升级同步，只读可 fork），用户层是 <root>/user/*.md（可编辑，
 * 同名遮蔽内置）；「本会话选中哪个主题」是会话级偏好（sessions.design_theme
 * 列），所以清单是全局镜像、选中态按线程各存一份（同 pi-session-mode 的模式快照）。
 * 变更命令的应答都是刷新后的清单，改后即见；活动会话提示词的热重排由 sidecar 完成。
 */
export type ThemeScope = "builtin" | "user";
export type ThemeRef = PiThemeRef;
export type DesignThemeEntry = PiDesignThemesResponse["entries"][number];

export type DesignThemesSnapshot = {
  loading: boolean;
  error: string | null;
  entries: DesignThemeEntry[];
  version: string;
  builtinCount: number;
  userCount: number;
  /** 主题包装载错误（zip 损坏；entries 可能仍来自上次成功值） */
  packError: string | null;
};

const EMPTY: DesignThemesSnapshot = {
  loading: false,
  error: null,
  entries: [],
  version: "",
  builtinCount: 0,
  userCount: 0,
  packError: null,
};

let current: DesignThemesSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 清单形状（list / save / delete 的应答共用字段；type 字面量不同但结构一致） */
type ThemeListFrame = Pick<
  PiDesignThemesResponse,
  "entries" | "version" | "builtinCount" | "userCount" | "error"
>;

function applyFrame(res: ThemeListFrame) {
  current = {
    loading: false,
    error: null,
    entries: res.entries ?? [],
    version: res.version ?? "",
    builtinCount: res.builtinCount ?? 0,
    userCount: res.userCount ?? 0,
    packError: res.error ?? null,
  };
  emit();
}

/** 拉取全局清单（设置页打开与启动水合；save/delete 的应答自带新清单不必再拉） */
export async function refreshDesignThemes(): Promise<void> {
  current = { ...current, loading: true };
  emit();
  try {
    applyFrame(await piRequest<PiDesignThemesResponse>({ type: "list_design_themes" }));
  } catch (err) {
    current = { ...current, loading: false, error: err instanceof Error ? err.message : String(err) };
    emit();
  }
}

/** 变更命令统一出口：应答即新清单 */
async function mutateThemes<T extends PiDesignThemesResponse | PiDesignThemeSavedResponse>(
  payload: Record<string, unknown>,
): Promise<T> {
  try {
    const res = await piRequest<T>(payload);
    applyFrame(res);
    return res;
  } catch (err) {
    current = { ...current, loading: false, error: err instanceof Error ? err.message : String(err) };
    emit();
    throw err;
  }
}

/**
 * 保存用户主题（表单 definition 或原文 raw 二选一，同 save_skill）。
 * id = 编辑对象的既有主题 id（改名时 sidecar 据此清旧文件；新建/fork 省略）。
 */
export function saveDesignTheme(args: {
  definition?: { name: string; description?: string; content: string; accents?: string[] };
  raw?: string;
  fallbackName?: string;
  id?: string;
}): Promise<PiDesignThemeSavedResponse> {
  return mutateThemes<PiDesignThemeSavedResponse>({
    type: "save_design_theme",
    scope: "user",
    // 业务 id 走 themeId：裸 id 字段被协议 reqId 占用（WS 通道覆写）
    ...(args.id ? { themeId: args.id } : {}),
    ...(args.fallbackName ? { fallbackName: args.fallbackName } : {}),
    ...(args.raw !== undefined ? { raw: args.raw } : { definition: args.definition }),
  }).then((res) => {
    // 改名保存（id 传入且应答 ref 换了 id）：本地引用面跟齐 sidecar 的重映射，
    // 胶囊与播种不悬空
    if (args.id && res.ref && res.ref.id !== args.id) {
      remapActiveRefs({ scope: "user", id: args.id }, res.ref);
    }
    return res;
  });
}

export async function deleteDesignTheme(id: string): Promise<void> {
  await mutateThemes<PiDesignThemesResponse>({ type: "delete_design_theme", scope: "user", themeId: id });
  // sidecar 把引用该主题的会话列/驻留会话收口为「不使用」；本地快照跟齐
  remapActiveRefs({ scope: "user", id }, null);
}

/**
 * 本地引用面改写：指向 from 的线程选中态与会话列表镜像行统一换成 to
 * （null = 显式不使用）。sidecar 对 remapThemeRefs 做的是同一件事的持久化侧，
 * 这里让本进程 UI 不等重新水合就跟上。
 */
function remapActiveRefs(from: ThemeRef, to: ThemeRef | null): void {
  let changed = false;
  for (const [threadId, active] of activeByThread) {
    if (active && active.scope === from.scope && active.id === from.id) {
      activeByThread.set(threadId, to);
      changed = true;
    }
  }
  for (const [sessionId, prefs] of piSessionPrefsMap) {
    const ref = decodeColumn(prefs.designTheme);
    if (ref && ref.scope === from.scope && ref.id === from.id) {
      piSessionPrefsMap.set(sessionId, { ...prefs, designTheme: to ? JSON.stringify(to) : "" });
      changed = true;
    }
  }
  if (changed) emitActive();
}

/** 取主题全文：user = 磁盘原文（含 frontmatter，编辑回填用）；builtin = 包内 DESIGN.md */
export function getDesignThemeDoc(ref: ThemeRef): Promise<PiDesignThemeDocResponse> {
  return piRequest<PiDesignThemeDocResponse>({ type: "get_design_theme", ref });
}

/* ---------------------------- 会话级选中态 ---------------------------- */

/** threadId -> 最近一次已知的设计主题选择（undefined = 尚未水合） */
const activeByThread = new Map<string, ThemeRef | null>();
const activeListeners = new Set<() => void>();

function emitActive() {
  for (const listener of activeListeners) listener();
}

export function setActiveDesignTheme(threadId: string, ref: ThemeRef | null): void {
  activeByThread.set(threadId, ref);
  emitActive();
  // 偏好已变：校准会话列表镜像（hydrate 播种源，见 decode）
  const sessionId = piSessionRegistry.get(threadId);
  if (sessionId) {
    const prefs = piSessionPrefsMap.get(sessionId);
    if (prefs) piSessionPrefsMap.set(sessionId, { ...prefs, designTheme: ref ? JSON.stringify(ref) : "" });
  }
}

/** 偏好列三态解码（与 sidecar decodeThemeColumn 同规则）：
 *  undefined/null = 从未设置（未知，等水合）；"" = 显式不使用；JSON = 选中 */
function decodeColumn(raw: string | null | undefined): ThemeRef | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;
    if ((r.scope === "builtin" || r.scope === "user") && typeof r.id === "string" && r.id.trim()) {
      return { scope: r.scope, id: r.id.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 会话级选中（composer 主题胶囊）：null = 显式"不使用主题"。sidecar 立即重排
 * 该会话提示词并把偏好落 sessions.design_theme 列 + 最近使用 kv。
 */
export async function setSessionDesignTheme(threadId: string, theme: ThemeRef | null): Promise<void> {
  const sessionId = prefsSessionIdFor(threadId);
  const res = await piRequest<PiDesignThemeSetResponse>({
    type: "set_design_theme",
    threadId,
    ...(sessionId ? { sessionId } : {}),
    theme,
  });
  setActiveDesignTheme(threadId, res.theme);
}

/**
 * 水合某线程的选中态：先用会话列表偏好播种（sidecar 重启/会话未驻留也能恢复 UI，
 * "从未设置"线程显示无主题并等活动真值），再向 sidecar 拉含 active 的清单。
 * 与 fetchPlanningState 同规则：没有任何已知 sessionId 的线程不发请求（避免懒建会话）。
 */
export async function hydrateSessionTheme(threadId: string): Promise<void> {
  const sessionId = prefsSessionIdFor(threadId);
  if (!sessionId) return;
  const seeded = decodeColumn(piSessionPrefsMap.get(sessionId)?.designTheme);
  if (seeded !== undefined && !activeByThread.has(threadId)) {
    activeByThread.set(threadId, seeded);
    emitActive();
  }
  try {
    const res = await piRequest<PiDesignThemesResponse>({
      type: "list_design_themes",
      threadId,
      ...(piSessionRegistry.get(threadId) ? {} : { sessionId }),
    });
    applyFrame(res);
    if (res.active !== undefined) {
      activeByThread.set(threadId, res.active);
      emitActive();
    }
  } catch {
    // 请求失败保持播种值（胶囊下次进 design 档再试）
  }
}

/** 订阅全局清单快照 */
export function useDesignThemes(): DesignThemesSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}

/** 订阅某线程当前选中的主题（null = 显式不使用；undefined = 未水合，UI 视作无主题） */
export function useSessionDesignTheme(threadId: string | undefined): ThemeRef | null | undefined {
  return useSyncExternalStore(
    (cb) => {
      activeListeners.add(cb);
      return () => activeListeners.delete(cb);
    },
    () => (threadId ? activeByThread.get(threadId) : undefined),
    () => undefined,
  );
}

/** 同步读（非 hook 场景：composer 发指令芯片等） */
export function getSessionDesignTheme(threadId: string | undefined): ThemeRef | null | undefined {
  return threadId ? activeByThread.get(threadId) : undefined;
}

/* --------------------------- 多窗口/远程推送直更 --------------------------- */

/**
 * 推送帧直更（无 id 自发的 design_themes / design_theme_set，sidecar 在
 * save/delete/set 之后自发，见 handlers/design-md.ts）：他窗清单与胶囊不必
 * 等重挂水合就同屏跟齐。发起方窗口已收带 id 应答，再收推送属幂等覆写。
 * design_theme_set 用 setActiveDesignTheme 同款写面（线程快照 + 偏好镜像
 * 校准），改名重映射/删除收口的逐线程推送也走这里。
 */
export function handleDesignThemePush(frame: PiDesignThemePush): void {
  if (frame.type === "design_theme_set") {
    setActiveDesignTheme(frame.threadId, frame.theme);
    return;
  }
  applyFrame(frame);
}

/** 惰性订阅（胶囊/管理页挂载时触发）：注册一次；通道不支持推送则镜像
 *  退化为纯拉取（挂载水合 + 应答即快照），推送缺位不影响正确性。pi-context 同款 */
let pushSubStarted = false;
let pushTeardown: (() => void) | null = null;
export function ensureDesignThemePush(): void {
  if (pushSubStarted) return;
  pushSubStarted = true;
  void (async () => {
    try {
      const un = await getPiChannel().subscribeDesignThemes?.(handleDesignThemePush);
      pushTeardown = un ?? null;
    } catch {
      pushTeardown = null;
    }
  })();
}

/** 测试/换通道拆除：退订并允许重新订阅 */
export function teardownDesignThemePush(): void {
  pushTeardown?.();
  pushTeardown = null;
  pushSubStarted = false;
}

/** 按 ref 找清单项（胶囊回显名/色板；清单未水合或主题已删返回 undefined） */
export function findThemeEntry(ref: ThemeRef | null | undefined): DesignThemeEntry | undefined {
  if (!ref) return undefined;
  return current.entries.find((e) => e.scope === ref.scope && e.id === ref.id);
}

// client bundle 加载即水合清单（SSR 端返回空快照，不请求）
if (typeof window !== "undefined") void refreshDesignThemes();
