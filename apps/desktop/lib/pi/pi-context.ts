"use client";

import { useEffect, useSyncExternalStore } from "react";
import { piRequest, type PiCompacted, type PiContextInfo } from "@/lib/pi/pi-bridge";
import { getPiChannel, type PiContextChangedFrame } from "@/lib/pi/pi-channel";
import { piSessionIdForThread, piSessionRegistry } from "@/lib/pi/pi-thread-adapter";
import { setManualCompactionMarker } from "@/lib/pi/pi-compaction-marker";
import { getWorkspace } from "@/lib/workspace/workspace-store";

/**
 * 上下文面板的请求侧封装（事实源全在 sidecar：占用从 Agent 状态现算、
 * 命中率从 JSONL 用量行聚合，见 sidecar context.ts 的 contextInfo）。
 * threadId/sessionId 的携带方式与 pi-session-mode 一致。
 */

/** 请求载荷：无会话线程（未发送草稿）返回 null，调用方必须跳过——
 *  threadId-only 请求会让 sidecar resolveSession 懒建空白会话（污染），
 *  真实会话的 running 键一旦被占住，后续 prompt 全落空会话（对话失忆） */
function threadPayload(
  threadId: string,
): { threadId: string; sessionId: string; cwd?: string } | null {
  const sessionId = piSessionIdForThread(threadId);
  if (!sessionId) return null;
  // 带上当前工作目录：sidecar 侧恢复非驻留会话（反查命中但 cwd 未绑）时补绑
  const cwd = getWorkspace() ?? undefined;
  return { threadId, sessionId, ...(cwd ? { cwd } : {}) };
}

/** 读取当前线程的上下文读数（popover 打开时调用） */
export function fetchContextInfo(threadId: string): Promise<PiContextInfo> {
  const payload = threadPayload(threadId);
  if (!payload) return Promise.reject(new Error("会话尚未创建"));
  return piRequest<PiContextInfo>({ type: "context_info", ...payload });
}

/* ---------------- 占用镜像（设计文档 §7，拉转推） ----------------
 * sidecar 每轮收尾推 context_changed：占用环不再逐轮全量拉取，推送直更
 * 镜像；popover 打开仍拉完整读数（分项/模型名/miss 统计不在推送里）；
 * 水印缺口回拉 context_info（pi-transport 把 refreshContextMirror 接进
 * seq-guard 的 kind="context"）。帧按 sessionId、镜像按 threadId（UI
 * 消费键；registry 未绑定时直用 sessionId 作键，新链路二者本就相同）。 */

export type PiContextMirror = {
  /** 模型可见的请求总占用（sidecar 统一口径 usedTokens，见 setContextMirrorFromPull） */
  usedTokens: number;
  /** 自动压缩硬阈值（hardLimit；0 = 无模型/不可判） */
  threshold: number;
  contextWindow: number;
  cacheHitRatio: number | null;
  /** 该镜像来自哪条推送水印（null = 拉取写入）；回退号丢弃防重放倒挂 */
  eventSeq: number | null;
};

const contextMirrors = new Map<string, PiContextMirror>();
const contextListeners = new Set<() => void>();

function notifyContextMirrors(): void {
  for (const l of [...contextListeners]) l();
}

export function subscribeContextMirror(cb: () => void): () => void {
  contextListeners.add(cb);
  return () => {
    contextListeners.delete(cb);
  };
}

export function readContextMirror(threadId: string): PiContextMirror | null {
  return contextMirrors.get(threadId) ?? null;
}

function threadForSession(sessionId: string): string | undefined {
  for (const [t, s] of piSessionRegistry) if (s === sessionId) return t;
  // react-pi 新链路（迁移 4c）：threadId = sessionId，无 registry 映射时
  // 直用 sessionId 作镜像键（帧本就按会话推送，键一致即可命中 UI 消费）
  return sessionId;
}

/** context_changed 推送帧直更镜像（通道回调；形状残缺/未绑定即弃） */
export function applyContextChanged(frame: PiContextChangedFrame): void {
  if (
    typeof frame.usedTokens !== "number" ||
    typeof frame.threshold !== "number" ||
    typeof frame.contextWindow !== "number"
  ) {
    return;
  }
  const threadId = threadForSession(frame.sessionId);
  if (!threadId) return;
  const prev = contextMirrors.get(threadId);
  if (
    typeof frame.eventSeq === "number" &&
    typeof prev?.eventSeq === "number" &&
    frame.eventSeq <= prev.eventSeq
  ) {
    return; // 陈旧代际（attach 重放等）
  }
  contextMirrors.set(threadId, {
    usedTokens: frame.usedTokens,
    threshold: frame.threshold,
    contextWindow: frame.contextWindow,
    cacheHitRatio: typeof frame.cacheHitRatio === "number" || frame.cacheHitRatio === null
      ? frame.cacheHitRatio
      : null,
    eventSeq: typeof frame.eventSeq === "number" ? frame.eventSeq : null,
  });
  notifyContextMirrors();
}

/** 完整读数回填镜像（拉取路径：popover 打开/首屏水合/缺口修复） */
export function setContextMirrorFromPull(threadId: string, info: PiContextInfo): void {
  contextMirrors.set(threadId, {
    // 统一口径：sidecar 算好的请求总占用（usage 口径已含系统提示词/工具）。
    // 旧 sidecar 无该字段时按三项相加兜底
    usedTokens:
      info.usedTokens ?? info.messageTokens + info.systemPromptTokens + info.toolTokens,
    threshold: info.hardLimit,
    contextWindow: info.contextWindow,
    cacheHitRatio: info.cacheHitRate,
    eventSeq: null,
  });
  notifyContextMirrors();
}

/** seq-guard kind="context" 的回拉动作：context_info → 镜像（失败静默，
 *  下一轮推送/popover 打开自会补正，不在守卫路径上制造噪音） */
export function refreshContextMirror(threadId: string): void {
  void fetchContextInfo(threadId)
    .then((info) => setContextMirrorFromPull(threadId, info))
    .catch(() => {});
}

/** 占用分项读数：请求总占用（used）的「分区」，三段相加恒等于 used。
 *
 *  面板旧口径把 message/system/tool 三段直接相加画占用条，但 usage 可用时
 *  messageTokens 本身就是整条请求的总量（provider 的 input+output+cacheRead
 *  +cacheWrite，系统提示词与工具声明本就在这条请求里，sidecar 字段注释同义），
 *  相加等于把后两项重复计一遍——占用条虚高、越过阈值竖线而压缩守卫（只认
 *  usedTokens）纹丝不动。此处统一按分区呈现：系统/工具取估算值夹取到 used
 *  以内，余量为对话消息本体。
 *
 *  纯估算分支（旧 sidecar 无 usedTokens）used = 三项之和，分区退化为原值。 */
export type ContextTokenBreakdown = {
  /** 对话消息本体（请求总占用扣除系统提示词与工具声明） */
  message: number;
  system: number;
  tool: number;
  /** 模型可见的请求总占用（占用环/压缩守卫同一口径） */
  used: number;
};

export function contextTokenBreakdown(info: {
  messageTokens: number;
  systemPromptTokens: number;
  toolTokens: number;
  usedTokens?: number;
}): ContextTokenBreakdown {
  const sum = info.messageTokens + info.systemPromptTokens + info.toolTokens;
  const used = info.usedTokens ?? sum;
  const system = Math.min(info.systemPromptTokens, used);
  const tool = Math.min(info.toolTokens, used - system);
  return { message: used - system - tool, system, tool, used };
}

/** 缓存 TTL：空闲超过它的重算归因成「越过缓存有效期」。与 sidecar 的
 *  CACHE_TTL_MS 同值（5min）——数值事实（tokens/idleMs/modelChanged）全由
 *  sidecar 算好，这里只负责把事实说成人话。 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 最近一次缓存重算的归因文案；null = 没有重算记录 */
export function cacheMissCause(
  last: { idleMs: number; modelChanged: boolean } | null | undefined,
): string | null {
  if (!last) return null;
  if (last.modelChanged) return "模型切换";
  if (last.idleMs >= CACHE_TTL_MS) {
    const minutes = Math.max(1, Math.round(last.idleMs / 60_000));
    return `空闲 ${minutes} 分钟，越过缓存有效期`;
  }
  return "未归因（前缀被改写或网关侧失效）";
}

/** 惰性订阅（占用环消费方挂载时触发）：注册一次；通道不支持则镜像
 *  退化为纯拉取（首屏水合 + popover 打开），推送缺位不影响正确性 */
let contextSubStarted = false;
let contextTeardown: (() => void) | null = null;
export function ensureContextSubscription(): void {
  if (contextSubStarted) return;
  contextSubStarted = true;
  void (async () => {
    try {
      const un = await getPiChannel().subscribeContextChanges?.(applyContextChanged);
      contextTeardown = un ?? null;
    } catch {
      contextTeardown = null;
    }
  })();
}

/** 测试/换通道拆除：退订并允许重新订阅（setPiChannel 换 fake 通道间用） */
export function teardownContextSubscription(): void {
  contextTeardown?.();
  contextTeardown = null;
  contextSubStarted = false;
}

/** 响应式读取线程占用镜像（与既有拉取 info 互补：镜像驱动 ring 常显） */
export function usePiContextMirror(
  threadId: string | undefined | null,
): PiContextMirror | null {
  useEffect(() => {
    ensureContextSubscription();
    // 水合拉取：每线程镜像为空时补一次（挂载/切线程/重启后首屏），
    // 常态更新走推送，不再逐轮拉
    if (threadId && !readContextMirror(threadId)) refreshContextMirror(threadId);
  }, [threadId]);
  return useSyncExternalStore(
    subscribeContextMirror,
    () => (threadId ? readContextMirror(threadId) : null),
    () => null,
  );
}

/**
 * 手动压缩上下文：仅空闲回合边界可执行，运行中 sidecar 会拒绝
 * （"session is busy"），由调用方 toast 呈现。压缩要跑一次摘要请求，超时放宽。
 */
export function compactContext(threadId: string): Promise<PiCompacted> {
  const payload = threadPayload(threadId);
  if (!payload) return Promise.reject(new Error("会话尚未创建"));
  return piRequest<PiCompacted>({ type: "compact", ...payload }, 120_000);
}

/**
 * 手动压缩发起时打 start marker：即时渲染「正在压缩上下文…」（请求-响应期间
 * 的过程反馈）。anchorIndex 为打点时刻的消息数，分隔线锚定在当时的尾部消息
 * 之后（compact 走请求-响应、不产生消息流 chunk，见 lib/pi-compaction-marker）。
 * 响应回来后由 markManualCompaction 替换为完成态；失败由调用方清除。
 */
export function markManualCompactionStart(
  threadId: string,
  anchorIndex: number,
): void {
  setManualCompactionMarker({
    threadId,
    remoteId: piSessionIdForThread(threadId),
    anchorIndex,
    data: { phase: "start" },
  });
}

/**
 * 手动压缩成功后替换 marker 为完成态。anchorIndex 沿用 start 时记录的值
 * （由调用方持有），不随压缩期间可能新增的消息漂移。重新装载历史后由
 * 检查点行重建接管。
 */
export function markManualCompaction(
  threadId: string,
  res: PiCompacted,
  anchorIndex: number,
): void {
  setManualCompactionMarker({
    threadId,
    remoteId: piSessionIdForThread(threadId),
    anchorIndex,
    data: {
      phase: "complete",
      generation: res.generation,
      tokensBefore: res.tokensBefore,
      summarized: res.summarized,
      summary: res.summary,
    },
  });
}
