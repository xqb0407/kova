"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiAutomationListResponse,
  type PiAutomationTask,
  type PiAutomationTemplate,
  type PiAutomationTemplatesResponse,
} from "@/lib/pi/pi-bridge";
import { subscribeAgentEvents } from "@/lib/pi/agent-events";
import { isTauri } from "@/lib/tauri";

/**
 * 自动化定时任务（主区管理页）：前端镜像 store。
 * 事实源在 sidecar 调度器（<sessionsDir>/automation/tasks.json，M2 命令族
 * automation_*）；这里只做清单镜像与变更动作 —— 所有变更命令应答都是刷新后
 * 的全量清单（与 MCP/子智能体同惯例，改后即见，不比对 diff）。
 *
 * 实时态（此刻是否运行中/最近结算）不在本文件：见 lib/automation-live.ts
 * （自发帧投影）；本文件负责清单，automation-live 负责"活着的这一刻"。
 *
 * 会话归属映射（sessionId → taskId）：⚡ 徽标需要知道"这条会话是哪次定时
 * 运行开的"。事实源任务记录的 runHistory 只带调度器标签（scheduled-run-*），
 * 真实 agent sessionId 经 run_done 自发帧到达 —— 在 automation.task.* 事件上
 * 顺手记账，kv 持久化（跨重启给历史会话继续挂徽标；删任务不清，会话仍要能
 * 看出身）。
 */

export type AutomationTask = PiAutomationTask;
export type AutomationTemplate = PiAutomationTemplate;
export type AutomationDraft = {
  id?: string;
  name?: string;
  description?: string;
  prompt: string;
  type: "cron" | "once" | "interval";
  schedule: string;
  enabled: boolean;
  /** 留空 = 运行时跟随默认模型 */
  model: { provider: string; model: string };
  toolPolicyProfile: "read-only" | "workspace-write" | "full";
  workspaceDir?: string;
  timeoutMs?: number;
};

export type AutomationSnapshot = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  tasks: AutomationTask[];
};

const EMPTY: AutomationSnapshot = {
  loaded: false,
  loading: false,
  error: null,
  tasks: [],
};

let current: AutomationSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 写世代：清单类应答可能是陈旧快照（发单早于最近一次本地写、应答晚于其落盘）。
 * sidecar 按发单顺序逐条处理（同一通道 FIFO），所以给每个"应答带全量清单"的
 * 请求发单时盖单调 seq：变更命令应答到达后抬升 barrier，早于 barrier 发出的
 * 刷新应答按过期快照整份丢弃。防护场景：运行帧触发的 refreshAutomations 与
 * 用户暂停操作竞速，旧快照晚到把 enabled 翻回去（暂停开关回弹的根因）。
 */
let issueSeq = 0;
let writeBarrier = 0;
let inflight = 0;

function fromList(res: PiAutomationListResponse): AutomationSnapshot {
  return {
    ...current,
    loaded: true,
    loading: inflight > 0,
    error: null,
    tasks: res.tasks,
  };
}

function errMsg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** 清单类请求统一出口：发单盖世代，应答按世代规则决定是否落盘 */
async function requestList(
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number; isWrite?: boolean } = {},
): Promise<void> {
  const seq = ++issueSeq;
  inflight++;
  current = { ...current, loading: true };
  emit();
  try {
    const res = await piRequest<PiAutomationListResponse>(payload, opts.timeoutMs);
    inflight--;
    if (opts.isWrite) {
      writeBarrier = seq;
    } else if (seq <= writeBarrier) {
      // 快照发单早于最近一次写：应答不带新状态，丢弃（错误/加载由并发请求收尾）
      if (inflight === 0) current = { ...current, loading: false };
      emit();
      return;
    }
    current = fromList(res);
    emit();
  } catch (err) {
    inflight--;
    current = { ...current, loading: inflight > 0, error: errMsg(err) };
    emit();
    if (opts.isWrite) throw err;
  }
}

/** 拉取任务清单（sidecar 不可用保留旧镜像并记录错误） */
export function refreshAutomations(): Promise<void> {
  return requestList({ type: "automation_list" });
}

let refreshInflight: Promise<void> | null = null;

/** 首屏种子：未加载过时去重加载（徽标/管理页共用一次往返） */
export function ensureAutomationsLoaded(): Promise<void> {
  if (current.loaded || current.loading) return refreshInflight ?? Promise.resolve();
  refreshInflight = refreshAutomations().finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

/** 变更命令统一出口：应答即新清单；失败写 error 并抛出（表单保留输入） */
async function mutate(payload: Record<string, unknown>): Promise<void> {
  await requestList(payload, { timeoutMs: 15000, isWrite: true });
}

export function saveAutomation(draft: AutomationDraft): Promise<void> {
  return mutate({ type: "automation_save", task: draft });
}

export function deleteAutomation(taskId: string): Promise<void> {
  return mutate({ type: "automation_delete", taskId });
}

export function setAutomationEnabled(taskId: string, enabled: boolean): Promise<void> {
  return mutate({ type: "automation_set_enabled", taskId, enabled });
}

/** 立即触发一次；应答只含清单，运行结果经自发帧由 automation-live 呈现 */
export function runAutomationNow(taskId: string): Promise<void> {
  return mutate({ type: "automation_run_now", taskId });
}

/**
 * 删除某任务的部分运行记录条目（单条/批量共用，传条目 id 数组）。
 * 只删日志：关联的那次执行会话是独立资产，是否连坐由 UI 确认后另行走
 * `delete_session`（见 components/automations 的历史删除确认框）。
 */
export function deleteAutomationHistory(taskId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return Promise.resolve();
  return mutate({ type: "automation_history_delete", taskId, entryIds });
}

/** 清空某任务全部运行记录（all:true 走服务端整清，避开前端截断的 25 条上限） */
export function clearAutomationHistory(taskId: string): Promise<void> {
  return mutate({ type: "automation_history_delete", taskId, all: true });
}

/** 排期预览（表单实时提示下几次触发时间）：非法排期回 error 而非抛出 */
export async function previewAutomationSchedule(args: {
  type: string;
  schedule: string;
  count?: number;
}): Promise<{ runs: string[] } | { error: string }> {
  try {
    const res = await piRequest<{
      type: "automation_preview";
      runs?: string[];
      error?: string;
    }>({
      type: "automation_preview",
      scheduleType: args.type,
      schedule: args.schedule,
      count: args.count ?? 3,
    });
    if (res.runs) return { runs: res.runs };
    return { error: res.error ?? "预览失败" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 预置模板清单（「从模板新建」选择器用）：sidecar 里的静态表，进程内不变，
 * 首次拉取后模块级缓存；失败清空缓存让下次重试（视图只在打开选择器时调用）。
 */
let templatesCache: Promise<PiAutomationTemplate[]> | null = null;
export function fetchAutomationTemplates(): Promise<PiAutomationTemplate[]> {
  if (!templatesCache) {
    templatesCache = piRequest<PiAutomationTemplatesResponse>({
      type: "automation_templates",
    })
      .then((res) => res.templates ?? [])
      .catch((err) => {
        templatesCache = null;
        throw err;
      });
  }
  return templatesCache;
}

/** 清单快照 hook（管理页主消费；调用方负责触发 refresh/ensure） */
export function useAutomations(): AutomationSnapshot {
  useEffect(() => {
    void ensureAutomationsLoaded();
  }, []);
  return useSyncExternalStore(subscribe, () => current, () => EMPTY);
}

/** 只读快照（非 hook 代码路径与测试用；hook 版是 useAutomations） */
export function getAutomationsSnapshot(): AutomationSnapshot {
  return current;
}

// —— sessionId → taskId 归属映射（⚡ 徽标数据源） ——

const MAP_KEY = "automation-session-map";
// runId（= runHistory 条目 id）→ 真实 sessionId：历史条目跨重启跳会话用。
// 任务记录里的 sessionId 只是调度器标签（scheduled-run-*），真实 id 只在
// run_done 帧上出现过一次，故单独记一张表。
const RUN_MAP_KEY = "automation-run-map";
/** 运行映射上限（按插入序淘汰），防长寿命应用无限膨胀 */
const RUN_MAP_CAP = 500;

let sessionMap: Record<string, string> = {};
let runSessionMap: Record<string, string> = {};
const mapListeners = new Set<() => void>();
let mapLoaded = false;

function emitMap() {
  for (const l of mapListeners) l();
}

function parseRecord(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, string>;
  }
  return null;
}

async function loadMap(): Promise<void> {
  if (mapLoaded) return;
  mapLoaded = true;
  try {
    const [sessionRaw, runRaw] = await Promise.all([
      isTauri()
        ? invoke<string | null>("kv_get", { key: MAP_KEY }).catch(() => null)
        : Promise.resolve(window.localStorage.getItem(MAP_KEY)),
      isTauri()
        ? invoke<string | null>("kv_get", { key: RUN_MAP_KEY }).catch(() => null)
        : Promise.resolve(window.localStorage.getItem(RUN_MAP_KEY)),
    ]);
    const s = parseRecord(sessionRaw);
    const r = parseRecord(runRaw);
    let changed = false;
    if (s) {
      sessionMap = s;
      changed = true;
    }
    if (r) {
      runSessionMap = r;
      changed = true;
    }
    if (changed) emitMap();
  } catch {
    // 读不到就空表起步（记账仍会继续）
  }
}

function persistMap(): void {
  if (isTauri()) {
    void invoke("kv_set", { key: MAP_KEY, value: JSON.stringify(sessionMap) }).catch(() => {});
    void invoke("kv_set", { key: RUN_MAP_KEY, value: JSON.stringify(runSessionMap) }).catch(
      () => {},
    );
  } else {
    try {
      window.localStorage.setItem(MAP_KEY, JSON.stringify(sessionMap));
      window.localStorage.setItem(RUN_MAP_KEY, JSON.stringify(runSessionMap));
    } catch {
      // 存储不可用时仅本次会话生效
    }
  }
}

function recordAutomationSession(sessionId: string, taskId: string): void {
  if (sessionMap[sessionId] === taskId) return;
  sessionMap = { ...sessionMap, [sessionId]: taskId };
  persistMap();
  emitMap();
}

function recordAutomationRun(runId: string, sessionId: string): void {
  if (runSessionMap[runId] === sessionId) return;
  runSessionMap = { ...runSessionMap, [runId]: sessionId };
  const keys = Object.keys(runSessionMap);
  if (keys.length > RUN_MAP_CAP) {
    const trimmed: Record<string, string> = {};
    for (const k of keys.slice(keys.length - RUN_MAP_CAP)) trimmed[k] = runSessionMap[k];
    runSessionMap = trimmed;
  }
  persistMap();
  emitMap();
}

let recorderStarted = false;

/**
 * 装配归属记账（与窗口同生命周期，幂等）：run_done 转发的 automation.task.*
 * 事件带 threadId=真实 sessionId + data.taskId，逐条落 kv。
 * 顺带把清单加载也种子化（徽标要在会话列表出现前就有数据）。
 */
export function initAutomationSessionMap(): void {
  if (recorderStarted || typeof window === "undefined") return;
  recorderStarted = true;
  void loadMap();
  void ensureAutomationsLoaded();
  subscribeAgentEvents((event) => {
    if (!event.name.startsWith("automation.task.")) return;
    const sessionId = event.threadId;
    const taskId =
      typeof event.data?.taskId === "string" ? (event.data.taskId as string) : undefined;
    const runId = typeof event.data?.runId === "string" ? event.data.runId : undefined;
    if (sessionId && taskId) recordAutomationSession(sessionId, taskId);
    if (sessionId && runId) recordAutomationRun(runId, sessionId);
    // 一次运行结束 = 任务记录必变（runCount/lastRunAt/lastStatus）：
    // 页面曾加载过就补一次清单，卡片列数据与实时徽标收敛（从未加载过不打扰 sidecar）
    if (current.loaded) void refreshAutomations();
  });
}

/**
 * ⚡ 徽标点击 → 管理页定位任务卡片的跨组件信号（侧边栏行与主区视图
 * 互不引用，经 window 事件握手；宿主 base 监听后切页并下发 focusTaskId）。
 */
export const AUTOMATION_FOCUS_EVENT = "automation:focus-task";

export function requestAutomationFocus(taskId: string): void {
  window.dispatchEvent(new CustomEvent(AUTOMATION_FOCUS_EVENT, { detail: { taskId } }));
}

export function subscribeAutomationFocus(cb: (taskId: string) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ taskId?: string }>).detail;
    if (typeof detail?.taskId === "string") cb(detail.taskId);
  };
  window.addEventListener(AUTOMATION_FOCUS_EVENT, handler);
  return () => window.removeEventListener(AUTOMATION_FOCUS_EVENT, handler);
}

/** 该会话是否出自定时任务（⚡ 徽标）；任务 id 供点击跳转 */
export function getAutomationTaskIdForSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionMap[sessionId];
}

/** 某次运行（runHistory 条目 id）对应的真实会话；未曾经帧记账则 undefined */
export function getAutomationSessionForRun(runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  return runSessionMap[runId];
}

function subscribeMap(cb: () => void): () => void {
  mapListeners.add(cb);
  return () => mapListeners.delete(cb);
}

export function useAutomationTaskIdForSession(
  sessionId: string | undefined,
): string | undefined {
  useEffect(() => {
    initAutomationSessionMap();
  }, []);
  return useSyncExternalStore(subscribeMap, () => getAutomationTaskIdForSession(sessionId), () => undefined);
}

export function useAutomationSessionForRun(
  runId: string | undefined,
): string | undefined {
  useEffect(() => {
    initAutomationSessionMap();
  }, []);
  return useSyncExternalStore(subscribeMap, () => getAutomationSessionForRun(runId), () => undefined);
}
