/**
 * IM 命令注册：通道 CRUD/启停/状态、微信扫码绑定流程、owner 管理。
 * 均为桌面专属管理面命令（远程网关的拒绝清单天然不含它们——远程端
 * 无法调用未列入透传白名单的新命令，无需额外防护）。
 */
import { randomUUID } from "node:crypto";
import { kvDelete } from "../store";
import { logInfo } from "../logging";
import {
  ensureImTables,
  listChannelConfigs,
  saveChannelConfig,
  deleteChannelConfig,
  getWechatCredential,
  setWechatCredential,
  getBinding,
  deleteBinding,
  applyThinkingToChannel,
} from "./router";
import {
  reconcileChannel,
  channelStatuses,
  isChannelBound,
  initImManager,
  stopAllImChannels,
  registerImAdapterFactories,
} from "./manager";
import { getImOwner, resetImOwner } from "./access";
import { ILINK_QR_BASE_URL, IlinkClient } from "./adapters/wechat/ilink-client";

/** 扫码会话（内存态）：协议事实要求逐轮轮询 35s 长连接 + 可重定向主机 +
 *  验证码暂存；删除通道时一并清理 */
interface QrSession {
  qrcode: string;
  /** 二维码内容串（URL，前端本地渲染） */
  content: string;
  createdAt: number;
  /** 当前轮询主机（scaned_but_redirect 后切换） */
  baseUrl: string;
  /** 待提交的手机验证码（need_verifycode 后由用户输入） */
  pendingVerifyCode?: string;
}
const qrSessions = new Map<string, QrSession>();
const QR_TTL_MS = 5 * 60_000;

function dropChannelLocalState(channelId: string): void {
  qrSessions.delete(channelId);
}

/** 平台状态词 → 前端词表（iLink 拼写 "scaned"；补充验证码/重定向/已绑定态） */
function normalizeQrStatus(raw: string): string {
  if (raw === "confirmed") return "confirmed";
  if (raw === "expired") return "expired";
  if (raw === "scaned" || raw === "scanned") return "scanned";
  if (raw === "need_verifycode") return "verify";
  if (raw === "verify_code_blocked") return "blocked";
  if (raw === "binded_redirect") return "binded";
  return "wait";
}

/** baseurl 归一：缺 scheme 时补 https:// */
function normalizeBaseUrl(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

type Register = (name: string, fn: (args: any) => any) => void;

export function setupImCommands(register: Register): void {
  // 建表 + 工厂注册在命令装好时就完成：任意命令路径（含删除）都不会撞
  // "no such table"，且设置页保存早于首次消息也能拉起适配器
  ensureImTables();
  registerImAdapterFactories();

  register("im_channels_list", () => {
    return listChannelConfigs().map((c) => ({
      ...c,
      bound: isChannelBound(c.platform, c.id),
    }));
  });

  register("im_channels_platforms", () => [
    { id: "wechat", label: "微信", available: true },
    { id: "feishu", label: "飞书", available: false },
    { id: "dingtalk", label: "钉钉", available: false },
    { id: "wecom", label: "企业微信", available: false },
  ]);

  register("im_channels_save", (a) => {
    const input = (a?.channel ?? {}) as Record<string, unknown>;
    const id = typeof input.id === "string" && input.id ? input.id : undefined;
    const before = id ? listChannelConfigs().find((c) => c.id === id) : undefined;
    const cfg = saveChannelConfig({
      ...(id ? { id } : {}),
      name: typeof input.name === "string" ? input.name : undefined,
      platform: typeof input.platform === "string" ? input.platform : undefined,
      enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
      pinnedSessionId:
        input.pinnedSessionId === null || typeof input.pinnedSessionId === "string"
          ? (input.pinnedSessionId as string | null)
          : undefined,
      cwd: input.cwd === null || typeof input.cwd === "string" ? (input.cwd as string | null) : undefined,
      replyDetail: typeof input.replyDetail === "string" ? (input.replyDetail as never) : undefined,
      thinkingLevel: typeof input.thinkingLevel === "string" ? (input.thinkingLevel as never) : undefined,
    });
    // 思考档位变更：应用到该通道全部已绑定会话（其它字段变更不动会话档位）
    if (typeof input.thinkingLevel === "string") {
      void applyThinkingToChannel(cfg.id, cfg.thinkingLevel).catch(() => {});
    }
    // 只有「启停 / 平台」变更才需要重启通道；改名、会话、目录、颗粒度、
    // 思考档位都不影响长轮询，避免每次编辑都停连一次（notifystop 抖动）
    const needsReconcile =
      !before || before.enabled !== cfg.enabled || before.platform !== cfg.platform;
    if (needsReconcile) void reconcileChannel(cfg.id).catch(() => {});
    return { ...cfg, bound: isChannelBound(cfg.platform, cfg.id) };
  });

  register("im_channels_delete", (a) => {
    const id = String(a?.id ?? "");
    deleteChannelConfig(id);
    dropChannelLocalState(id);
    // manager 在 cfg 缺失时自行停通道并摘除实例
    void reconcileChannel(id).catch(() => {});
    return null;
  });

  register("im_channels_toggle", (a) => {
    const id = String(a?.id ?? "");
    const cfg = listChannelConfigs().find((c) => c.id === id);
    if (!cfg) throw new Error("channel not found");
    saveChannelConfig({ id, enabled: !cfg.enabled });
    void reconcileChannel(id).catch(() => {});
    return null;
  });

  register("im_channels_status", () => channelStatuses());

  register("im_channels_test", async (a) => {
    const id = String(a?.id ?? "");
    const text = String(a?.text ?? "Kova IM 通道测试消息：收到这条说明通道工作正常。");
    const cfg = listChannelConfigs().find((c) => c.id === id);
    if (!cfg) throw new Error("channel not found");
    const cred = cfg.platform === "wechat" ? getWechatCredential(id) : null;
    if (!cred?.botToken) throw new Error("通道尚未绑定");
    // 目标聊天优先取入参，缺省回落到 owner（首个私聊者）——UI 无需用户手填 id
    const chatId = String(a?.chatId ?? "") || getImOwner(id) || "";
    if (!chatId) throw new Error("还没有用户给机器人发过消息，请先在微信里发一条再测试");
    const client = new IlinkClient({ botToken: cred.botToken, baseUrl: cred.baseUrl || undefined });
    await client.sendText({ toUserId: chatId, text });
    return { chatId };
  });

  /* ------------------------------ 微信扫码绑定 ------------------------------ */

  register("im_wechat_qrcode_start", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const resp = await IlinkClient.getQrcode();
    if ((resp.errcode ?? resp.ret ?? 0) !== 0) {
      throw new Error(`获取二维码失败：${resp.errmsg ?? resp.errcode}`);
    }
    const qrcode = resp.qrcode ?? "";
    if (!qrcode) throw new Error("二维码票据为空");
    // qrcode_img_content 是二维码内容串（URL），不是图片字节：前端本地渲染
    const content = resp.qrcode_img_content ?? "";
    qrSessions.set(channelId, {
      qrcode,
      content,
      createdAt: Date.now(),
      baseUrl: ILINK_QR_BASE_URL,
    });
    return { status: "wait", qrcodeUrl: content };
  });

  register("im_wechat_qrcode_poll", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const session = qrSessions.get(channelId);
    if (!session) return null;
    if (Date.now() - session.createdAt > QR_TTL_MS) {
      qrSessions.delete(channelId);
      return { status: "expired" };
    }
    // 验证码一次性提交：送出后立即清空，避免长轮询节奏下把同一个码
    // 反复上送触发服务端 verify_code_blocked；仍缺码时前端会重新提示输入
    const verifyCode = session.pendingVerifyCode;
    session.pendingVerifyCode = undefined;
    const resp = await IlinkClient.getQrcodeStatus({
      qrcode: session.qrcode,
      baseUrl: session.baseUrl,
      ...(verifyCode ? { verifyCode } : {}),
    });
    const raw = String(resp.status ?? "wait");

    // IDC 重定向：换主机继续轮询（不计入状态变化）
    if (raw === "scaned_but_redirect" && resp.redirect_host) {
      session.baseUrl = normalizeBaseUrl(resp.redirect_host);
      return { status: "wait" };
    }

    const status = normalizeQrStatus(raw);
    if (status === "confirmed") {
      const botToken = resp.bot_token ?? "";
      if (!botToken) {
        qrSessions.delete(channelId);
        return { status: "expired" };
      }
      if (!resp.ilink_bot_id) {
        qrSessions.delete(channelId);
        return { status: "expired", message: "服务器未返回 ilink_bot_id" };
      }
      setWechatCredential(channelId, {
        botToken,
        botId: resp.ilink_bot_id,
        // 会话基址随 confirmed 下发：后续 CGI 走它（协议区域路由）
        baseUrl: normalizeBaseUrl(resp.baseurl),
      });
      qrSessions.delete(channelId);
      // 绑定落定：立即收敛通道（启动长轮询）
      await reconcileChannel(channelId);
      logInfo(`[im] wechat channel bound: ${channelId}`);
      return { status: "confirmed" };
    }
    return { status };
  });

  /** 提交手机端显示的数字验证码（need_verifycode 后由用户输入） */
  register("im_wechat_qrcode_verify", (a) => {
    const channelId = String(a?.channelId ?? "");
    const code = String(a?.code ?? "").trim();
    const session = qrSessions.get(channelId);
    if (!session) throw new Error("扫码会话已失效，请刷新二维码");
    if (!code) throw new Error("请输入验证码");
    session.pendingVerifyCode = code;
    return { status: "wait" };
  });

  /** 解绑（换号/重置）：清凭据与扫码会话、重置 owner，停通道；
   *  绑定表保留（会话延续）；换号后首个私聊者重新成为 owner */
  register("im_wechat_unbind", async (a) => {
    const channelId = String(a?.channelId ?? "");
    kvDelete(`im.wechat.token.${channelId}`);
    // 游标是账号作用域的：换号后旧游标会让新账号的增量漏读
    kvDelete(`im.wechat.cursor.${channelId}`);
    dropChannelLocalState(channelId);
    resetImOwner(channelId);
    await reconcileChannel(channelId);
    return null;
  });

  /* ------------------------------ owner 管理 ------------------------------ */

  register("im_owner_get", (a) => {
    return { senderId: getImOwner(String(a?.channelId ?? "")) };
  });

  register("im_owner_reset", (a) => {
    resetImOwner(String(a?.channelId ?? ""));
    return null;
  });

  /* ------------------------------ 绑定查询/解绑（调试与详情页用） ------------------------------ */

  register("im_binding_get", (a) => {
    return getBinding(String(a?.platform ?? "wechat"), String(a?.channelId ?? ""), String(a?.chatId ?? ""));
  });

  register("im_binding_delete", (a) => {
    deleteBinding(String(a?.platform ?? "wechat"), String(a?.channelId ?? ""), String(a?.chatId ?? ""));
    return null;
  });
}

/** 启动恢复 + 退出收尾（index.ts 在 before-quit 调后者） */
export async function startImSubsystem(): Promise<void> {
  await initImManager();
}

export async function stopImSubsystem(): Promise<void> {
  await stopAllImChannels();
}

/** 供测试/调试：生成通道 id（与 saveChannelConfig 内部规则一致） */
export function newImChannelId(): string {
  return `im-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
