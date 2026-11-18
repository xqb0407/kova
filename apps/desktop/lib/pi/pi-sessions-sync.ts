"use client";

/**
 * 会话清单跨端同步：会话列表是"挂载时拉 list_sessions"的拉取模型，另一端
 * （移动端↔桌面端↔远程网页端，同一 sidecar/同一索引表）增删改会话后本端
 * 感知不到——此前移动端新建会话，桌面端要手动刷新才显示。
 *
 * 事实源在 sidecar：清单可见集合/标题/分组归属变化时广播 sessions_changed
 * 自发通知帧（广播点见 protocol/stream.ts sendSessionsChanged，契约见
 * pi-protocol notifications.ts，WS 网关白名单转发见 remote.rs）。本模块持有
 * 一条常驻订阅：通道注册（setPiChannel / getPiChannel 惰性创建）即装配，
 * 换代重挂；cb(null)（事件源失效/重连/登记种子）与变更帧同路——防抖合并
 * 成一次整表 reload（reload 不动当前线程运行时）。去抖与注册形态同
 * automation-live 的 setAutomationFrameSync（agent-thread/base 注册 reload）。
 */
import {
  addPiChannelListener,
  peekPiChannel,
  type PiChannel,
} from "@/lib/pi/pi-channel";

let frameSync: (() => void | Promise<void>) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** 正在执行 reload：期间到达的帧不能丢，等本轮结束后补一轮 */
let syncing = false;
let dirty = false;

/** 短去抖：连续帧（批量归档/改名跟建会话）合并为一次整表刷新。
 *  保持 500ms：清单变化是低频事件，缩短窗口只会让整表 reload 更频繁；
 *  刷新期间漏帧的问题由下面的 dirty 补跑解决。 */
const SYNC_DEBOUNCE_MS = 500;

/** 消费方（侧边栏宿主）注册 reload 回调；传 null 注销并清空去抖窗口 */
export function setSessionsChangedSync(cb: (() => void | Promise<void>) | null): void {
  frameSync = cb;
  if (!cb) {
    dirty = false;
    releaseWindowSync();
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    return;
  }
  // 通道早已注册（桌面端常驻模块二次挂载、远程端 provider 先于本行）：补挂
  attachTo(peekPiChannel());
  // 订阅就绪后补一次刷新：启动阶段「初始列表加载」与「订阅挂上」之间落库的
  // 会话（例如桌面刚启动就有 IM 消息进来）没有帧可补，补拉一次兜住窗口。
  if (peekPiChannel()?.subscribeSessionsChanged) scheduleSync();
  // 窗口重新获得焦点/从后台切回：兜底补一次清单。IM/移动端在本窗口不可见时
  // 写入的会话，即使 `sessions_changed` 帧因断连/订阅窗口丢失也不会永远缺席
  // ——用户切回来就能看到。去抖与帧同路，不会每次 focus 都打库。
  ensureWindowSync();
}

let windowSyncCleanup: (() => void) | null = null;

function ensureWindowSync(): void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    windowSyncCleanup
  ) {
    return;
  }
  const onFocus = () => scheduleSync();
  const onVisibility = () => {
    if (!document.hidden) scheduleSync();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  windowSyncCleanup = () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function releaseWindowSync(): void {
  if (!windowSyncCleanup) return;
  windowSyncCleanup();
  windowSyncCleanup = null;
}

/**
 * reload 期间到达的帧置 dirty：
 * AUI 的 `threads.reload()` 在已有加载中会复用同一个 Promise，加载开始之后
 * sidecar 才落库的会话（典型的「IM 首条消息刚落盘」）会错过快照，且没有第二次
 * 帧就永远不会再刷——表现为"有时候侧边栏就是不出新会话"。这里在本轮结束后
 * 无条件补跑一次，把快照窗口之后的变更收进来。
 */
function scheduleSync(): void {
  if (!frameSync) return;
  if (syncing) {
    dirty = true;
    return;
  }
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSync();
  }, SYNC_DEBOUNCE_MS);
}

async function runSync(): Promise<void> {
  if (!frameSync || syncing) {
    if (syncing) dirty = true;
    return;
  }
  syncing = true;
  try {
    await frameSync();
  } catch {
    // reload 失败（网关断开等）不重试风暴：下一帧/重连再补
  } finally {
    syncing = false;
    if (dirty) {
      dirty = false;
      scheduleSync();
    }
  }
}

let attached: PiChannel | null = null;
let teardown: (() => void) | null = null;
let teardownPending: Promise<(() => void) | void> | null = null;

function detachCurrent(): void {
  attached = null;
  if (teardown) {
    const f = teardown;
    teardown = null;
    f();
  }
  // 异步登记（桌面壳 listen）尚未 settle 就换代：settle 后补退订
  if (teardownPending) {
    const p = teardownPending;
    teardownPending = null;
    void p.then((f) => f?.()).catch(() => {});
  }
}

function attachTo(ch: PiChannel | null): void {
  if (!ch) {
    detachCurrent();
    return;
  }
  if (!ch.subscribeSessionsChanged) {
    // 通道无此能力（老 fake/推送型）：保持现状，静默降级为拉取模型
    return;
  }
  if (attached === ch) return;
  detachCurrent();
  attached = ch;
  try {
    const sub = ch.subscribeSessionsChanged(() => scheduleSync());
    if (typeof sub === "function") teardown = sub;
    else if (sub) teardownPending = Promise.resolve(sub).catch(() => {});
  } catch {
    teardown = null;
    teardownPending = null;
  }
}

// 模块加载即挂监听（SSR 安全：纯 Set 操作，不触窗口）
addPiChannelListener(attachTo);
