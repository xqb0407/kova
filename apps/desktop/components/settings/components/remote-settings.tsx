"use client";

import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isDesktop } from "@/lib/desktop-env";
import { copyText, encodePairPayload, type PairPayload } from "@/lib/remote";
import { QRCodeSVG } from "qrcode.react";
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import InputCopy from "@/components/ui/input-copy";

type RemoteStatus = {
  running: boolean;
  port: number | null;
  code: string | null;
  connections: number;
  /** 绑定模式：true = 局域网可达（0.0.0.0），false = 仅本机（127.0.0.1） */
  lan: boolean;
  /** 局域网 WS 地址列表（ws://ip:port/ws，主网卡优先；仅本机时为回环地址） */
  lanAddresses: string[];
  /** 浏览器预览地址列表（http://ip:port，主网卡优先；仅本机时为回环地址） */
  httpAddresses: string[];
};

/** 快速隧道状态（Rust tunnel.rs） */
type TunnelStatus = {
  /** stopped | starting | running | error */
  state: "stopped" | "starting" | "running" | "error";
  /** 公网地址（https://xxx.trycloudflare.com，running 后才有） */
  url: string | null;
  port: number | null;
  binaryPath: string | null;
  /** custom | path | common | app-data */
  binarySource: string | null;
  binaryExists: boolean;
  error: string | null;
  logTail: string[];
};

/** cloudflared 下载进度（Rust `tunnel:download` 事件；语义对齐 backup:progress） */
type TunnelDownload = {
  /** resolve | download | verify | install | done | error */
  phase: string;
  done: number;
  total: number;
  message: string;
};

const DOWNLOAD_PHASE_KEY: Record<string, string> = {
  resolve: "remote.settings.downloadPhaseResolve",
  download: "remote.settings.downloadPhaseDownload",
  verify: "remote.settings.downloadPhaseVerify",
  install: "remote.settings.downloadPhaseInstall",
};

/** 卡片统一两层结构：灰底外壳 + 白色内嵌面板，和设置页其余卡片保持同一套层次 */
const Card: FC<{ className?: string; children: ReactNode }> = ({
  className,
  children,
}) => (
  <div className="rounded-2xl bg-muted/40 p-1.5">
    <div className={cn("rounded-xl bg-background", className)}>{children}</div>
  </div>
);

type StatusTone = "on" | "off" | "warn" | "error";

/** 状态胶囊：圆点 + 文案，替代裸圆点和散落的颜色判断 */
const StatusChip: FC<{ tone: StatusTone; label: string }> = ({ tone, label }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] leading-5 font-medium",
      tone === "on" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      tone === "off" && "bg-muted-foreground/10 text-muted-foreground",
      tone === "warn" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      tone === "error" && "bg-destructive/10 text-destructive",
    )}
  >
    <span
      className={cn(
        "size-1.5 rounded-full",
        tone === "on" && "bg-emerald-500",
        tone === "off" && "bg-muted-foreground/40",
        tone === "warn" && "bg-amber-500",
        tone === "error" && "bg-destructive",
      )}
    />
    {label}
  </span>
);

/** 远程访问页：启停 WS 网关、扫码/配对码、局域网地址。
 *  embedded=true（「远程」主区页签复用）：去掉自带标题与外层留白/限宽，
 *  版式交给宿主容器，避免双标题与大块空白。 */
export const RemoteSettings: FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const t = useT();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  /** cloudflared 下载进度（事件驱动；一次性动作，不进 /status 轮询） */
  const [download, setDownload] = useState<TunnelDownload | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  /** 隧道处于活动态（启动中/运行中）：轮询开关与按钮文案共用 */
  const tunnelActive =
    tunnel?.state === "running" || tunnel?.state === "starting";

  const load = useCallback(() => {
    if (!isDesktop()) return;
    invoke<RemoteStatus>("pi_remote_status")
      .then(setStatus)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    // 隧道状态单独拉：失败不影响页面其余部分
    invoke<TunnelStatus>("pi_tunnel_status")
      .then(setTunnel)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 下载进度事件：listen 只在 桌面壳环境注册，卸载时解绑
  useEffect(() => {
    if (!isDesktop()) return;
    let unlisten: (() => void) | undefined;
    void import("@/desktop-bridge/event").then(({ listen }) =>
      listen<TunnelDownload>("tunnel:download", (e) => {
        setDownload(e.payload);
      }).then((u) => {
        unlisten = u;
      }),
    );
    return () => unlisten?.();
  }, []);

  // 轻量轮询：网关运行中刷新连接数；隧道启动中/运行中刷新地址与状态
  useEffect(() => {
    if (!status?.running && !tunnelActive) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [status?.running, tunnelActive, load]);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (status?.running) {
        await invoke("pi_remote_stop");
      } else {
        await invoke("pi_remote_start", { port: null });
      }
      setStatus(await invoke<RemoteStatus>("pi_remote_status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [status?.running]);

  const refreshCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const code = await invoke<string>("pi_remote_refresh_code");
      setStatus((s) => (s ? { ...s, code } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 切换绑定模式：Rust 端持久化并在网关运行中就地重启（配对码同步重置） */
  const applyLan = useCallback(async (lan: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await invoke<RemoteStatus>("pi_remote_start", { port: null, lan }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 撤销全部已配对设备：删除长效 token 并踢掉所有在连（需重新扫码配对） */
  const revokeAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await invoke<RemoteStatus>("pi_remote_revoke"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async (text: string) => {
    if (await copyText(text)) {
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    }
  }, []);

  const loadTunnel = useCallback(() => {
    if (!isDesktop()) return;
    invoke<TunnelStatus>("pi_tunnel_status")
      .then(setTunnel)
      .catch(() => {});
  }, []);

  /** 启停快速隧道；失败时把真实状态拉回来（错误文案在 tunnel.error 里） */
  const toggleTunnel = useCallback(async () => {
    setTunnelBusy(true);
    setError(null);
    try {
      setTunnel(
        await invoke<TunnelStatus>(
          tunnelActive ? "pi_tunnel_stop" : "pi_tunnel_start",
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      loadTunnel();
    } finally {
      setTunnelBusy(false);
    }
  }, [tunnelActive, loadTunnel]);

  /** 一键下载 cloudflared（GitHub Releases，sha256 校验通过才安装）；进度走 tunnel:download 事件 */
  const downloadCloudflared = useCallback(async () => {
    setTunnelBusy(true);
    setError(null);
    setDownload({ phase: "resolve", done: 0, total: 0, message: t("remote.settings.downloadStarting") });
    try {
      setTunnel(await invoke<TunnelStatus>("pi_tunnel_download"));
      setDownload(null);
    } catch (err) {
      // 失败原因通常已由 tunnel:download 的 error 阶段发来；命令级失败这里兜底
      const msg = err instanceof Error ? err.message : String(err);
      setDownload((d) =>
        d?.phase === "error" ? d : { phase: "error", done: 0, total: 0, message: msg },
      );
      loadTunnel();
    } finally {
      setTunnelBusy(false);
    }
  }, [loadTunnel, t]);

  /** 手动指定 cloudflared 路径（自动解析不到时用；点「恢复自动」传 null 清除） */
  const setCloudflaredPath = useCallback(
    async (path: string | null) => {
      setTunnelBusy(true);
      setError(null);
      try {
        setTunnel(
          await invoke<TunnelStatus>("pi_tunnel_set_binary", { path }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setTunnelBusy(false);
      }
    },
    [],
  );

  const pickCloudflared = useCallback(async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const picked = await open({
        directory: false,
        multiple: false,
        title: t("remote.settings.pickBinaryTitle"),
      });
      if (typeof picked === "string") await setCloudflaredPath(picked);
    } catch {
      // 非 桌面壳环境：无原生文件选择器
    }
  }, [setCloudflaredPath, t]);

  /** 隧道运行中的公网地址：二维码与地址列表优先用它（不在同一网络也能连） */
  const tunnelUrl = tunnel?.state === "running" ? tunnel.url : null;

  // 二维码内容：公网地址优先，其次本机预览地址（扫码直达），都没有时退回配置 JSON
  const qr = useMemo(() => {
    if (!status?.running || !status.code) return null;
    const host = tunnelUrl
      ? `${tunnelUrl.replace(/^https:/, "wss:")}/ws`
      : (status.lanAddresses[0] ?? `ws://127.0.0.1:${status.port ?? 8787}/ws`);
    const data: PairPayload = { v: 1, host, code: status.code };
    const preview = tunnelUrl ?? status.httpAddresses[0];
    if (preview) {
      return {
        value: `${preview}/#h=${encodePairPayload(data)}`,
        direct: true,
      };
    }
    return { value: JSON.stringify(data), direct: false };
  }, [
    status?.running,
    status?.code,
    status?.lanAddresses,
    status?.httpAddresses,
    status?.port,
    tunnelUrl,
  ]);

  if (!isDesktop()) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        {t("remote.settings.desktopOnly")}
      </div>
    );
  }

  const running = status?.running ?? false;
  /** 地址列表：隧道在线时公网地址排在最前（能连的场景优先展示） */
  const httpAddrs = [tunnelUrl, ...(status?.httpAddresses ?? [])].filter(
    (a): a is string => Boolean(a),
  );
  const wsAddrs = [
    tunnelUrl ? `${tunnelUrl.replace(/^https:/, "wss:")}/ws` : null,
    ...(status?.lanAddresses ?? []),
  ].filter((a): a is string => Boolean(a));
  const tunnelSummary = !running
    ? t("remote.settings.tunnelSummaryGatewayOff")
    : !tunnel?.binaryExists
      ? t("remote.settings.tunnelSummaryNoBinary")
      : tunnel?.state === "starting"
        ? t("remote.settings.tunnelSummaryStarting")
        : tunnel?.state === "running"
          ? t("remote.settings.tunnelSummaryRunning", { port: tunnel.port ?? "-" })
          : tunnel?.state === "error"
            ? t("remote.settings.tunnelSummaryError")
            : t("remote.settings.tunnelSummaryIdle");
  /** 下载百分比（总量未知时 null，UI 退化为不确定态文案） */
  const downloadPct =
    download && download.total > 0
      ? Math.min(100, Math.round((download.done / download.total) * 100))
      : null;

  return (
    <div className={cn("flex flex-col gap-8", !embedded && "h-full overflow-y-auto")}>
      <div
        className={cn(
          "flex w-full flex-col gap-8",
          // 独立页（设置页）自管限宽与留白；嵌入模式交给宿主
          !embedded && "max-w-5xl self-center px-8 py-8",
        )}
      >
        {!embedded && <h1 className="text-2xl font-bold tracking-tight">{t("remote.settings.title")}</h1>}

        {/* 远程网关 */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t("remote.settings.gatewayTitle")}</h2>
            <Button
              size="sm"
              variant={running ? "outline" : "default"}
              disabled={busy}
              onClick={() => void toggle()}
            >
              {running ? t("common.action.disable") : t("common.action.enable")}
            </Button>
          </div>
          <Card className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t("remote.settings.gatewayStatus")}</div>
              <div className="text-muted-foreground truncate text-sm">
                {running
                  ? t("remote.settings.gatewayRunning", {
                      port: status?.port ?? "-",
                      connections: status?.connections ?? 0,
                      scope: t(status?.lan ? "remote.settings.scopeLan" : "remote.settings.scopeLocal"),
                    })
                  : t("remote.settings.gatewayIdle")}
              </div>
            </div>
            <StatusChip
              tone={running ? "on" : "off"}
              label={running ? t("remote.settings.statusRunning") : t("remote.settings.statusClosed")}
            />
          </Card>
        </section>

        {/* 公网访问：内置 Cloudflare 快速隧道（免费、无需账号；地址每次启动会变） */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t("remote.settings.publicAccess")}</h2>
            <Button
              size="sm"
              variant={tunnelActive ? "outline" : "default"}
              disabled={!running || tunnelBusy || !(tunnel?.binaryExists ?? false)}
              onClick={() => void toggleTunnel()}
            >
              {tunnel?.state === "starting"
                ? t("common.action.cancel")
                : tunnelActive
                  ? t("common.action.disable")
                  : t("common.action.enable")}
            </Button>
          </div>
          <Card className="flex flex-col gap-2.5 px-4 py-3.5">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("remote.settings.quickTunnel")}</div>
                <div className="text-muted-foreground truncate text-sm">
                  {tunnelSummary}
                </div>
              </div>
              <StatusChip
                tone={
                  tunnel?.state === "running"
                    ? "on"
                    : tunnel?.state === "error"
                      ? "error"
                      : tunnel?.state === "starting"
                        ? "warn"
                        : "off"
                }
                label={
                  tunnel?.state === "running"
                    ? t("remote.settings.tunnelOnline")
                    : tunnel?.state === "starting"
                      ? t("remote.settings.tunnelConnecting")
                      : tunnel?.state === "error"
                        ? t("remote.settings.tunnelDisconnected")
                        : t("remote.settings.tunnelIdle")
                }
              />
            </div>

            {tunnelUrl ? (
              <InputCopy
                value={tunnelUrl}
                className="text-muted-foreground rounded-lg bg-muted/40 px-2.5 py-1.5 font-mono break-all"
              />
            ) : null}

            {!tunnel?.binaryExists ? (
              tunnelBusy ? (
                // 下载中：进度条 + 阶段文案（一次 20-40MB，光有"下载中…"像卡死）
                <div className="flex flex-col gap-1.5">
                  <div className="text-muted-foreground flex items-center justify-between gap-2 text-[13px] leading-5">
                    <span className="min-w-0 truncate">
                      {(() => {
                        const phase = t(DOWNLOAD_PHASE_KEY[download?.phase ?? ""] ?? "remote.settings.downloadPhaseFallback");
                        return download?.message
                          ? t("remote.settings.downloadWithMessage", { phase, message: download.message })
                          : t("remote.settings.downloadPending", { phase });
                      })()}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {downloadPct !== null ? `${downloadPct}%` : ""}
                    </span>
                  </div>
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-foreground h-full rounded-full transition-[width] duration-200"
                      style={{ width: `${downloadPct ?? 0}%` }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void downloadCloudflared()}
                  >
                    {download?.phase === "error" ? t("remote.settings.downloadAgain") : t("remote.settings.downloadButton")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void pickCloudflared()}
                  >
                    {t("remote.settings.pickPath")}
                  </Button>
                </div>
              )
            ) : tunnel.binarySource === "custom" ? (
              <div className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {tunnel.binaryPath}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={tunnelBusy}
                  onClick={() => void setCloudflaredPath(null)}
                >
                  {t("remote.settings.restoreAuto")}
                </Button>
              </div>
            ) : null}

            {tunnel?.state === "error" && tunnel.error ? (
              <div className="text-destructive/90 text-[13px] leading-relaxed">
                {tunnel.error}
              </div>
            ) : null}
            {/* 下载/校验失败的原因就地展示（不再走页面级 error 换掉整页） */}
            {download?.phase === "error" ? (
              <div className="text-destructive/90 text-[13px] leading-relaxed break-all">
                {download.message}
              </div>
            ) : null}
            {tunnel?.state === "error" && tunnel.logTail.length ? (
              <pre className="text-muted-foreground max-h-24 overflow-y-auto rounded-lg bg-muted/40 px-2.5 py-1.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
                {tunnel.logTail.slice(-6).join("\n")}
              </pre>
            ) : null}
          </Card>
          <p className="text-muted-foreground text-[13px] leading-relaxed">
            {t("remote.settings.tunnelFootnote")}
          </p>
        </section>

        {running && (
          <>
            {/* 扫码连接：仅本机模式下地址是 127.0.0.1，手机根本连不上（隧道在线
                时二维码改指公网地址，不受此限）——扫不开的二维码比不给更糟 */}
            {qr ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-base font-semibold">{t("remote.settings.scanTitle")}</h2>
                {status?.lan || tunnelUrl ? (
                  <Card className="flex items-start gap-5 p-4">
                    <div className="shrink-0 rounded-lg bg-white p-2 ring-1 ring-black/5">
                      <QRCodeSVG value={qr.value} size={124} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {qr.direct ? (
                        <InputCopy
                          label={
                            tunnelUrl
                              ? t("remote.settings.qrDirectTunnel")
                              : t("remote.settings.qrDirectLocal")
                          }
                          value={qr.value}
                          className="text-muted-foreground rounded-lg bg-muted/40 mr-1 px-2.5 py-1.5 font-mono break-all "
                        />
                      ) : (
                        <p className="text-muted-foreground text-[13px] leading-5">
                          {t("remote.settings.qrJsonFallback")}
                        </p>
                      )}
                    </div>
                  </Card>
                ) : (
                  <Card className="text-muted-foreground px-4 py-3.5 text-sm">
                    {t("remote.settings.qrLocalOnlyHint")}
                  </Card>
                )}
              </section>
            ) : null}

            {/* 浏览器访问 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">{t("remote.settings.browserAccess")}</h2>
              <Card className="flex flex-col gap-0.5 p-1">
                {httpAddrs.length ? (
                  httpAddrs.map((addr) => (
                    <AddressRow
                      key={addr}
                      addr={addr}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    {t("remote.settings.noLanIpTunnel")}
                  </div>
                )}
              </Card>
              <p className="text-muted-foreground text-[13px] leading-5">
                {tunnelUrl
                  ? t("remote.settings.browserFootnoteTunnel")
                  : status?.lan
                    ? t("remote.settings.browserFootnoteLan")
                    : t("remote.settings.browserFootnoteLocal")}
              </p>
            </section>

            {/* WS 连接地址 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">{t("remote.settings.wsTitle")}</h2>
              <Card className="flex flex-col gap-0.5 p-1">
                {wsAddrs.length ? (
                  wsAddrs.map((addr) => (
                    <AddressRow
                      key={addr}
                      addr={addr}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    {t("remote.settings.noLanIp")}
                  </div>
                )}
              </Card>
              <p className="text-muted-foreground text-[13px] leading-5">
                {t("remote.settings.wsFootnote")}
              </p>
            </section>

            {/* 配对码 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">{t("remote.settings.pairCode")}</h2>
              <Card className="flex items-center gap-3 px-4 py-3.5">
                <span className="rounded-xl bg-muted/50 px-4 py-2 font-mono text-2xl tracking-[0.4em] tabular-nums">
                  {status?.code ?? "------"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void refreshCode()}
                >
                  <RefreshCwIcon className="size-4" />
                  {t("remote.settings.regenerate")}
                </Button>
                {status?.code && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy(status.code!)}
                  >
                    {copied === status.code ? (
                      <CheckIcon className="size-4" />
                    ) : (
                      <CopyIcon className="size-4" />
                    )}
                    {t("common.action.copy")}
                  </Button>
                )}
              </Card>
              <p className="text-muted-foreground text-[13px] leading-5">
                {t("remote.settings.pairCodeFootnote")}
              </p>
            </section>

            {/* 安全与设备 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">{t("remote.settings.securityTitle")}</h2>
              <Card className="flex flex-col divide-y divide-border/60">
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("remote.settings.lanAccess")}</div>
                    <div className="text-muted-foreground text-sm leading-relaxed">
                      {t("remote.settings.lanDesc")}
                    </div>
                    {status?.lan ? (
                      <div className="text-destructive/90 mt-1.5 text-[13px] leading-relaxed">
                        {t("remote.settings.lanWarning")}
                      </div>
                    ) : null}
                  </div>
                  <Switch
                    checked={status?.lan ?? false}
                    disabled={busy}
                    onCheckedChange={(v) => void applyLan(v)}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{t("remote.settings.devicesTitle")}</div>
                    <div className="text-muted-foreground text-sm leading-relaxed">
                      {t("remote.settings.revokeDesc")}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void revokeAll()}
                  >
                    {t("remote.settings.revokeButton")}
                  </Button>
                </div>
              </Card>
            </section>

            <div className="text-muted-foreground rounded-2xl bg-muted/40 px-5 py-4 text-[13px] leading-relaxed">
              {t("remote.settings.hint")}
            </div>
          </>
        )}

        {error && <div className="text-destructive text-sm">{error}</div>}
      </div>
    </div>
  );
};

/** 地址行：等宽展示 + 一键复制 */
const AddressRow: FC<{
  addr: string;
}> = ({ addr }) => (
  <div className="w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-muted/40">
    <InputCopy value={addr} className="shrink-0" />
  </div>
);
