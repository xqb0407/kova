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
const REPLY_DETAIL_OPTIONS: { value: ImReplyDetail; label: string }[] = [
  { value: "standard", label: "标准回复" },
  { value: "full", label: "完整回复" },
  { value: "digest", label: "摘要回复" },
  { value: "live", label: "实时进度" },
];

const ReplyDetailPicker: FC<{
  value: ImReplyDetail;
  onChange: (v: ImReplyDetail) => void;
}> = ({ value, onChange }) => (
  // Base UI 的 Value 回显按 items 查 label：不传 items 时触发器只会显示
  // 原始值（如裸 "standard"），与 webhooks 页的格式下拉同款修法
  <Select
    value={value}
    items={REPLY_DETAIL_OPTIONS}
    onValueChange={(v) => onChange(v as ImReplyDetail)}
  >
    <SelectTrigger className="h-8 w-32 text-sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {REPLY_DETAIL_OPTIONS.map((o) => (
        <SelectItem key={o.value} value={o.value}>
          {o.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/** 平台元信息：品牌图标（内联 SVG）+ 展示名（本期仅微信可选，其余灰置） */
const PLATFORM_META: Record<
  string,
  { label: string; icon: FC<{ className?: string }> }
> = {
  wechat: { label: "微信", icon: WeChatIcon },
  feishu: { label: "飞书", icon: FeishuIcon },
  dingtalk: { label: "钉钉", icon: DingTalkIcon },
  wecom: { label: "企业微信", icon: WeComIcon },
};

function platformMeta(platform: string) {
  return PLATFORM_META[platform] ?? PLATFORM_META.wechat;
}

/** 平台下拉 items：Base UI 的触发器回显按 items 查 label，不传只会显示
 *  裸值（如裸 "wechat"），与同文件 ReplyDetailPicker 同款修法 */
const PLATFORM_SELECT_ITEMS: { value: ImPlatformId; label: ReactNode }[] = (
  Object.keys(PLATFORM_META) as ImPlatformId[]
).map((id) => {
  const meta = PLATFORM_META[id];
  const Icon = meta.icon;
  return {
    value: id,
    label: (
      <span className="flex items-center gap-2">
        <Icon className="size-4" />
        {meta.label}
      </span>
    ),
  };
});

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
  label: string;
} {
  if (!enabled) {
    return {
      dot: "bg-zinc-400",
      pill: "bg-muted text-muted-foreground",
      label: "已停用",
    };
  }
  switch (status?.state) {
    case "connected":
      return {
        dot: "bg-emerald-500",
        pill: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        label: "已连接",
      };
    case "connecting":
      return {
        dot: "bg-amber-500",
        pill: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        label: "连接中",
      };
    case "reauth":
      return {
        dot: "bg-red-500",
        pill: "bg-red-500/10 text-red-600 dark:text-red-400",
        label: "需重新扫码",
      };
    case "error":
      return {
        dot: "bg-red-500",
        pill: "bg-red-500/10 text-red-600 dark:text-red-400",
        label: "连接异常",
      };
    default:
      return {
        dot: "bg-zinc-400",
        pill: "bg-muted text-muted-foreground",
        label: bound ? "未连接" : "未绑定",
      };
  }
}

const StatusPill: FC<{
  status: ImChannelStatus | undefined;
  bound: boolean;
  enabled?: boolean;
}> = ({ status, bound, enabled = true }) => {
  const t = statusTone(status, bound, enabled);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        t.pill,
      )}
    >
      <span className={cn("size-1.5 rounded-full", t.dot)} />
      {t.label}
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
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<ImPlatformId>("wechat");
  const available = platforms.filter((p) => p.available);
  const busy = !available.some((p) => p.id === platform);
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
          <DialogTitle>创建 IM Bot</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`例如：${PLATFORM_META[platform]?.label ?? ""}助手`}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">平台</label>
            <Select
              value={platform}
              items={PLATFORM_SELECT_ITEMS}
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
                        {meta.label}
                        {!p.available && (
                          <span className="text-muted-foreground text-xs">即将支持</span>
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
            取消
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void submit()}>
            创建
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
  const items = useThreadItems();
  const options = useMemo(
    () =>
      items
        .map((t) => {
          const sessionId = t.id ? piSessionIdForThread(t.id) : undefined;
          return sessionId ? { id: sessionId, title: t.title || "新对话" } : null;
        })
        .filter((o): o is { id: string; title: string } => o !== null)
        .slice(0, 100),
    [items],
  );
  const sessionItems = useMemo(
    () => [
      { value: "auto", label: "默认（每个聊天自动新建）" },
      ...options.map((o) => ({ value: o.id, label: o.title })),
    ],
    [options],
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
        <SelectItem value="auto">默认（每个聊天自动新建）</SelectItem>
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
const THINKING_OPTIONS: { value: ImThinkingLevel; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

const ThinkingPicker: FC<{
  value: ImThinkingLevel;
  onChange: (v: ImThinkingLevel) => void;
}> = ({ value, onChange }) => (
  <Select
    value={value}
    items={THINKING_OPTIONS}
    onValueChange={(v) => onChange(v as ImThinkingLevel)}
  >
    <SelectTrigger className="h-8 w-24 text-sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {THINKING_OPTIONS.map((o) => (
        <SelectItem key={o.value} value={o.value}>
          {o.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const CwdPicker: FC<{
  cwd: string | null;
  onChange: (cwd: string | null) => void;
}> = ({ cwd, onChange }) => {
  const pick = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "选择工作目录" });
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
            清除
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm" onClick={() => void pick()}>
          <FolderIcon className="size-3.5" />
          未选项目
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
          <div className="text-sm font-medium">已绑定微信账号</div>
          <div
            className={cn(
              "mt-0.5 text-xs",
              reauth ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {reauth
              ? "登录凭证已失效，请解除绑定后重新扫码。"
              : "机器人会在此账号的私聊中接收消息；如需换号请先解除绑定。"}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void imWechatUnbind(channelId)}>
          {reauth ? "重新绑定" : "解除绑定"}
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
            <span className="text-xs leading-tight">二维码暂不可用</span>
          </div>
        ) : qr?.qrcodeImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr.qrcodeImg} alt="绑定二维码" className="size-full rounded-lg" />
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
                ? "绑定成功，正在启动通道…"
                : qr?.status === "scanned"
                  ? "已扫码，请在手机上确认"
                  : qr?.status === "verify"
                    ? "请输入手机微信上显示的数字"
                    : qr?.status === "blocked"
                      ? "验证码多次错误，请稍后重试或刷新二维码"
                      : qr?.status === "binded"
                        ? "该微信已绑定过，无需重复绑定"
                        : qr?.status === "expired"
                          ? "二维码已过期，请刷新后重新扫码"
                          : "微信扫码授权以绑定，机器人将自动绑定"}
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            打开手机微信扫一扫，确认后即可在微信里与 Kova 对话。
          </p>
        </div>

        {qr?.status === "verify" && (
          <div className="flex items-center gap-2">
            <Input
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              placeholder="手机微信显示的数字"
              className="h-8 w-44"
              onKeyDown={(e) => e.key === "Enter" && void submitVerify()}
            />
            <Button size="sm" disabled={verifying || !verifyCode.trim()} onClick={() => void submitVerify()}>
              {verifying ? "提交中…" : "提交"}
            </Button>
          </div>
        )}

        <div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void start()}>
            <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            {error ? "重试" : "刷新二维码"}
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
          <div className="text-sm font-medium">已绑定飞书应用</div>
          <div
            className={cn(
              "mt-0.5 text-xs",
              reauth ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {reauth
              ? "应用连接异常，请重新绑定或检查应用权限。"
              : "机器人会在飞书私聊中接收消息；如需换应用请先解除绑定。"}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void imFeishuUnbind(channelId)}>
          {reauth ? "重新绑定" : "解除绑定"}
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
              <span className="text-xs leading-tight">二维码暂不可用</span>
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
                  ? "绑定成功，正在启动长连接…"
                  : qr?.status === "denied"
                    ? "授权被拒绝，请刷新二维码重试"
                    : qr?.status === "expired"
                      ? "二维码已过期，请刷新重试"
                      : "用飞书扫码授权，将自动创建并绑定应用"}
            </p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {qr?.userCode
                ? `扫码不可用时，可在飞书中输入配对码：${qr.userCode}`
                : "无需公网回调：应用通过长连接接收消息。"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void start()}>
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              {error ? "重试" : "刷新二维码"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setManualOpen((v) => !v)}
            >
              {manualOpen ? "收起手动填写" : "手动填写 App ID / Secret"}
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
                placeholder="应用凭证 Secret"
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
                <SelectItem value="feishu">飞书（中国）</SelectItem>
                <SelectItem value="lark">Lark（国际版）</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={saving || !appId.trim() || !appSecret.trim()}
              onClick={() => void saveManual()}
            >
              {saving ? "校验并绑定…" : "绑定"}
            </Button>
          </div>
          <div className="bg-muted/30 rounded-xl border p-3.5">
            <div className="text-foreground mb-1.5 text-xs font-medium">如何获取凭据</div>
            <div className="text-muted-foreground space-y-1.5 text-xs leading-relaxed">
              <ol className="list-decimal space-y-1 pl-4">
                <li>打开飞书开放平台 → 创建企业自建应用。</li>
                <li>添加「机器人」能力；事件订阅选择 <b>长连接</b>，订阅 im.message.receive_v1。</li>
                <li>在「凭证与基础信息」复制 App ID 与 App Secret。</li>
                <li>创建版本并发布后生效。</li>
              </ol>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openExternal("https://open.feishu.cn/app")}
                >
                  打开飞书开放平台
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
                  机器人事件文档
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
            {reauth ? "连接异常，请重新绑定或检查应用配置。" : boundDesc}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void onUnbind(channelId)}>
          {reauth ? "重新绑定" : "解除绑定"}
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
        <p className="text-muted-foreground text-xs">填写后点击绑定，连上后状态点会变为「已连接」</p>
        <Button size="sm" disabled={saving || !complete} onClick={() => void save()}>
          {saving ? "绑定中…" : "绑定"}
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="bg-muted/30 rounded-xl border p-3.5">
        <div className="text-foreground mb-1.5 text-xs font-medium">如何获取凭据</div>
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
        IM 接入配置依赖桌面端，请在桌面应用中打开。
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="text-muted-foreground rounded-2xl border border-dashed py-16 text-center text-sm">
        当前版本暂未包含 IM 通道服务。
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
                      {meta.label} · {status.label}
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
          创建 IM Bot
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
                  {platformMeta(selected.platform).label} ·{" "}
                  {selected.enabled ? "私聊消息将转发给 Kova 助手" : "通道已停用，不接收消息"}
                </p>
              </div>
              {/* 启用开关：停用只停长轮询，不解绑、不丢会话 */}
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {selected.enabled ? "已启用" : "已停用"}
                </span>
                <Switch
                  checked={selected.enabled}
                  aria-label="启用通道"
                  onCheckedChange={() => void imChannelToggle(selected.id)}
                />
              </div>
            </div>

            <div className="divide-y divide-border/60 border-t border-border/60">
              <DetailSection title="绑定机器人" desc="扫描二维码绑定">
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
                    boundTitle="已绑定钉钉应用"
                    boundDesc="机器人会在钉钉单聊中接收消息；如需换应用请先解除绑定。"
                    guide={
                      <>
                        <ol className="list-decimal space-y-1 pl-4">
                          <li>打开钉钉开放平台 → 应用开发 → 企业内部应用 → 创建应用。</li>
                          <li>在应用能力中添加「机器人」，消息接收方式选择 <b>Stream 模式</b>。</li>
                          <li>在「凭证与基础信息」复制 Client ID（AppKey）与 Client Secret。</li>
                          <li>发布应用版本后生效。</li>
                        </ol>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openExternal("https://open-dev.dingtalk.com/")}
                          >
                            打开钉钉开放平台
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
                            Stream 机器人接入文档
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
                    boundTitle="已绑定企业微信机器人"
                    boundDesc="机器人会在企业微信单聊中接收消息；如需换机器人请先解除绑定。"
                    guide={
                      <>
                        <ol className="list-decimal space-y-1 pl-4">
                          <li>打开企业微信管理后台 → 应用管理 → 智能机器人 → 新建或选择机器人。</li>
                          <li>开启 <b>API 模式</b>，接收方式选择 <b>长连接</b>。</li>
                          <li>复制 BotID 与长连接专用 Secret（注意不是企业应用的 Secret）。</li>
                          <li>开发调试可直接使用；上线前按后台提示发布。</li>
                        </ol>
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openExternal("https://work.weixin.qq.com/wework_admin/frame")}
                          >
                            打开企业微信管理后台
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
                            长连接接入文档
                          </Button>
                        </div>
                      </>
                    }
                    fields={[
                      { key: "botId", label: "BotID", placeholder: "机器人 ID" },
                      { key: "secret", label: "长连接 Secret", placeholder: "机器人 Secret", password: true },
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
                title="选择会话"
                desc="用不同的会话对话"
                action={
                  <SessionPicker
                    pinnedSessionId={selected.pinnedSessionId}
                    onChange={(sid) => void imChannelUpdate(selected.id, { pinnedSessionId: sid })}
                  />
                }
              />

              <DetailSection
                title="机器人回复颗粒度"
                desc={
                  REPLY_DETAIL_OPTIONS.find((o) => o.value === (selected.replyDetail ?? "standard"))
                    ?.label ?? "标准回复"
                }
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
                title="思考深度"
                desc={
                  (selected.thinkingLevel ?? "off") === "off"
                    ? "关闭时不产生思考内容（实时进度档会自动开启）"
                    : "数值越高思考越充分，回复更慢、费用更高"
                }
                action={
                  <ThinkingPicker
                    value={selected.thinkingLevel ?? "off"}
                    onChange={(v) => void imChannelUpdate(selected.id, { thinkingLevel: v })}
                  />
                }
              />

              <DetailSection
                title="工作目录"
                desc="对话信息默认保留的位置"
                action={
                  <CwdPicker
                    cwd={selected.cwd}
                    onChange={(cwd) => void imChannelUpdate(selected.id, { cwd })}
                  />
                }
              />

              <DetailSection
                title="访问控制"
                desc={
                  ownerId
                    ? `仅 owner 可用：${maskOwnerId(ownerId)}`
                    : "还没有 owner：下一条私聊将自动成为 owner"
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selected.bound}
                    onClick={() => void imChannelTest(selected.id)}
                  >
                    发送测试消息
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
                    重置 owner
                  </Button>
                  {!selected.bound && (
                    <span className="text-muted-foreground text-xs">
                      绑定后可发送测试消息
                    </span>
                  )}
                </div>
              </DetailSection>

              <DetailSection
                title="删除 Bot"
                desc="从列表移除这个 Bot"
                action={
                  <Button
                    variant="destructive"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setDeleteTarget(selected)}
                  >
                    <Trash2Icon className="size-3.5" />
                    删除
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
              <div className="text-sm font-medium">还没有 IM Bot</div>
              <div className="text-muted-foreground mt-1 text-xs">
                创建一个 Bot，在微信里直接和 Kova 对话
              </div>
            </div>
            <Button size="sm" className="mt-1 gap-1.5" onClick={() => setCreateOpen(true)}>
              <PlusIcon className="size-4" />
              创建 IM Bot
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
            <AlertDialogTitle>删除「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              将解除绑定并停止接收该 Bot 的消息，历史会话不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) void imChannelDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
