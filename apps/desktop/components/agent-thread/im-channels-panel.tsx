"use client";

/**
 * IM 通道管理面板（「远程」页 → 接入 IM 页签）。
 * 版式：左列 Bot 清单（品牌色图标 + 状态点）/ 右侧详情大卡片
 * （区块标题+说明在左、操作在右，发丝线分隔）。
 */

import { useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { QRCodeSVG } from "qrcode.react";
import {
  BotIcon,
  FolderIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import {
  DingTalkIcon,
  FeishuIcon,
  WeChatIcon,
  WeComIcon,
} from "@/components/icons/platform-icons";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { pathBasename } from "@/lib/workspace/workspace-store";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import { isDesktop } from "@/lib/desktop-env";
import { openExternal } from "@/lib/external-link";
import {
  useImChannels,
  useImQrSession,
  initImChannels,
  imChannelCreate,
  imChannelDelete,
  imChannelTest,
  imChannelToggle,
  imChannelUpdate,
  imWechatQrStart,
  imWechatQrPoll,
  imWechatQrVerify,
  imWechatUnbind,
  imFeishuQrStart,
  imFeishuQrPoll,
  imFeishuAppSave,
  imFeishuUnbind,
  imDingTalkAppSave,
  imDingTalkUnbind,
  imWeComAppSave,
  imWeComUnbind,
  getImOwner,
  resetImOwner,
  refreshStatuses,
  type ImChannel,
  type ImChannelStatus,
  type ImPlatformId,
  type ImPlatformInfo,
  type ImReplyDetail,
  type ImThinkingLevel,
} from "@/lib/im/channels";

/** 回复颗粒度选项（与主进程 router 渲染一一对应） */
const REPLY_DETAIL_OPTIONS: { value: ImReplyDetail; labelKey: string }[] = [
  { value: "standard", labelKey: "remote.im.replyDetail.standard" },
  { value: "full", labelKey: "remote.im.replyDetail.full" },
  { value: "digest", labelKey: "remote.im.replyDetail.digest" },
  { value: "live", labelKey: "remote.im.replyDetail.live" },
];

const ReplyDetailPicker: FC<{
  value: ImReplyDetail;
  onChange: (v: ImReplyDetail) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  // Base UI 的 Value 回显按 items 查 label：不传 items 时触发器只会显示
  // 原始值（如裸 "standard"），与 webhooks 页的格式下拉同款修法
  return (
    <Select
      value={value}
      items={REPLY_DETAIL_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
      onValueChange={(v) => onChange(v as ImReplyDetail)}
    >
      <SelectTrigger className="h-8 w-32 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {REPLY_DETAIL_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {t(o.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/** 平台元信息：品牌图标（内联 SVG）+ 展示名（可用性以 im_channels_platforms 为准） */
const PLATFORM_META: Record<
  string,
  { labelKey: string; icon: FC<{ className?: string }> }
> = {
  wechat: { labelKey: "remote.im.platform.wechat", icon: WeChatIcon },
  feishu: { labelKey: "remote.im.platform.feishu", icon: FeishuIcon },
  dingtalk: { labelKey: "remote.im.platform.dingtalk", icon: DingTalkIcon },
  wecom: { labelKey: "remote.im.platform.wecom", icon: WeComIcon },
};

function platformMeta(platform: string) {
  return PLATFORM_META[platform] ?? PLATFORM_META.wechat;
}

/** owner id 脱敏展示（前缀 + 尾 4 位） */
function maskOwnerId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** 状态胶囊：颜色 + 文案（停用优先于连接态展示） */
function statusTone(
  status: ImChannelStatus | undefined,
  bound: boolean,
  enabled = true,
): {
  dot: string;
  pill: string;
  labelKey: string;
} {
  if (!enabled) {
    return {
      dot: "bg-zinc-400",
      pill: "bg-muted text-muted-foreground",
      labelKey: "remote.im.status.disabled",
    };
  }
  switch (status?.state) {
    case "connected":
      return {
        dot: "bg-emerald-500",
        pill: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        labelKey: "remote.im.status.connected",
      };
    case "connecting":
      return {
        dot: "bg-amber-500",
        pill: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        labelKey: "remote.im.status.connecting",
      };
    case "reauth":
      return {
        dot: "bg-red-500",
        pill: "bg-red-500/10 text-red-600 dark:text-red-400",
        labelKey: "remote.im.status.reauth",
      };
    case "error":
      return {
        dot: "bg-red-500",
        pill: "bg-red-500/10 text-red-600 dark:text-red-400",
        labelKey: "remote.im.status.error",
      };
    default:
      return {
        dot: "bg-zinc-400",
        pill: "bg-muted text-muted-foreground",
        labelKey: bound ? "remote.im.status.notConnected" : "remote.im.status.unbound",
      };
  }
}

const StatusPill: FC<{
  status: ImChannelStatus | undefined;
  bound: boolean;
  enabled?: boolean;
}> = ({ status, bound, enabled = true }) => {
  const t = useT();
  const tone = statusTone(status, bound, enabled);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        tone.pill,
      )}
    >
      <span className={cn("size-1.5 rounded-full", tone.dot)} />
      {t(tone.labelKey)}
    </span>
  );
};

/* ------------------------------ 创建对话框 ------------------------------ */

const CreateBotDialog: FC<{
  open: boolean;
  platforms: ImPlatformInfo[];
  onClose: () => void;
  onCreated: (id: string) => void;
}> = ({ open, platforms, onClose, onCreated }) => {
  const t = useT();
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<ImPlatformId>("wechat");
  const available = platforms.filter((p) => p.available);
  const busy = !available.some((p) => p.id === platform);
  const platformItems = platforms.map((p) => {
    const meta = platformMeta(p.id);
    const Icon = meta.icon;
    return {
      value: p.id,
      label: (
        <span className="flex items-center gap-2">
          <Icon className="size-4" />
          {t(meta.labelKey)}
        </span>
      ),
    };
  });
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const created = await imChannelCreate({ name: trimmed, platform });
    if (created) {
      setName("");
      onCreated(created.id);
      onClose();
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("remote.im.createBot")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("remote.im.nameLabel")}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("remote.im.namePlaceholder", {
                platform: t(platformMeta(platform).labelKey),
              })}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("remote.im.platformLabel")}</label>
            <Select
              value={platform}
              items={platformItems}
              onValueChange={(v) => setPlatform(v as ImPlatformId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {platforms.map((p) => {
                  const meta = platformMeta(p.id);
                  const Icon = meta.icon;
                  return (
                    <SelectItem key={p.id} value={p.id} disabled={!p.available}>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4" />
                        {t(meta.labelKey)}
                        {!p.available && (
                          <span className="text-muted-foreground text-xs">
                            {t("remote.im.comingSoon")}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.action.cancel")}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void submit()}>
            {t("remote.im.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------ 选择器 ------------------------------ */

/** 会话选择：默认（每聊天自动新建）或钉到已有会话。
 *  列表项 id 是本地 threadId，落库前经 piSessionIdForThread 归一为 sessionId。 */
const SessionPicker: FC<{
  pinnedSessionId: string | null;
  onChange: (sessionId: string | null) => void;
}> = ({ pinnedSessionId, onChange }) => {
  const t = useT();
  const items = useThreadItems();
  const options = useMemo(
    () =>
      items
        .map((item) => {
          const sessionId = item.id ? piSessionIdForThread(item.id) : undefined;
          return sessionId ? { id: sessionId, title: item.title || t("common.newChat") } : null;
        })
        .filter((o): o is { id: string; title: string } => o !== null)
        .slice(0, 100),
    [items, t],
  );
  const sessionItems = useMemo(
    () => [
      { value: "auto", label: t("remote.im.defaultSession") },
      ...options.map((o) => ({ value: o.id, label: o.title })),
    ],
    [options, t],
  );
  return (
    <Select
      value={pinnedSessionId ?? "auto"}
      items={sessionItems}
      onValueChange={(v) => onChange(v === "auto" ? null : v)}
    >
      <SelectTrigger className="h-8 w-56 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">{t("remote.im.defaultSession")}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/** 思考深度选项：off 时模型不产生思考事件（IM 会话默认如此） */
const THINKING_OPTIONS: { value: ImThinkingLevel; labelKey: string }[] = [
  { value: "off", labelKey: "remote.im.thinking.off" },
  { value: "low", labelKey: "remote.im.thinking.low" },
  { value: "medium", labelKey: "remote.im.thinking.medium" },
  { value: "high", labelKey: "remote.im.thinking.high" },
];

const ThinkingPicker: FC<{
  value: ImThinkingLevel;
  onChange: (v: ImThinkingLevel) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  return (
    <Select
      value={value}
      items={THINKING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
      onValueChange={(v) => onChange(v as ImThinkingLevel)}
    >
      <SelectTrigger className="h-8 w-24 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {THINKING_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {t(o.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const CwdPicker: FC<{
  cwd: string | null;
  onChange: (cwd: string | null) => void;
}> = ({ cwd, onChange }) => {
  const t = useT();
  const pick = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: t("remote.im.chooseDirTitle") });
      if (typeof dir === "string") onChange(dir);
    } catch {
      // 非桌面环境无原生对话框
    }
  };
  return (
    <div className="flex items-center gap-1">
      {cwd ? (
        <>
          <span
            className="text-muted-foreground inline-flex max-w-44 items-center gap-1.5 truncate text-sm"
            title={cwd}
          >
            <FolderIcon className="size-3.5 shrink-0" />
            {pathBasename(cwd)}
          </span>
          <Button variant="ghost" size="sm" className="text-muted-foreground h-7 px-2 text-xs" onClick={() => onChange(null)}>
            {t("remote.im.clear")}
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm" onClick={() => void pick()}>
          <FolderIcon className="size-3.5" />
          {t("remote.im.noCwd")}
        </Button>
      )}
    </div>
  );
};

/* ------------------------------ 二维码绑定 ------------------------------ */

const WechatBindCard: FC<{
  channelId: string;
  bound: boolean;
  status?: ImChannelStatus;
}> = ({ channelId, bound, status }) => {
  const t = useT();
  const qr = useImQrSession(channelId);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  const terminal =
    qr?.status === "confirmed" ||
    qr?.status === "expired" ||
    qr?.status === "blocked" ||
    qr?.status === "binded";
  const polling = Boolean(qr && !terminal);

  // 扫码状态接口是 30s 长轮询：必须串行调度（上一轮返回后再排下一轮），
  // 用 setInterval 会在长轮询未返回时叠出多个并发请求。
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await imWechatQrPoll(channelId);
      if (!cancelled) timer = setTimeout(() => void tick(), 2500);
    };
    timer = setTimeout(() => void tick(), 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, channelId]);

  useEffect(() => {
    if (bound || qr || error) return;
    void imWechatQrStart(channelId).then((r) => {
      if (!r.ok) setError(r.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, qr, channelId]);

  useEffect(() => {
    if (qr?.status === "confirmed") void refreshStatuses();
  }, [qr?.status]);

  const start = async () => {
    setRefreshing(true);
    setError(null);
    setVerifyCode("");
    const r = await imWechatQrStart(channelId);
    if (!r.ok) setError(r.error);
    setRefreshing(false);
  };

  const submitVerify = async () => {
    const code = verifyCode.trim();
    if (!code) return;
    setVerifying(true);
    const r = await imWechatQrVerify(channelId, code);
    if (!r.ok) setError(r.error);
    setVerifying(false);
  };

  if (bound) {
    const reauth = status?.state === "reauth";
    return (
      <div className="flex items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10">
          <WeChatIcon className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("remote.im.wechat.boundTitle")}</div>
          <div
            className={cn(
              "mt-0.5 text-xs",
              reauth ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {reauth
              ? t("remote.im.wechat.reauthDesc")
              : t("remote.im.wechat.boundDesc")}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void imWechatUnbind(channelId)}>
          {reauth ? t("remote.im.bind.rebind") : t("remote.im.bind.unbind")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-5">
      <div className="flex size-40 shrink-0 items-center justify-center rounded-xl bg-white p-3 ring-1 ring-border/50">
        {error ? (
          <div className="text-muted-foreground flex flex-col items-center gap-1.5 px-2 text-center">
            <BotIcon className="size-6" />
            <span className="text-xs leading-tight">{t("remote.im.bind.qrUnavailable")}</span>
          </div>
        ) : qr?.qrcodeImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr.qrcodeImg} alt={t("remote.im.bind.qrAlt")} className="size-full rounded-lg" />
        ) : qr?.qrcodeUrl ? (
          <QRCodeSVG value={qr.qrcodeUrl} className="size-full" />
        ) : (
          <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
        <div>
          <p className={cn("text-sm", error && "text-destructive")}>
            {error
              ? error
              : qr?.status === "confirmed"
                ? t("remote.im.wechat.confirmed")
                : qr?.status === "scanned"
                  ? t("remote.im.wechat.scanned")
                  : qr?.status === "verify"
                    ? t("remote.im.wechat.verify")
                    : qr?.status === "blocked"
                      ? t("remote.im.wechat.blocked")
                      : qr?.status === "binded"
                        ? t("remote.im.wechat.binded")
                        : qr?.status === "expired"
                          ? t("remote.im.wechat.expired")
                          : t("remote.im.wechat.scanHint")}
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {t("remote.im.wechat.scanDesc")}
          </p>
        </div>

        {qr?.status === "verify" && (
          <div className="flex items-center gap-2">
            <Input
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              placeholder={t("remote.im.wechat.verifyPlaceholder")}
              className="h-8 w-44"
              onKeyDown={(e) => e.key === "Enter" && void submitVerify()}
            />
            <Button size="sm" disabled={verifying || !verifyCode.trim()} onClick={() => void submitVerify()}>
              {verifying ? t("remote.im.bind.submitting") : t("remote.im.bind.submit")}
            </Button>
          </div>
        )}

        <div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void start()}>
            <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            {error ? t("common.action.retry") : t("remote.im.bind.refreshQr")}
          </Button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------ 飞书绑定 ------------------------------ */

/** 飞书绑定：扫码一键创建应用（设备码）+ 手动填写 App ID/Secret 兜底 */
const FeishuBindCard: FC<{
  channelId: string;
  bound: boolean;
  status?: ImChannelStatus;
}> = ({ channelId, bound, status }) => {
  const t = useT();
  const qr = useImQrSession(channelId);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState<"feishu" | "lark">("feishu");
  const [saving, setSaving] = useState(false);

  const terminal =
    qr?.status === "confirmed" || qr?.status === "expired" || qr?.status === "denied";
  const polling = Boolean(qr && !terminal && qr.status === "wait");

  // 设备码轮询：串行调度（上一轮返回后再排下一轮）
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await imFeishuQrPoll(channelId);
      if (!cancelled) timer = setTimeout(() => void tick(), 3000);
    };
    timer = setTimeout(() => void tick(), 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, channelId]);

  // 首次进入未绑定详情：自动出码（手动模式下不打扰）
  useEffect(() => {
    if (bound || qr || error || manualOpen) return;
    void imFeishuQrStart(channelId).then((r) => {
      if (!r.ok) setError(r.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, qr, channelId, manualOpen]);

  useEffect(() => {
    if (qr?.status === "confirmed") void refreshStatuses();
  }, [qr?.status]);

  const start = async () => {
    setRefreshing(true);
    setError(null);
    const r = await imFeishuQrStart(channelId);
    if (!r.ok) setError(r.error);
    setRefreshing(false);
  };

  const saveManual = async () => {
    const id = appId.trim();
    const secret = appSecret.trim();
    if (!id || !secret) return;
    setSaving(true);
    setError(null);
    const r = await imFeishuAppSave({ channelId, appId: id, appSecret: secret, domain });
    if (!r.ok) setError(r.error);
    setSaving(false);
  };

  if (bound) {
    const reauth = status?.state === "reauth" || status?.state === "error";
    return (
      <div className="flex items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-[#3370FF]/10">
          <FeishuIcon className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t("remote.im.feishu.boundTitle")}</div>
          <div
            className={cn(
              "mt-0.5 text-xs",
              reauth ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {reauth
              ? t("remote.im.feishu.reauthDesc")
              : t("remote.im.feishu.boundDesc")}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void imFeishuUnbind(channelId)}>
          {reauth ? t("remote.im.bind.rebind") : t("remote.im.bind.unbind")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-5">
        <div className="flex size-40 shrink-0 items-center justify-center rounded-2xl border bg-white p-3 shadow-sm">
          {error ? (
            <div className="text-muted-foreground flex flex-col items-center gap-1.5 px-2 text-center">
              <BotIcon className="size-6" />
              <span className="text-xs leading-tight">{t("remote.im.bind.qrUnavailable")}</span>
            </div>
          ) : qr?.qrcodeUrl ? (
            <QRCodeSVG value={qr.qrcodeUrl} className="size-full" />
          ) : (
            <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
          <div>
            <p className={cn("text-sm", error && "text-destructive")}>
              {error
                ? error
                : qr?.status === "confirmed"
                  ? t("remote.im.feishu.confirmed")
                  : qr?.status === "denied"
                    ? t("remote.im.feishu.denied")
                    : qr?.status === "expired"
                      ? t("remote.im.feishu.expired")
                      : t("remote.im.feishu.scanHint")}
            </p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {qr?.userCode
                ? t("remote.im.feishu.userCode", { code: qr.userCode })
                : t("remote.im.feishu.longConnHint")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void start()}>
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              {error ? t("common.action.retry") : t("remote.im.bind.refreshQr")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setManualOpen((v) => !v)}
            >
              {manualOpen ? t("remote.im.feishu.manualCollapse") : t("remote.im.feishu.manualExpand")}
            </Button>
          </div>
        </div>
      </div>

      {manualOpen && (
        <div className="bg-background/60 flex flex-col gap-3 rounded-xl border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium">App ID</label>
              <Input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                className="h-8"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium">App Secret</label>
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={t("remote.im.feishu.secretPlaceholder")}
                className="h-8"
                onKeyDown={(e) => e.key === "Enter" && void saveManual()}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Select value={domain} onValueChange={(v) => setDomain(v as "feishu" | "lark")}>
              <SelectTrigger className="h-8 w-36 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="feishu">{t("remote.im.feishu.domainCn")}</SelectItem>
                <SelectItem value="lark">{t("remote.im.feishu.domainIntl")}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={saving || !appId.trim() || !appSecret.trim()}
              onClick={() => void saveManual()}
            >
              {saving ? t("remote.im.feishu.validating") : t("remote.im.bind.bind")}
            </Button>
          </div>
          <div className="bg-muted/30 rounded-xl border p-3.5">
            <div className="text-foreground mb-1.5 text-xs font-medium">{t("remote.im.feishu.howTo")}</div>
            <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
              <ol className="list-decimal space-y-1 pl-4">
                <li>{t("remote.im.feishu.step1")}</li>
                <li>
                  {t("remote.im.feishu.step2Before")}
                  <b>{t("remote.im.feishu.step2Bold")}</b>
                  {t("remote.im.feishu.step2After")}
                </li>
                <li>{t("remote.im.feishu.step3")}</li>
                <li>{t("remote.im.feishu.step4")}</li>
              </ol>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openExternal("https://open.feishu.cn/app")}
                >
                  {t("remote.im.feishu.openPlatform")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() =>
                    openExternal(
                      "https://open.feishu.cn/document/",
                    )
                  }
                >
                  {t("remote.im.feishu.botDocs")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------ 手动绑定（钉钉 / 企业微信） ------------------------------ */

interface ManualBindField {
  key: string;
  label: string;
  placeholder: string;
  password?: boolean;
}

const ManualBindCard: FC<{
  channelId: string;
  bound: boolean;
  status?: ImChannelStatus;
  icon: FC<{ className?: string }>;
  iconClass: string;
  boundTitle: string;
  boundDesc: string;
  /** 凭据申请引导（步骤 + 外链按钮），未绑定时展示 */
  guide: ReactNode;
  fields: ManualBindField[];
  onSave: (values: Record<string, string>) => Promise<{ ok: true } | { ok: false; error: string }>;
  onUnbind: (channelId: string) => Promise<void>;
}> = ({
  channelId,
  bound,
  status,
  icon: Icon,
  iconClass,
  boundTitle,
  boundDesc,
  guide,
  fields,
  onSave,
  onUnbind,
}) => {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = fields.every((f) => (values[f.key] ?? "").trim().length > 0);

  const save = async () => {
    if (!complete || saving) return;
    setSaving(true);
    setError(null);
    const trimmed: Record<string, string> = {};
    for (const f of fields) trimmed[f.key] = (values[f.key] ?? "").trim();
    const r = await onSave(trimmed);
    if (!r.ok) setError(r.error);
    setSaving(false);
  };

  if (bound) {
    const reauth = status?.state === "reauth" || status?.state === "error";
    return (
      <div className="flex items-center gap-4">
        <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl", iconClass)}>
          <Icon className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{boundTitle}</div>
          <div
            className={cn(
              "mt-0.5 text-xs",
              reauth ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {reauth ? t("remote.im.manual.reauthDesc") : boundDesc}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onUnbind(channelId)}>
          {reauth ? t("remote.im.bind.rebind") : t("remote.im.bind.unbind")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <label className="text-xs font-medium">{f.label}</label>
            <Input
              type={f.password ? "password" : "text"}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
              }
              placeholder={f.placeholder}
              className="h-8"
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">{t("remote.im.bind.bindHint")}</p>
        <Button size="sm" disabled={saving || !complete} onClick={() => void save()}>
          {saving ? t("remote.im.bind.binding") : t("remote.im.bind.bind")}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="bg-muted/30 rounded-xl border p-3.5">
        <div className="text-foreground mb-1.5 text-xs font-medium">{t("remote.im.manual.howTo")}</div>
        <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
          {guide}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------ 详情：区块行 ------------------------------ */

const DetailSection: FC<{
  title: string;
  desc?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, desc, action, children }) => (
  <section className="px-5 py-4">
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="text-muted-foreground mt-0.5 text-xs">{desc}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
    {children && <div className="mt-4">{children}</div>}
  </section>
);

/* ------------------------------ 主面板 ------------------------------ */

export const ImChannelsPanel: FC = () => {
  const t = useT();
  const { channels, platforms, loaded, unavailable } = useImChannels();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ImChannel | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);

  // 切通道即拉 owner（访问控制的展示与重置按钮依赖它）
  useEffect(() => {
    setOwnerId(null);
    if (!selectedId) return;
    let alive = true;
    void getImOwner(selectedId).then((v) => {
      if (alive) setOwnerId(v);
    });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  useEffect(() => {
    void initImChannels();
  }, []);
  useEffect(() => {
    if (channels.length === 0) return;
    const timer = setInterval(() => void refreshStatuses(), 15_000);
    return () => clearInterval(timer);
  }, [channels.length]);
  useEffect(() => {
    if (!selectedId && channels.length > 0) setSelectedId(channels[0].id);
    if (selectedId && !channels.some((c) => c.id === selectedId)) {
      setSelectedId(channels[0]?.id ?? null);
    }
  }, [channels, selectedId]);

  const selected = channels.find((c) => c.id === selectedId) ?? null;

  if (!isDesktop()) {
    return (
      <div className="text-muted-foreground rounded-2xl border border-dashed py-16 text-center text-sm">
        {t("remote.im.panel.desktopOnly")}
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="text-muted-foreground rounded-2xl border border-dashed py-16 text-center text-sm">
        {t("remote.im.panel.unavailable")}
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex gap-6">
        <div className="bg-muted/40 flex w-72 shrink-0 flex-col gap-2 rounded-2xl p-1.5">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl px-3 py-2.5">
              <div className="bg-muted size-9 animate-pulse rounded-xl" />
              <div className="flex-1 space-y-1.5">
                <div className="bg-muted h-3 w-24 animate-pulse rounded" />
                <div className="bg-muted h-2.5 w-16 animate-pulse rounded" />
              </div>
            </div>
          ))}
        </div>
        <div className="bg-muted/30 flex min-h-72 flex-1 animate-pulse rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="flex items-start gap-6">
      {/* 左列：Bot 清单 */}
      <div className="flex w-72 shrink-0 flex-col gap-2">
        {channels.length > 0 && (
          <div className="bg-muted/40 flex flex-col gap-1 rounded-2xl p-1.5">
            {channels.map((ch) => {
              const meta = platformMeta(ch.platform);
              const Icon = meta.icon;
              const status = statusTone(ch.status, ch.bound, ch.enabled);
              const active = selectedId === ch.id;
              return (
                <button
                  key={ch.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-[color,background-color,border-color,box-shadow]",
                    active
                      ? "bg-background ring-1 ring-border/60"
                      : "hover:bg-background/60",
                  )}
                  onClick={() => setSelectedId(ch.id)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center">
                    <Icon className="size-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{ch.name}</span>
                    <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
                      <span className={cn("size-1.5 rounded-full", status.dot)} />
                      {t(meta.labelKey)} · {t(status.labelKey)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <Button
          variant="ghost"
          className="text-muted-foreground hover:text-foreground justify-start gap-2 rounded-xl px-3 text-sm font-normal"
          onClick={() => setCreateOpen(true)}
        >
          <PlusIcon className="size-4" />
          {t("remote.im.createBot")}
        </Button>
      </div>

      {/* 右侧：选中 Bot 详情 */}
      {selected ? (
        <div className="min-w-0 flex-1 overflow-hidden rounded-2xl bg-muted/40 p-1.5">
          <div className="overflow-hidden rounded-xl bg-background">
            {/* 头部 */}
            <div className="flex items-center gap-3 px-5 pt-5 pb-4">
              {(() => {
                const meta = platformMeta(selected.platform);
                const Icon = meta.icon;
                return (
                  <span className="flex size-10 shrink-0 items-center justify-center">
                    <Icon className="size-7" />
                  </span>
                );
              })()}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold">{selected.name}</h2>
                  <StatusPill status={selected.status} bound={selected.bound} enabled={selected.enabled} />
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t(platformMeta(selected.platform).labelKey)} ·{" "}
                  {selected.enabled
                    ? t("remote.im.panel.enabledDesc")
                    : t("remote.im.panel.disabledDesc")}
                </p>
              </div>
              {/* 启用开关：停用只停长轮询，不解绑、不丢会话 */}
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {selected.enabled ? t("common.state.enabled") : t("common.state.disabled")}
                </span>
                <Switch
                  checked={selected.enabled}
                  aria-label={t("remote.im.panel.toggleAria")}
                  onCheckedChange={() => void imChannelToggle(selected.id)}
                />
              </div>
            </div>

            <div className="divide-y divide-border/60 border-t border-border/60">
              <DetailSection
                title={t("remote.im.panel.bindBotTitle")}
                desc={t("remote.im.panel.bindBotDesc")}
              >
                {/* key=通道 id：切通道重挂载，清掉上一个通道的扫码错误/验证码状态 */}
                {selected.platform === "feishu" ? (
                  <FeishuBindCard
                    key={selected.id}
                    channelId={selected.id}
                    bound={selected.bound}
                    status={selected.status}
                  />
                ) : selected.platform === "dingtalk" ? (
                  <ManualBindCard
                    key={selected.id}
                    channelId={selected.id}
                    bound={selected.bound}
                    status={selected.status}
                    icon={DingTalkIcon}
                    iconClass="bg-[#59ADF8]/12"
                    boundTitle={t("remote.im.dingtalk.boundTitle")}
                    boundDesc={t("remote.im.dingtalk.boundDesc")}
                    guide={
                      <>
                        <ol className="list-decimal space-y-1 pl-4">
                          <li>{t("remote.im.dingtalk.step1")}</li>
                          <li>
                            {t("remote.im.dingtalk.step2Before")}
                            <b>{t("remote.im.dingtalk.step2Bold")}</b>
                            {t("remote.im.dingtalk.step2After")}
                          </li>
                          <li>{t("remote.im.dingtalk.step3")}</li>
                          <li>{t("remote.im.dingtalk.step4")}</li>
                        </ol>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openExternal("https://open-dev.dingtalk.com/")}
                          >
                            {t("remote.im.dingtalk.openPlatform")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={() =>
                              openExternal(
                                "https://open.dingtalk.com/document/orgapp/streaming-subscription",
                              )
                            }
                          >
                            {t("remote.im.dingtalk.streamDocs")}
                          </Button>
                        </div>
                      </>
                    }
                    fields={[
                      { key: "clientId", label: "Client ID (AppKey)", placeholder: "dingxxxx" },
                      { key: "clientSecret", label: "Client Secret", placeholder: "AppSecret", password: true },
                    ]}
                    onSave={(v) =>
                      imDingTalkAppSave({
                        channelId: selected.id,
                        clientId: v.clientId ?? "",
                        clientSecret: v.clientSecret ?? "",
                      })
                    }
                    onUnbind={imDingTalkUnbind}
                  />
                ) : selected.platform === "wecom" ? (
                  <ManualBindCard
                    key={selected.id}
                    channelId={selected.id}
                    bound={selected.bound}
                    status={selected.status}
                    icon={WeComIcon}
                    iconClass="bg-[#0383F1]/10"
                    boundTitle={t("remote.im.wecom.boundTitle")}
                    boundDesc={t("remote.im.wecom.boundDesc")}
                    guide={
                      <>
                        <ol className="list-decimal space-y-1 pl-4">
                          <li>{t("remote.im.wecom.step1")}</li>
                          <li>
                            {t("remote.im.wecom.step2Before")}
                            <b>{t("remote.im.wecom.step2ApiBold")}</b>
                            {t("remote.im.wecom.step2Mid")}
                            <b>{t("remote.im.wecom.step2LongBold")}</b>
                            {t("remote.im.wecom.step2After")}
                          </li>
                          <li>{t("remote.im.wecom.step3")}</li>
                          <li>{t("remote.im.wecom.step4")}</li>
                        </ol>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openExternal("https://work.weixin.qq.com/wework_admin/frame")}
                          >
                            {t("remote.im.wecom.openPlatform")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={() =>
                              openExternal(
                                "https://developer.work.weixin.qq.com/document/path/101463",
                              )
                            }
                          >
                            {t("remote.im.wecom.longConnDocs")}
                          </Button>
                        </div>
                      </>
                    }
                    fields={[
                      { key: "botId", label: "BotID", placeholder: t("remote.im.wecom.botIdPlaceholder") },
                      {
                        key: "secret",
                        label: t("remote.im.wecom.secretLabel"),
                        placeholder: t("remote.im.wecom.secretPlaceholder"),
                        password: true,
                      },
                    ]}
                    onSave={(v) =>
                      imWeComAppSave({
                        channelId: selected.id,
                        botId: v.botId ?? "",
                        secret: v.secret ?? "",
                      })
                    }
                    onUnbind={imWeComUnbind}
                  />
                ) : (
                  <WechatBindCard
                    key={selected.id}
                    channelId={selected.id}
                    bound={selected.bound}
                    status={selected.status}
                  />
                )}
              </DetailSection>

              <DetailSection
                title={t("remote.im.panel.sessionTitle")}
                desc={t("remote.im.panel.sessionDesc")}
                action={
                  <SessionPicker
                    pinnedSessionId={selected.pinnedSessionId}
                    onChange={(sid) => void imChannelUpdate(selected.id, { pinnedSessionId: sid })}
                  />
                }
              />

              <DetailSection
                title={t("remote.im.panel.replyTitle")}
                desc={t(
                  REPLY_DETAIL_OPTIONS.find((o) => o.value === (selected.replyDetail ?? "standard"))
                    ?.labelKey ?? "remote.im.replyDetail.standard",
                )}
                action={
                  <ReplyDetailPicker
                    value={selected.replyDetail ?? "standard"}
                    onChange={(v) => {
                      // 选「实时进度」但思考仍关闭时，自动开到「低」——否则
                      // 模型不产生思考事件，进度推送里没有可展示的内容
                      const autoThinking =
                        v === "live" && (selected.thinkingLevel ?? "off") === "off"
                          ? { thinkingLevel: "low" as ImThinkingLevel }
                          : {};
                      void imChannelUpdate(selected.id, { replyDetail: v, ...autoThinking });
                    }}
                  />
                }
              />

              <DetailSection
                title={t("remote.im.panel.thinkingTitle")}
                desc={
                  (selected.thinkingLevel ?? "off") === "off"
                    ? t("remote.im.panel.thinkingOffDesc")
                    : t("remote.im.panel.thinkingDesc")
                }
                action={
                  <ThinkingPicker
                    value={selected.thinkingLevel ?? "off"}
                    onChange={(v) => void imChannelUpdate(selected.id, { thinkingLevel: v })}
                  />
                }
              />

              <DetailSection
                title={t("remote.im.panel.cwdTitle")}
                desc={t("remote.im.panel.cwdDesc")}
                action={
                  <CwdPicker
                    cwd={selected.cwd}
                    onChange={(cwd) => void imChannelUpdate(selected.id, { cwd })}
                  />
                }
              />

              <DetailSection
                title={t("remote.im.panel.accessTitle")}
                desc={
                  ownerId
                    ? t("remote.im.panel.accessOwner", { owner: maskOwnerId(ownerId) })
                    : t("remote.im.panel.accessNoOwner")
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selected.bound}
                    onClick={() => void imChannelTest(selected.id)}
                  >
                    {t("remote.im.panel.sendTest")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    disabled={!ownerId}
                    onClick={() => {
                      void resetImOwner(selected.id).then(() => setOwnerId(null));
                    }}
                  >
                    {t("remote.im.panel.resetOwner")}
                  </Button>
                  {!selected.bound && (
                    <span className="text-muted-foreground text-xs">
                      {t("remote.im.panel.testAfterBind")}
                    </span>
                  )}
                </div>
              </DetailSection>

              <DetailSection
                title={t("remote.im.panel.deleteTitle")}
                desc={t("remote.im.panel.deleteDesc")}
                action={
                  <Button
                    variant="destructive"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setDeleteTarget(selected)}
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("common.action.delete")}
                  </Button>
                }
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 rounded-2xl bg-muted/40 p-1.5">
          <div className="flex min-h-80 flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-background">
            <div className="bg-muted flex size-12 items-center justify-center rounded-2xl">
              <BotIcon className="text-muted-foreground size-6" />
            </div>
            <div className="text-center">
              <div className="text-sm font-medium">{t("remote.im.panel.emptyTitle")}</div>
              <div className="text-muted-foreground mt-1 text-xs">
                {t("remote.im.panel.emptyDesc")}
              </div>
            </div>
            <Button size="sm" className="mt-1 gap-1.5" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-4" />
              {t("remote.im.createBot")}
            </Button>
          </div>
        </div>
      )}

      <CreateBotDialog
        open={createOpen}
        platforms={platforms}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => setSelectedId(id)}
      />
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("remote.im.panel.deleteConfirmTitle", { name: deleteTarget?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("remote.im.panel.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.action.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void imChannelDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              {t("common.action.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
