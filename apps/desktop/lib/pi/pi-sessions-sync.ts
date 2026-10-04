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

let frameSync: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** 消费方（侧边栏宿主）注册 reload 回调；传 null 注销并清空去抖窗口 */
export function setSessionsChangedSync(cb: (() => void) | null): void {
  frameSync = cb;
  if (!cb && syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    return;
  }
  // 通道早已注册（桌面端常驻模块二次挂载、远程端 provider 先于本行）：补挂
  if (cb) attachTo(peekPiChannel());
}

/** 短去抖：连续帧（批量归档/改名跟建会话）合并为一次整表刷新；
 *  已有窗口挂起时不再顺延，高频触发下刷新仍会落地 */
function scheduleSync(): void {
  if (!frameSync || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    frameSync?.();
  }, 500);
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
  // 异步登记（Tauri listen）尚未 settle 就换代：settle 后补退订
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
