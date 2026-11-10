"use client";

/**
 * 项目实体跨端同步：save_project / delete_project 后 sidecar 广播
 * projects_changed（无 id 自发行），本端去抖重拉项目注册表。
 *
 * 与 pi-sessions-sync 同款装配：通道注册（setPiChannel）即挂载，换代重挂；
 * cb(null)（事件源失效/重连）也重拉一次兜底断档期的项目变更。
 */
import {
  addPiChannelListener,
  peekPiChannel,
  type PiChannel,
} from "@/lib/pi/pi-channel";

let frameSync: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function setProjectsChangedSync(cb: (() => void) | null): void {
  frameSync = cb;
  if (!cb && syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    return;
  }
  if (cb) attachTo(peekPiChannel());
}

function scheduleSync(): void {
  if (!frameSync || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    frameSync?.();
  }, 200);
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
  if (!ch.subscribeProjectsChanged) return;
  if (attached === ch) return;
  detachCurrent();
  attached = ch;
  try {
    const sub = ch.subscribeProjectsChanged(() => scheduleSync());
    if (typeof sub === "function") teardown = sub;
    else if (sub) teardownPending = Promise.resolve(sub).catch(() => {});
  } catch {
    teardown = null;
    teardownPending = null;
  }
}

// 模块加载即挂监听（SSR 安全：纯 Set 操作，不触窗口）
addPiChannelListener(attachTo);
