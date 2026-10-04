/**
 * 会话清单跨端同步（与桌面端 apps/desktop/lib/pi/pi-sessions-sync.ts 同构）：
 * 会话列表是拉取模型（挂载 list() + 回首页 useFocusEffect 重拉），另一端
 * （桌面/网页）增删改会话时本端要等回首页才追上。sidecar 在清单变化时广播
 * sessions_changed 自发通知帧（广播点见 protocol/stream.ts sendSessionsChanged，
 * 契约见 pi-protocol notifications.ts，WS 网关白名单转发见 remote.rs）。
 * 本模块持有一条常驻订阅：通道注册（runtime-provider setPiChannel）即装配，
 * 换代重挂；cb(null)（重连/登记种子）与变更帧同路——防抖合并成一次整表
 * reload。去抖与注册形态同 automation-live 的 setAutomationFrameSync。
 */
import {
  addPiChannelListener,
  peekPiChannel,
  type PiChannel,
} from "@/lib/pi/pi-channel";

/** 一帧清单变更（契约见 pi-protocol notifications：op + sessionId） */
export type SessionsChangedFrame = {
  op?: "created" | "updated" | "deleted";
  sessionId?: string;
};
/** 去抖窗口内合并的一批帧（消费方按帧判断：自己那一屏要不要动作） */
export type SessionsChangedBatch = { frames: SessionsChangedFrame[] };

let frameSync: ((batch: SessionsChangedBatch) => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** 窗口内累积的帧：list 屏只关心"有变化"，会话屏要按 reason/sessionId 分流 */
let pendingFrames: SessionsChangedFrame[] = [];

/** 消费方注册回调（列表屏=整表 reload；会话屏=删到当前会话退回列表 + 重水合）；
 *  传 null 注销并清空去抖窗口 */
export function setSessionsChangedSync(
  cb: ((batch: SessionsChangedBatch) => void) | null,
): void {
  frameSync = cb;
  if (!cb && syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    pendingFrames = [];
    return;
  }
  // 通道早已注册（列表屏二次挂载、runtime-provider 先于本行）：补挂
  if (cb) attachTo(peekPiChannel());
}

/** 短去抖：连续帧（批量归档/改名跟建会话）合并为一次整表刷新；
 *  已有窗口挂起时不再顺延，高频触发下刷新仍会落地 */
function scheduleSync(frame: SessionsChangedFrame | null): void {
  // null = 登记种子/重连兜底：语义是"清单可能变了"，用空帧表示（消费方按"有变化"处理）
  pendingFrames.push(frame ?? {});
  if (!frameSync || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const frames = pendingFrames;
    pendingFrames = [];
    frameSync?.({ frames });
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
  // 异步登记尚未 settle 就换代：settle 后补退订
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
    // 通道无此能力（mock/老通道）：保持现状，静默降级为拉取模型
    return;
  }
  if (attached === ch) return;
  detachCurrent();
  attached = ch;
  try {
    const sub = ch.subscribeSessionsChanged((frame) =>
      scheduleSync(frame ? { op: frame.op, sessionId: frame.sessionId } : null),
    );
    if (typeof sub === "function") teardown = sub;
    else if (sub) teardownPending = Promise.resolve(sub).catch(() => {});
  } catch {
    teardown = null;
    teardownPending = null;
  }
}

// 模块加载即挂监听（首帧无通道也安全：纯 Set 操作）
addPiChannelListener(attachTo);
