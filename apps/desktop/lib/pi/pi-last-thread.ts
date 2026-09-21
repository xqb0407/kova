"use client";

/**
 * "最近打开的会话"记录：localStorage 存当前主线程会话的 remoteId（pi sessionId）。
 *
 * 用途：启动回切的兜底——在飞登记（pi-resume-storage）只覆盖"任务还在跑"的场景；
 * 登记不存在（任务已结束/登记写入失败/webview 存储被清）时，仍应回到刷新前的那个
 * 对话，而不是停在空白新草稿（2026-09-14 用户报"刷新后消息都没渲染"的直接观感）。
 *
 * 用 localStorage 而非 sessionStorage：指针的有效期就是"应用这次运行"，但
 * sessionStorage 正是本次事故里怀疑会被整页清空的存储（重启 webview/隐私策略/
 * 配额连带），兜底不能建立在同一个可疑基座上。单窗桌面应用里跨重启回到最近会话
 * 也符合聊天客户端惯例；会话被删时 switchToThread 抛错、调用方静默跳过。
 *
 * 指针是"写通"语义：它恒等于主线程当前所在会话——有 remoteId 就 record，
 * 停在未落盘的新草稿就清空（syncClearLastThread，见 WorkspaceThreadSync）。
 * 用户主动点"新对话"时，所有入口动作驱动地 clearLastThread()，双保险——否则
 * 点完新对话再刷新会被拉回切换前的旧会话（2026-09-22 用户报"选 a → 点新对话 →
 * 刷新回到 a"）。
 *
 * 两种清空必须区分：写通清空每次加载首帧必然发生（主线程先是占位草稿），不能
 * 被当成"用户要新对话"的信号，否则启动回切的意图复查会把 tier-3 整体误杀。
 * 故动作清空另计数（readNewThreadActionCount），ResumeRunningThread 回切前查
 * 计数增量而非指针值。
 *
 * 写通会在启动首帧（主线程必是草稿）把指针清成本次的 null，所以**启动回切不能
 * 现读本指针**，否则读到的是本次清空、回切整体失效。ResumeRunningThread 在首次
 * 渲染（早于任何 effect）用 useState 捕获"上一次加载留下的指针"作为 tier-3 兜底，
 * 并在回切前重读一次做用户意图复查（加载后又点了新对话则放弃回切）。
 *
 * 失败语义：写失败 console.warn 留痕——静默吞错会让续流/回切"凭空失效"无从排查
 * （同 pi-resume-storage 的教训）；读失败按无记录处理。
 */

const KEY = "pi-last-thread";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 工厂形态对齐 pi-resume-storage：存储槽注入，单测用内存桩 */
export function createPiLastThreadStorage(
  resolveStorage: () => StorageLike | null,
) {
  let newThreadActions = 0;
  const remove = () => {
    const store = resolveStorage();
    if (!store) return;
    try {
      store.removeItem(KEY);
    } catch (err) {
      console.warn("[pi-last-thread] clear failed", String(err));
    }
  };
  return {
    record(sessionId: string): void {
      const store = resolveStorage();
      if (!store) return;
      try {
        store.setItem(KEY, sessionId);
      } catch (err) {
        console.warn("[pi-last-thread] record failed", String(err));
      }
    },

    read(): string | null {
      const store = resolveStorage();
      if (!store) return null;
      try {
        return store.getItem(KEY);
      } catch {
        return null;
      }
    },

    /** 写通清空：主线程状态同步用，不携带用户意图 */
    clear(): void {
      remove();
    },

    /** 用户主动"新对话"：清空并计数，供启动回切的意图复查 */
    userNewThread(): void {
      newThreadActions += 1;
      remove();
    },

    newThreadActionCount(): number {
      return newThreadActions;
    },
  };
}

export const piLastThreadStorage = createPiLastThreadStorage(() =>
  typeof window === "undefined" ? null : window.localStorage,
);

export function recordLastThread(sessionId: string): void {
  piLastThreadStorage.record(sessionId);
}

export function readLastThread(): string | null {
  return piLastThreadStorage.read();
}

/** 写通清空（WorkspaceThreadSync 侦到主线程停在未落盘草稿时调用）：不计数、
 *  不算用户意图；启动回切用的是首帧捕获的指针值，不受本次清空影响 */
export function syncClearLastThread(): void {
  piLastThreadStorage.clear();
}

/** 用户主动"新对话"入口的动作驱动清空：作废指针并计入意图计数 */
export function clearLastThread(): void {
  piLastThreadStorage.userNewThread();
}

/** 用户主动"新对话"累计次数（进程内单调）：ResumeRunningThread 回切前查增量 */
export function readNewThreadActionCount(): number {
  return piLastThreadStorage.newThreadActionCount();
}
