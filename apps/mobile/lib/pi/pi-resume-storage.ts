// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/pi-resume-storage.ts（主工程 apps/desktop/lib/pi/pi-resume-storage.ts）
//
// 改动（移动端）：上游的双层存储（sessionStorage 主槽 + localStorage 影子镜像）
// 在 RN 不成立——没有 sessionStorage/localStorage。改由 lib/mobile/storage.ts
// 的 syncStorage 承担：内存 Map 做同步真值（hydrate 后完整），异步落 AsyncStorage。
// 语义上比桌面端更强一层：AsyncStorage 跨应用重启存活，所以在飞登记不仅扛得住
// 热重载，还扛得住 App 被系统杀掉后重启——正是"新对话行挂着 AI 流、真实会话
// 另成一行"那种裂行事故最需要续流的场景。
//
// 键名加 `pi.` 前缀（上游是 `pi-resumable-stream`）：hydrateStorage() 只捞
// `pi.*` 前缀的键，不加前缀则冷启动读不到，等于没有落盘。

import { syncStorage } from "@/lib/mobile/storage";

/** 在飞流登记：requestId + 登记时的线程 local id + 该线程绑定的 pi sessionId */
export type PiResumableEntry = {
  requestId: string;
  ownerChatId: string;
  sessionId?: string;
};

/** 见文件头：`pi.` 前缀让 hydrateStorage() 捞得到 */
const STORAGE_KEY = "pi.resumable-stream";

/** 多槽上限：并行长跑会话的合理上界，超出按登记序淘汰最旧 */
const MAX_ENTRIES = 10;

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 可恢复流登记的客户端存储接口。 */
export type PiResumableStreamStorage = {
  getStreamId(threadId?: string): string | null;
  setStreamId(id: string, threadId?: string, sessionId?: string): void;
  clear(threadId?: string): void;
  subscribe(listener: () => void): () => void;
  peekEntries(): PiResumableEntry[];
};

export function createPiResumableStreamStorage(
  resolveStorage: () => StorageLike | null,
): PiResumableStreamStorage {
  const listeners = new Set<() => void>();

  /** 读取失败只告警一次：getStreamId 挂在渲染热路径上，逐帧告警会刷屏 */
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

  /** 读取失败只告警一次；损坏值自愈清除（读出空数组） */
  function read(): PiResumableEntry[] {
    const store = resolveStorage();
    if (!store) return [];
    let raw: string | null;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch (err) {
      warnReadOnce(err);
      return [];
    }
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      // 数组格式（当前）：逐项校验；旧版单对象格式兼容读出（升级不丢在飞登记）
      if (Array.isArray(parsed)) return parsed.filter(validEntry);
      if (validEntry(parsed)) return [parsed];
    } catch {
      /* 损坏值：落到下面清除 */
    }
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
    return [];
  }

  function write(entries: PiResumableEntry[]) {
    const store = resolveStorage();
    if (store) {
      try {
        if (entries.length > 0) {
          store.setItem(STORAGE_KEY, JSON.stringify(entries));
        } else {
          store.removeItem(STORAGE_KEY);
        }
      } catch (err) {
        // 静默吞掉的话配额爆满时续流会「登记凭空消失」且毫无痕迹
        console.warn("[pi-resume-storage] write failed", String(err));
      }
    }
    for (const listener of [...listeners]) listener();
  }

  /** 认领资格：同线程的槽（owner），或 id 即该会话 remoteId 的列表行（sessionId） */
  function entryFor(
    entries: PiResumableEntry[],
    threadId?: string,
  ): PiResumableEntry | null {
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

    /** 第三个参数 sessionId 为可选扩展：set 时即定死归属会话 */
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

    /** 启动恢复用：只读快照，含全部在飞槽位 */
    peekEntries(): PiResumableEntry[] {
      return read();
    },
  };
}

/** 惰性 getter：hydrateStorage() 跑完后首次读才是完整值。 */
export const piResumableStorage = createPiResumableStreamStorage(
  () => syncStorage,
);