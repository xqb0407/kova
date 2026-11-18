/**
 * IM 命令注册：通道 CRUD/启停/状态、微信扫码绑定流程、owner 管理。
 * 均为桌面专属管理面命令（远程网关的拒绝清单天然不含它们——远程端
 * 无法调用未列入透传白名单的新命令，无需额外防护）。
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../store";
import { logInfo } from "../logging";
import {
  ensureImTables,
  listChannelConfigs,
  saveChannelConfig,
  deleteChannelConfig,
  getWechatCredential,
  setWechatCredential,
  getFeishuCredential,
  setFeishuCredential,
  setDingTalkCredential,
  setWeComCredential,
  clearChannelCredential,
  getBinding,
  deleteBinding,
  resetChannelBindings,
  applyThinkingToChannel,
  getLastInboundTarget,
  forgetLastInboundTarget,
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
import { getImAdapter } from "./registry";
import { ILINK_QR_BASE_URL, IlinkClient } from "./adapters/wechat/ilink-client";
import {
  beginFeishuAppRegistration,
  pollFeishuAppRegistration,
  verifyFeishuCredential,
  type FeishuDomain,
} from "./adapters/feishu/feishu-auth";

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

/** 飞书一键创建应用：设备码会话（channelId → 设备码与轮询域） */
interface FeishuQrSession {
  deviceCode: string;
  pollDomain: FeishuDomain;
  createdAt: number;
  expiresAt: number;
}
const feishuQrSessions = new Map<string, FeishuQrSession>();

function dropChannelLocalState(channelId: string): void {
  qrSessions.delete(channelId);
  feishuQrSessions.delete(channelId);
  // 最近入站目标也属于通道本地态：换号/换平台后旧目标不再可信
  forgetLastInboundTarget(channelId);
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
  // 存量 IM 会话补来源标（kind='im'）：新会话由 sidecar 在建会话时直接落 kind，
  // 这里兜住升级前创建的绑定。侧栏靠它把「cwd 不是注册项目」的 IM 会话也按
  // 目录分组展示——否则会话在库里、侧栏却完全看不到。
  try {
    // 先清指向已删除会话的陈旧绑定：否则下一条消息会先撞一次
    // "session not found"，用户看到报错还以为 Bot 坏了。清掉后同一条消息
    // 会直接走到「未绑定 → 新建会话」。
    const stale = getDb()
      .prepare(
        `DELETE FROM im_binding
         WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = im_binding.session_id)`,
      )
      .run();
    if (Number(stale.changes ?? 0) > 0) {
      logInfo(`[im] dropped ${stale.changes} stale binding(s) (session deleted)`);
    }
    const tagged = getDb()
      .prepare(
        `UPDATE sessions SET kind = 'im'
         WHERE (kind IS NULL OR kind = '')
           AND id IN (SELECT session_id FROM im_binding)`,
      )
      .run();
    if (Number(tagged.changes ?? 0) > 0) {
      logInfo(`[im] origin backfill: tagged ${tagged.changes} session(s)`);
    }
  } catch (e: unknown) {
    logInfo(`[im] binding backfill skipped: ${e instanceof Error ? e.message : e}`);
  }
  registerImAdapterFactories();

  register("im_channels_list", () => {
    return listChannelConfigs().map((c) => ({
      ...c,
      bound: isChannelBound(c.platform, c.id),
    }));
  });

  register("im_channels_platforms", () => [
    { id: "wechat", label: "微信", available: true },
    { id: "feishu", label: "飞书", available: true },
    { id: "dingtalk", label: "钉钉", available: true },
    { id: "wecom", label: "企业微信", available: true },
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
      cwd: input.cwd === null || typeof input.cwd === "string" ? (input.cwd as string | null) : undefined,
      replyDetail: typeof input.replyDetail === "string" ? (input.replyDetail as never) : undefined,
      thinkingLevel: typeof input.thinkingLevel === "string" ? (input.thinkingLevel as never) : undefined,
    });
    // 平台切换：旧平台凭据/绑定/owner 全部失效，先清理再按新平台重新绑定
    if (before && before.platform !== cfg.platform) {
      clearChannelCredential(before.platform, cfg.id);
      resetChannelBindings(cfg.id);
      resetImOwner(cfg.id);
      dropChannelLocalState(cfg.id);
    } else if (before && before.cwd !== cfg.cwd) {
      // 工作目录变更 = 换了一个工作区：旧绑定继续路由会让 IM 仍在旧目录里
      // 接着聊（必须手动 /new 才生效）。这里直接清掉该通道的全部绑定，下一条
      // 消息在新目录新建会话；前端在切换前会弹确认提醒上下文不延续。
      resetChannelBindings(cfg.id);
    }
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
    if (!isChannelBound(cfg.platform, id)) throw new Error("通道尚未绑定");
    // 停用通道适配器已下线：微信/飞书/钉钉还能靠 kv 凭据直发，企微会直接失败，
    // 统一在这里拦下，避免不同平台报错口径不一致
    if (!cfg.enabled) throw new Error("通道已停用，请先启用后再发送测试消息");
    // 目标优先级：显式入参 → 该通道最近一次入站目标（含平台私有回复凭据）
    const explicit = String(a?.chatId ?? "").trim();
    const target = explicit
      ? { chatId: explicit }
      : getLastInboundTarget(id);
    if (!target) {
      throw new Error(
        "暂无可用的发送目标（重启、解绑或重置 owner 后会清空），请先在对应平台里发一条消息再测试",
      );
    }
    const adapter = getImAdapter(cfg.platform as never, id);
    if (!adapter) throw new Error(`平台 ${cfg.platform} 的适配器未注册`);
    try {
      await adapter.sendText(target, text);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // 钉钉 sessionWebhook 约 1.5h 过期：把裸 HTTP 错误换成可操作的下一步
      if (cfg.platform === "dingtalk" && message.startsWith("钉钉发送失败")) {
        throw new Error(
          `${message}（钉钉会话凭据约 1.5 小时过期，请在钉钉里重新发一条消息后重试）`,
        );
      }
      throw e;
    }
    return { chatId: target.chatId };
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
      // 新账号绑定：旧账号的发送锚点（chatId/context_token）不再可信
      forgetLastInboundTarget(channelId);
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
    clearChannelCredential("wechat", channelId);
    dropChannelLocalState(channelId);
    resetImOwner(channelId);
    await reconcileChannel(channelId);
    return null;
  });

  /* ------------------------------ 飞书绑定 ------------------------------ */

  /** 手动绑定：校验凭据（换取租户 token 成功）后加密落库并启动长连接 */
  register("im_feishu_app_save", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const cfg = listChannelConfigs().find((c) => c.id === channelId);
    if (!cfg) throw new Error("channel not found");
    if (cfg.platform !== "feishu") throw new Error("该通道不是飞书平台");
    const appId = String(a?.appId ?? "").trim();
    const appSecret = String(a?.appSecret ?? "").trim();
    const domain: FeishuDomain = a?.domain === "lark" ? "lark" : "feishu";
    if (!appId || !appSecret) throw new Error("请填写 App ID 与 App Secret");
    await verifyFeishuCredential({ appId, appSecret, domain });
    setFeishuCredential(channelId, { appId, appSecret, domain });
    dropChannelLocalState(channelId); // 清掉可能滞留的待扫码会话
    await reconcileChannel(channelId);
    logInfo(`[im] feishu channel bound (manual): ${channelId}`);
    return { appId, domain };
  });

  /** 一键创建应用：出二维码（设备码授权链接） */
  register("im_feishu_qrcode_start", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const cfg = listChannelConfigs().find((c) => c.id === channelId);
    if (!cfg) throw new Error("channel not found");
    if (cfg.platform !== "feishu") throw new Error("该通道不是飞书平台");
    const begin = await beginFeishuAppRegistration();
    feishuQrSessions.set(channelId, {
      deviceCode: begin.deviceCode,
      pollDomain: begin.pollDomain,
      createdAt: Date.now(),
      expiresAt: begin.expiresAt,
    });
    return {
      status: "wait",
      qrcodeUrl: begin.qrUrl,
      userCode: begin.userCode,
    };
  });

  /** 一键创建应用：轮询授权状态；成功后保存凭据并启动长连接 */
  register("im_feishu_qrcode_poll", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const session = feishuQrSessions.get(channelId);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      feishuQrSessions.delete(channelId);
      return { status: "expired" };
    }
    const result = await pollFeishuAppRegistration({
      deviceCode: session.deviceCode,
      pollDomain: session.pollDomain,
    });
    if (result.status === "pending") {
      session.pollDomain = result.pollDomain;
      return { status: "wait" };
    }
    if (result.status === "error") {
      feishuQrSessions.delete(channelId);
      throw new Error(result.message);
    }
    if (result.status === "denied" || result.status === "expired") {
      feishuQrSessions.delete(channelId);
      return { status: result.status };
    }
    // success
    setFeishuCredential(channelId, {
      appId: result.appId,
      appSecret: result.appSecret,
      domain: result.domain,
    });
    // 新应用绑定：旧应用的 chat_id/message_id 锚点不再可信
    forgetLastInboundTarget(channelId);
    feishuQrSessions.delete(channelId);
    await reconcileChannel(channelId);
    logInfo(`[im] feishu channel bound (one-click): ${channelId}`);
    return { status: "confirmed", appId: result.appId, appName: result.appName ?? "" };
  });

  /** 解绑：清凭据 + 重置 owner，绑定会话保留 */
  register("im_feishu_unbind", async (a) => {
    const channelId = String(a?.channelId ?? "");
    clearChannelCredential("feishu", channelId);
    dropChannelLocalState(channelId);
    resetImOwner(channelId);
    await reconcileChannel(channelId);
    return null;
  });

  /* ------------------------------ 钉钉绑定 ------------------------------ */

  /** 钉钉手动绑定：先校验 Client ID/Secret（gettoken 成功），再加密落库并连 Stream */
  register("im_dingtalk_app_save", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const cfg = listChannelConfigs().find((c) => c.id === channelId);
    if (!cfg) throw new Error("channel not found");
    if (cfg.platform !== "dingtalk") throw new Error("该通道不是钉钉平台");
    const clientId = String(a?.clientId ?? "").trim();
    const clientSecret = String(a?.clientSecret ?? "").trim();
    if (!clientId || !clientSecret) throw new Error("请填写 Client ID 与 Client Secret");
    let resp: Response;
    try {
      resp = await fetch(
        `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(clientId)}&appsecret=${encodeURIComponent(clientSecret)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch (e: unknown) {
      const reason =
        e instanceof Error && /fetch failed/i.test(e.message)
          ? ((e as { cause?: { code?: string } }).cause?.code ?? "网络不可达")
          : e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")
            ? "请求超时"
            : String(e);
      throw new Error(`钉钉凭据校验失败：${reason}`);
    }
    const payload = (await resp.json().catch(() => ({}))) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
    };
    if (!resp.ok || payload.errcode !== 0 || !payload.access_token) {
      throw new Error(
        `钉钉凭据校验失败：${payload.errmsg ?? `HTTP ${resp.status}`}`,
      );
    }
    setDingTalkCredential(channelId, { clientId, clientSecret });
    dropChannelLocalState(channelId);
    await reconcileChannel(channelId);
    logInfo(`[im] dingtalk channel bound: ${channelId}`);
    return { clientId };
  });

  register("im_dingtalk_unbind", async (a) => {
    const channelId = String(a?.channelId ?? "");
    clearChannelCredential("dingtalk", channelId);
    dropChannelLocalState(channelId);
    resetImOwner(channelId);
    await reconcileChannel(channelId);
    return null;
  });

  /* ------------------------------ 企业微信绑定 ------------------------------ */

  /** 企业微信智能机器人：保存 BotID/Secret 后立即建立长连接（认证结果由状态点反馈） */
  register("im_wecom_app_save", async (a) => {
    const channelId = String(a?.channelId ?? "");
    const cfg = listChannelConfigs().find((c) => c.id === channelId);
    if (!cfg) throw new Error("channel not found");
    if (cfg.platform !== "wecom") throw new Error("该通道不是企业微信平台");
    const botId = String(a?.botId ?? "").trim();
    const secret = String(a?.secret ?? "").trim();
    if (!botId || !secret) throw new Error("请填写 BotID 与 Secret");
    setWeComCredential(channelId, { botId, secret });
    dropChannelLocalState(channelId);
    await reconcileChannel(channelId);
    logInfo(`[im] wecom channel bound: ${channelId}`);
    return { botId };
  });

  register("im_wecom_unbind", async (a) => {
    const channelId = String(a?.channelId ?? "");
    clearChannelCredential("wecom", channelId);
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
    const channelId = String(a?.channelId ?? "");
    resetImOwner(channelId);
    // 旧 owner 的聊天不再可信：避免重置后测试消息仍发给前任 owner
    forgetLastInboundTarget(channelId);
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
