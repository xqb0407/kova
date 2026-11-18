"use client";

/**
 * IM 通道镜像 store：通道清单/状态/平台能力的唯一前端落点。
 * 事实源在桌面主进程（im_channels kv + im_* 命令），本文件只做
 * invoke 封装 + useSyncExternalStore 订阅；错误经 toast 透出。
 *
 * 与 webhooks.ts 的差异：配置主体在主进程（含 secret/cursor/绑定表），
 * 前端不持久化、只镜像；扫码会话是主进程态（im_wechat_qr_start 起，
 * poll 由详情面板轮询拉取）。
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";
import { toast } from "@/components/ui/toast";

export type ImPlatformId = "wechat" | "feishu" | "dingtalk" | "wecom";

/** 平台能力行（im_channels_platforms 返回）：available=false 灰置「即将支持」 */
export interface ImPlatformInfo {
  id: ImPlatformId;
  label: string;
  available: boolean;
  /** 平台是否支持被拉入群聊（微信 iLink 为 false） */
  group?: boolean;
}

export type ImChannelStatusState =
  | "unbound"
  | "connecting"
  | "connected"
  | "reauth"
  | "error";

export interface ImChannelStatus {
  state: ImChannelStatusState;
  /** reauth/error 时的补充说明 */
  message?: string;
}

/** 回复颗粒度四档（与主进程 router 渲染一一对应） */
export type ImReplyDetail = "standard" | "full" | "digest" | "live";

/** 思考深度（侧车 thinking 档位；IM 会话默认 off） */
export type ImThinkingLevel = "off" | "low" | "medium" | "high";

/** 群内可用范围：owner=仅私聊 owner；all=所有群成员 */
export type ImGroupAccess = "owner" | "all";

/** 通道行（im_channels_list 返回，camelCase） */
export interface ImChannel {
  id: string;
  name: string;
  platform: ImPlatformId;
  enabled: boolean;
  /** 是否已绑定平台账号（微信=已扫码拿到 token） */
  bound: boolean;
  /** 是否允许群聊；群消息还需 @机器人 才处理 */
  groupEnabled: boolean;
  /** 群内可用范围：owner=仅私聊 owner（默认）；all=所有群成员 */
  groupAccess: ImGroupAccess;
  /** 新建会话的工作目录；null=应用默认任务目录 */
  cwd: string | null;
  /** 回复颗粒度：standard=助手正文；full=正文+工具摘要；digest=一行摘要；live=进度实时推送 */
  replyDetail: ImReplyDetail;
  /** 思考深度：IM 会话默认 off（不产生思考事件） */
  thinkingLevel: ImThinkingLevel;
  /** 实时连接状态（im_channels_status 拉取后并入） */
  status?: ImChannelStatus;
}

/** 扫码会话快照（im_wechat_qrcode_poll / im_feishu_qrcode_poll 返回） */
export interface ImQrSession {
  status:
    | "wait"
    | "scanned"
    | "confirmed"
    | "expired"
    /** 需要在手机端查看数字并回填（微信） */
    | "verify"
    /** 验证码多次错误被限流（微信） */
    | "blocked"
    /** 该微信已绑定过，无需重复连接 */
    | "binded"
    /** 飞书授权被拒绝 */
    | "denied";
  /** 二维码内容串（URL；前端本地渲染成二维码） */
  qrcodeUrl?: string;
  /** 飞书设备码流程的用户码（扫码不可用时可手输） */
  userCode?: string;
  /** 兼容图片载荷（目前协议不下发图片字节） */
  qrcodeImg?: string;
}

let channels: ImChannel[] = [];
let platforms: ImPlatformInfo[] = [];
let loaded = false;
let unavailable = false;
const EMPTY: ImChannel[] = [];
const EMPTY_PLATFORMS: ImPlatformInfo[] = [];
const listeners = new Set<() => void>();

export interface ImChannelsSnapshot {
  channels: ImChannel[];
  platforms: ImPlatformInfo[];
  loaded: boolean;
  unavailable: boolean;
}

/** 快照必须是「整体对象」：只对比 channels 会让 loaded/unavailable 的变化
 *  被 useSyncExternalStore 的 Object.is 判定吞掉（面板永远停在旧状态）。 */
let snapshot: ImChannelsSnapshot = {
  channels,
  platforms,
  loaded,
  unavailable,
};
const SERVER_SNAPSHOT: ImChannelsSnapshot = {
  channels: EMPTY,
  platforms: EMPTY_PLATFORMS,
  loaded: false,
  unavailable: false,
};

function emit() {
  snapshot = { channels, platforms, loaded, unavailable };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useImChannels(): ImChannelsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getSnapshot(): ImChannelsSnapshot {
  return snapshot;
}
function getServerSnapshot(): ImChannelsSnapshot {
  return SERVER_SNAPSHOT;
}

/** 扫码会话不进全局 store：单面板消费，轮询态存模块级 Map（channelId → 快照） */
const qrSessions = new Map<string, ImQrSession>();
const qrListeners = new Set<() => void>();

function emitQr() {
  for (const l of qrListeners) l();
}

export function useImQrSession(channelId: string): ImQrSession | null {
  return useSyncExternalStore(
    qrSubscribe,
    () => qrSessions.get(channelId) ?? null,
    () => null,
  );
}

function qrSubscribe(listener: () => void) {
  qrListeners.add(listener);
  return () => qrListeners.delete(listener);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function handleInvokeError(e: unknown): void {
  const msg = errText(e);
  // 命令未注册 = 装的是未含 IM 模块的旧主进程：面板降级提示；
  // 命令恢复（主进程重载后）则翻回可用态
  if (msg.includes("not found")) {
    unavailable = true;
    emit();
    return;
  }
  if (unavailable) {
    unavailable = false;
  }
  toast.error(`IM 通道操作失败：${msg}`);
}

/** 启动加载：平台能力 + 通道清单 + 实时状态（失败静默为空态） */
export async function initImChannels(): Promise<void> {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  if (!isDesktop()) return;
  try {
    const list = await invoke<ImChannel[]>("im_channels_list");
    channels = list;
    try {
      platforms = await invoke<ImPlatformInfo[]>("im_channels_platforms");
    } catch {
      platforms = [{ id: "wechat", label: "微信", available: true }];
    }
    await refreshStatuses();
  } catch (e) {
    handleInvokeError(e);
    // 非「命令未注册」的失败（如主进程刚重启）：允许下次挂载重试
    if (!unavailable) loaded = false;
  }
  emit();
}

/** 拉实时连接状态并入镜像（面板轮询/操作后调用） */
export async function refreshStatuses(): Promise<void> {
  if (!isDesktop()) return;
  try {
    const statuses = await invoke<Record<string, ImChannelStatus>>(
      "im_channels_status",
    );
    channels = channels.map((c) => ({ ...c, status: statuses?.[c.id] }));
    emit();
  } catch {
    // 状态仅是增亮信息，失败不打扰
  }
}

export async function imChannelCreate(input: {
  name: string;
  platform: ImPlatformId;
}): Promise<ImChannel | null> {
  try {
    const ch = await invoke<ImChannel>("im_channels_save", {
      channel: { name: input.name, platform: input.platform },
    });
    channels = [...channels, ch];
    emit();
    void refreshStatuses();
    return ch;
  } catch (e) {
    handleInvokeError(e);
    return null;
  }
}

export async function imChannelUpdate(
  id: string,
  patch: Partial<
    Pick<
      ImChannel,
      "name" | "cwd" | "enabled" | "groupEnabled" | "groupAccess" | "replyDetail" | "thinkingLevel"
    >
  >,
): Promise<void> {
  try {
    const ch = await invoke<ImChannel>("im_channels_save", {
      channel: { id, ...patch },
    });
    channels = channels.map((c) => (c.id === id ? { ...c, ...ch } : c));
    emit();
  } catch (e) {
    // 调用方多为 onValueChange/onClick 的 void 调用：这里吞掉并 toast，
    // 不向上抛（未处理的 rejection 会触发 Next 运行时错误覆盖层）
    handleInvokeError(e);
  }
}

export async function imChannelDelete(id: string): Promise<void> {
  try {
    await invoke("im_channels_delete", { id });
    channels = channels.filter((c) => c.id !== id);
    qrSessions.delete(id);
    emit();
  } catch (e) {
    handleInvokeError(e);
  }
}

/** 发起扫码：成功返回 ok；失败返回错误文案（卡片内联展示，不抛错） */
export async function imWechatQrStart(
  channelId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const snap = await invoke<ImQrSession>("im_wechat_qrcode_start", { channelId });
    qrSessions.set(channelId, snap);
    emitQr();
    return { ok: true };
  } catch (e) {
    handleInvokeError(e);
    return { ok: false, error: errText(e) };
  }
}

/** 轮询扫码状态（面板挂载/扫码会话存在时周期调用） */
export async function imWechatQrPoll(channelId: string): Promise<void> {
  try {
    const snap = await invoke<ImQrSession | null>("im_wechat_qrcode_poll", {
      channelId,
    });
    if (snap) {
      // 轮询响应只带状态字段：与已有快照合并，避免把 qrcodeUrl/userCode 覆盖丢失
      const prev = qrSessions.get(channelId);
      qrSessions.set(channelId, { ...prev, ...snap });
      emitQr();
      // confirmed：绑定落定，刷清单与状态
      if (snap.status === "confirmed") {
        await reloadChannels();
      }
    }
  } catch {
    // 轮询失败静默：下一轮再取
  }
}

/** 提交手机端显示的数字验证码（need_verifycode 态） */
export async function imWechatQrVerify(
  channelId: string,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await invoke("im_wechat_qrcode_verify", { channelId, code });
    return { ok: true };
  } catch (e) {
    handleInvokeError(e);
    return { ok: false, error: errText(e) };
  }
}

/** 启用/停用通道（停用后停止长轮询，不解绑） */
export async function imChannelToggle(id: string): Promise<void> {
  try {
    await invoke("im_channels_toggle", { id });
    channels = channels.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c));
    emit();
    void refreshStatuses();
  } catch (e) {
    handleInvokeError(e);
  }
}

/** 发测试消息（主进程复用该通道最近一次入站目标） */
export async function imChannelTest(id: string): Promise<boolean> {
  try {
    await invoke("im_channels_test", { id });
    const platform = channels.find((c) => c.id === id)?.platform;
    const label = platforms.find((p) => p.id === platform)?.label;
    toast.success(label ? `测试消息已发送，请到${label}查看` : "测试消息已发送，请到对应平台查看");
    return true;
  } catch (e) {
    toast.error(`测试消息发送失败：${errText(e)}`);
    return false;
  }
}

/** 当前通道的 owner（首个私聊者）；未建立时 null */
export async function getImOwner(channelId: string): Promise<string | null> {
  try {
    const res = await invoke<{ senderId: string | null }>("im_owner_get", { channelId });
    return res?.senderId ?? null;
  } catch {
    return null;
  }
}

/** 重置 owner：下一条私聊重新成为 owner */
export async function resetImOwner(channelId: string): Promise<void> {
  try {
    await invoke("im_owner_reset", { channelId });
    toast.success("已重置：下一条私聊将重新绑定 owner");
  } catch (e) {
    handleInvokeError(e);
  }
}

/* ------------------------------ 飞书 ------------------------------ */

/** 飞书一键创建应用：出码（设备码授权链接 + user_code） */
export async function imFeishuQrStart(
  channelId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const snap = await invoke<ImQrSession>("im_feishu_qrcode_start", { channelId });
    qrSessions.set(channelId, snap);
    emitQr();
    return { ok: true };
  } catch (e) {
    handleInvokeError(e);
    return { ok: false, error: errText(e) };
  }
}

/** 飞书一键创建应用：轮询授权状态（成功即自动保存凭据并启动长连接） */
export async function imFeishuQrPoll(channelId: string): Promise<void> {
  try {
    const snap = await invoke<ImQrSession | null>("im_feishu_qrcode_poll", { channelId });
    if (snap) {
      const prev = qrSessions.get(channelId);
      qrSessions.set(channelId, {
        ...prev,
        ...snap,
        userCode: prev?.userCode ?? snap.userCode,
      });
      emitQr();
      if (snap.status === "confirmed") await reloadChannels();
    }
  } catch {
    // 轮询失败静默：下一轮重试（避免 3s 一次的 toast 刷屏）
  }
}

/** 飞书手动绑定：App ID / App Secret / 数据域 */
export async function imFeishuAppSave(input: {
  channelId: string;
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await invoke("im_feishu_app_save", input);
    qrSessions.delete(input.channelId);
    emitQr();
    await reloadChannels();
    toast.success("飞书应用绑定成功");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** 飞书解绑（清凭据、重置 owner；绑定会话保留） */
export async function imFeishuUnbind(channelId: string): Promise<void> {
  try {
    await invoke("im_feishu_unbind", { channelId });
    qrSessions.delete(channelId);
    emitQr();
    await reloadChannels();
  } catch (e) {
    handleInvokeError(e);
  }
}

/* ------------------------------ 钉钉 ------------------------------ */

export async function imDingTalkAppSave(input: {
  channelId: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await invoke("im_dingtalk_app_save", input);
    await reloadChannels();
    toast.success("钉钉应用绑定成功");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function imDingTalkUnbind(channelId: string): Promise<void> {
  try {
    await invoke("im_dingtalk_unbind", { channelId });
    await reloadChannels();
  } catch (e) {
    handleInvokeError(e);
  }
}

/* ------------------------------ 企业微信 ------------------------------ */

export async function imWeComAppSave(input: {
  channelId: string;
  botId: string;
  secret: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await invoke("im_wecom_app_save", input);
    await reloadChannels();
    // 认证结果由长连接异步反馈（状态点），这里只提示已保存
    toast.success("已保存，正在连接企业微信…");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function imWeComUnbind(channelId: string): Promise<void> {
  try {
    await invoke("im_wecom_unbind", { channelId });
    await reloadChannels();
  } catch (e) {
    handleInvokeError(e);
  }
}

/** 解绑（换号/重置）：清凭据，停止长轮询；绑定会话保留 */
export async function imWechatUnbind(channelId: string): Promise<void> {
  try {
    await invoke("im_wechat_unbind", { channelId });
    qrSessions.delete(channelId);
    emitQr();
    await reloadChannels();
  } catch (e) {
    handleInvokeError(e);
  }
}

/** 全量重拉清单（绑定落定/删除后）；模块级普通函数（非 hook，可在任何层调用） */
export async function reloadChannels(): Promise<void> {
  if (!isDesktop()) return;
  try {
    channels = await invoke<ImChannel[]>("im_channels_list");
    await refreshStatuses();
  } catch (e) {
    handleInvokeError(e);
  }
  emit();
}
