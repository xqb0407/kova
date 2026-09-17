"use client";

import type { ResumableClientStorage } from "@assistant-ui/ai-sdk";

/** 在飞流登记：requestId + 登记时的线程 local id + 该线程绑定的 pi sessionId */
export type PiResumableEntry = {
  requestId: string;
  ownerChatId: string;
  sessionId?: string;
};

const STORAGE_KEY = "pi-resumable-stream";

/** 多槽上限：桌面端并行长跑会话的合理上界，超出按登记序淘汰最旧 */
const MAX_ENTRIES = 10;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * pi 在飞 prompt 的可恢复流登记（刷新续流），实现框架 ResumableClientStorage。
 *
 * 为什么不用框架自带 createResumableSessionStorage：它只把 requestId 值持久化到
 * sessionStorage，owner（谁登记的）仅存内存——刷新后 owner 丢失，任何线程第一次
 * getStreamId/subscribe 都会认领这条登记（`slot.owner ??= threadId`）。而 RemoteThreadList
 * 每次页面加载主线程都是新生成的随机草稿 id，于是草稿劫持在飞流：出现"新对话"行
 * 挂着 AI 流（自身历史为空看不到用户消息）、真实会话却另成一行——一个对话裂成两行。
 *
 * 本实现按线程多槽登记，owner 与 sessionId 一并落盘，认领资格 = owner 本人
 * （同页）或 threadId === sessionId（刷新后 id 即 remoteId 的会话列表行）。
 * 多槽是硬需求：A 会话在跑时用户在 B 发送/刷新，单槽会被 B 顶掉——A 的行
 * 从此无人认领、点开只剩已落盘的用户消息（2026-09-14 实测）。每线程连发
 * 仍是后一轮顶掉前一轮（owner 粒度 upsert），与会话粒度互斥（同一会话换新
 * 线程登记时旧草稿槽一并清除，防双重认领）。
 *
 * 持久化分三层（2026-09-14 登记丢失事故；当日 23:21 重启实测 sessionStorage
 * 整页清空而 localStorage 镜像存活）：
 * 1. sessionStorage 主槽：框架语义（标签页级），⌘R 重载正常存活；
 * 2. localStorage 影子镜像：主槽被整页清空（app 重启/隐私策略/配额连带）时，
 *    读出为空则采信镜像。陈旧镜像无害：run 已死则 attach 拿不到流，
 *    transport 自行 clear 回退历史加载（自愈）；
 * 3. 页内内存镜像：两个 store 都不可用（隐私模式）时同页读写仍一致，
 *    至少保证当页发起/收尾/清理的语义正确，仅续流降级。
 * 所有落盘失败都会 console.warn 留痕——静默吞错正是该事故无从排查的原因。
 */
/** 框架 ResumableClientStorage + pi 扩展：set 携带 sessionId、peekEntries 供启动
 *  回切；subscribe 收窄为必选（本实现总提供） */
export type PiResumableStreamStorage = Omit<
  ResumableClientStorage,
  "setStreamId" | "subscribe"
> & {
  setStreamId(id: string, threadId?: string, sessionId?: string): void;
  subscribe(listener: () => void): () => void;
  peekEntries(): PiResumableEntry[];
};

export function createPiResumableStreamStorage(
  resolveStorage: () => StorageLike | null,
  resolveShadow?: () => StorageLike | null,
): PiResumableStreamStorage {
  const listeners = new Set<() => void>();

  // 页内内存镜像：storage 全部不可用时的最后兜底（见文件头三层设计）
  let memEntries: PiResumableEntry[] = [];

  // 读取失败只告警一次：getStreamId 挂在 React 快照读取热路径上，逐帧告警会刷屏
  let readWarned = false;
  function warnReadOnce(err: unknown): void {
    if (readWarned) return;
    readWarned = true;
    console.warn("[pi-resume-storage] storage read failed (once)", String(err));
  }

  function validEntry(x: unknown): x is PiResumableEntry {
    const e = x as PiResumableEntry;
    return (
      !!e &&
      typeof e.requestId === "string" &&
      typeof e.ownerChatId === "string" &&
      (e.sessionId === undefined || typeof e.sessionId === "string")
    );
  }

  /** 从单个存储槽读；available=false 表示该槽本身不可用（抛异常） */
  function readSlot(store: StorageLike): {
    available: boolean;
    entries: PiResumableEntry[];
  } {
    let raw: string | null;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch (err) {
      warnReadOnce(err);
      return { available: false, entries: [] };
    }
    if (raw === null) return { available: true, entries: [] };
    try {
      const parsed = JSON.parse(raw);
      // 数组格式（当前）：逐项校验；旧版单对象格式兼容读出（升级不丢在飞登记）
      if (Array.isArray(parsed)) {
        return { available: true, entries: parsed.filter(validEntry) };
      }
      if (validEntry(parsed)) {
        return { available: true, entries: [parsed] };
      }
    } catch {
      // 损坏值：自愈清除
    }
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    return { available: true, entries: [] };
  }

  function read(): PiResumableEntry[] {
    const store = resolveStorage();
    if (store) {
      const r = readSlot(store);
      if (r.available) {
        if (r.entries.length > 0) {
          memEntries = r.entries;
          return r.entries;
        }
        // 主槽健康但为空：可能是 webview 清空了 sessionStorage，查影子镜像
        const shadow = resolveShadow?.();
        if (shadow) {
          const s = readSlot(shadow);
          if (s.entries.length > 0) {
            memEntries = s.entries;
            return s.entries;
          }
        }
        memEntries = [];
        return [];
      }
    }
    return memEntries;
  }

  function writeSlot(store: StorageLike, serialized: string | null, label: string): void {
    try {
      if (serialized === null) store.removeItem(STORAGE_KEY);
      else store.setItem(STORAGE_KEY, serialized);
      return;
    } catch (err) {
      // 之前静默吞掉：配额爆满时刷新续流会"登记凭空消失"且毫无痕迹
      // （2026-09-14 双 session 排查实锤），改为大声告警 + 清掉本键重试一次
      console.warn(`[pi-resume-storage] ${label} write failed, prune+retry`, String(err));
    }
    try {
      store.removeItem(STORAGE_KEY);
      if (serialized !== null) store.setItem(STORAGE_KEY, serialized);
    } catch (err2) {
      console.warn(`[pi-resume-storage] ${label} retry failed; degraded`, String(err2));
    }
  }

  function write(entries: PiResumableEntry[]) {
    memEntries = entries;
    const serialized = entries.length > 0 ? JSON.stringify(entries) : null;
    const store = resolveStorage();
    if (store) writeSlot(store, serialized, "session");
    const shadow = resolveShadow?.();
    if (shadow) writeSlot(shadow, serialized, "shadow");
    for (const listener of [...listeners]) listener();
  }

  /** 认领资格：同线程的槽（owner），或 id 即该会话 remoteId 的列表行（sessionId） */
  function entryFor(entries: PiResumableEntry[], threadId?: string): PiResumableEntry | null {
    if (!threadId) return null;
    return (
      entries.find((e) => e.ownerChatId === threadId) ??
      entries.find((e) => e.sessionId === threadId) ??
      null
    );
  }

  return {
    getStreamId(threadId?: string): string | null {
      return entryFor(read(), threadId)?.requestId ?? null;
    },

    /** 第三个参数 sessionId 为可选扩展（接口签名兼容）：set 时即定死归属会话 */
    setStreamId(id: string, threadId?: string, sessionId?: string): void {
      if (!threadId) return;
      const entry: PiResumableEntry = {
        requestId: id,
        ownerChatId: threadId,
        ...(sessionId ? { sessionId } : {}),
      };
      // owner 粒度 upsert（连发顶掉）+ 会话粒度互斥（换线程登记时旧槽清除）
      const next = read().filter(
        (e) =>
          e.ownerChatId !== threadId &&
          !(sessionId !== undefined && e.sessionId === sessionId),
      );
      next.push(entry);
      write(next.slice(-MAX_ENTRIES));
    },

    clear(threadId?: string): void {
      const entries = read();
      const victim = entryFor(entries, threadId);
      if (!victim) return;
      write(entries.filter((e) => e !== victim));
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** 启动恢复（ResumeRunningThread/水合守卫）用：只读快照，含全部在飞槽位 */
    peekEntries(): PiResumableEntry[] {
      return read();
    },
  };
}

export const piResumableStorage = createPiResumableStreamStorage(
  () => (typeof window === "undefined" ? null : window.sessionStorage),
  () => (typeof window === "undefined" ? null : window.localStorage),
);
