"use client";

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/lib/tauri";
import { copyText, encodePairPayload, type PairPayload } from "@/lib/remote";
import { QRCodeSVG } from "qrcode.react";
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
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

const REMOTE_HINT =
  "开启后手机扫码或访问地址即可直接使用（应用自带网页，无需另外部署）；不在同一网络时打开下方「公网访问」的 Cloudflare 快速隧道（免费、无需账号），也可继续手动用命名隧道或 Tailscale，详见 docs/remote-access.md。网页端凭配对码换取长效 token 后即可远程操作本机助手（含文件能力），请勿泄露配对码与地址。";

/** cloudflared 下载进度（Rust `tunnel:download` 事件；语义对齐 backup:progress） */
type TunnelDownload = {
  /** resolve | download | verify | install | done | error */
  phase: string;
  done: number;
  total: number;
  message: string;
};

const DOWNLOAD_PHASE_LABEL: Record<string, string> = {
  resolve: "获取下载地址",
  download: "下载 cloudflared",
  verify: "校验文件",
  install: "安装",
};

/** 远程访问页：启停 WS 网关、扫码/配对码、局域网地址 */
export const RemoteSettings: FC = () => {
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
    if (!isTauri()) return;
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

  // 下载进度事件：listen 只在 Tauri 环境注册，卸载时解绑
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
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
    if (!isTauri()) return;
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
    setDownload({ phase: "resolve", done: 0, total: 0, message: "正在获取下载地址" });
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
  }, [loadTunnel]);

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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: false,
        multiple: false,
        title: "选择 cloudflared 可执行文件",
      });
      if (typeof picked === "string") await setCloudflaredPath(picked);
    } catch {
      // 非 Tauri 环境：无原生文件选择器
    }
  }, [setCloudflaredPath]);

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

  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        远程访问配置依赖桌面端，请在 Tauri 应用中打开设置。
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
    ? "先开启远程网关，隧道才有回源目标"
    : !tunnel?.binaryExists
      ? "未检测到 cloudflared：可一键下载，或指定本地路径"
      : tunnel?.state === "starting"
        ? "正在连接 Cloudflare（首次约 5-10 秒）"
        : tunnel?.state === "running"
          ? `运行中 · 回源端口 ${tunnel.port ?? "-"}`
          : tunnel?.state === "error"
            ? "隧道已断开，可重试"
            : "未开启，开启后获得一个临时公网地址（HTTPS/WSS）";
  /** 下载百分比（总量未知时 null，UI 退化为不确定态文案） */
  const downloadPct =
    download && download.total > 0
      ? Math.min(100, Math.round((download.done / download.total) * 100))
      : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight">远程访问</h1>

        {/* 远程网关 */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">远程网关</h2>
            <Button
              size="sm"
              variant={running ? "outline" : "default"}
              disabled={busy}
              onClick={() => void toggle()}
            >
              {running ? "关闭" : "开启"}
            </Button>
          </div>
          <div className="bg-muted/50 flex items-center justify-between gap-4 rounded-2xl px-5 py-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">网关状态</div>
              <div className="text-muted-foreground truncate text-sm">
                {running
                  ? `运行中 · 端口 ${status?.port ?? "-"} · ${status?.connections ?? 0} 个连接 · ${status?.lan ? "局域网" : "仅本机"}`
                  : "未开启，开启后手机扫码或访问地址即可使用"}
              </div>
            </div>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 text-xs",
                running ? "text-primary" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  running ? "bg-lime-500" : "bg-muted-foreground/40",
                )}
              />
              {running ? "运行中" : "已关闭"}
            </span>
          </div>
        </section>

        {/* 公网访问：内置 Cloudflare 快速隧道（免费、无需账号；地址每次启动会变） */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">公网访问</h2>
            <Button
              size="sm"
              variant={tunnelActive ? "outline" : "default"}
              disabled={!running || tunnelBusy || !(tunnel?.binaryExists ?? false)}
              onClick={() => void toggleTunnel()}
            >
              {tunnel?.state === "starting"
                ? "取消"
                : tunnelActive
                  ? "关闭"
                  : "开启"}
            </Button>
          </div>
          <div className="bg-muted/50 flex flex-col gap-2.5 rounded-2xl px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">Cloudflare 快速隧道</div>
                <div className="text-muted-foreground truncate text-sm">
                  {tunnelSummary}
                </div>
              </div>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-xs",
                  tunnel?.state === "running"
                    ? "text-primary"
                    : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    tunnel?.state === "running"
                      ? "bg-lime-500"
                      : "bg-muted-foreground/40",
                  )}
                />
                {tunnel?.state === "running"
                  ? "在线"
                  : tunnel?.state === "starting"
                    ? "连接中"
                    : tunnel?.state === "error"
                      ? "已断开"
                      : "未开启"}
              </span>
            </div>

            {tunnelUrl ? (
              <InputCopy
                value={tunnelUrl}
                className="text-muted-foreground rounded-lg bg-background/60 border px-2.5 py-1.5 font-mono break-all"
              />
            ) : null}

            {!tunnel?.binaryExists ? (
              tunnelBusy ? (
                // 下载中：进度条 + 阶段文案（一次 20-40MB，光有"下载中…"像卡死）
                <div className="flex flex-col gap-1.5">
                  <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate">
                      {DOWNLOAD_PHASE_LABEL[download?.phase ?? ""] ?? "下载"}
                      {download?.message ? `：${download.message}` : "…"}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {downloadPct !== null ? `${downloadPct}%` : ""}
                    </span>
                  </div>
                  <div className="bg-background h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-foreground h-full rounded-full transition-all duration-200"
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
                    {download?.phase === "error" ? "重新下载" : "下载 cloudflared"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void pickCloudflared()}
                  >
                    指定本地路径
                  </Button>
                </div>
              )
            ) : tunnel.binarySource === "custom" ? (
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono">
                  {tunnel.binaryPath}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={tunnelBusy}
                  onClick={() => void setCloudflaredPath(null)}
                >
                  恢复自动
                </Button>
              </div>
            ) : null}

            {tunnel?.state === "error" && tunnel.error ? (
              <div className="text-destructive/90 text-xs leading-relaxed">
                {tunnel.error}
              </div>
            ) : null}
            {/* 下载/校验失败的原因就地展示（不再走页面级 error 换掉整页） */}
            {download?.phase === "error" ? (
              <div className="text-destructive/90 text-xs leading-relaxed break-all">
                {download.message}
              </div>
            ) : null}
            {tunnel?.state === "error" && tunnel.logTail.length ? (
              <pre className="text-muted-foreground max-h-24 overflow-y-auto rounded-lg bg-background/60 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                {tunnel.logTail.slice(-6).join("\n")}
              </pre>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            免费、无需 Cloudflare 账号：应用自动拉起 cloudflared，给出一个临时公网地址（HTTPS/WSS），手机不在同一网络也能扫码使用。地址每次启动都会变化，需要固定域名请用命名隧道（见
            docs/remote-access.md）。鉴权仍是配对码 + 长效 token，公网地址请勿外泄。
          </p>
        </section>

        {running && (
          <>
            {/* 扫码连接：仅本机模式下地址是 127.0.0.1，手机根本连不上（隧道在线
                时二维码改指公网地址，不受此限）——扫不开的二维码比不给更糟 */}
            {qr ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-base font-semibold">扫码连接</h2>
                {status?.lan || tunnelUrl ? (
                  <div className="bg-muted/50 flex items-start gap-5 rounded-2xl p-5">
                    <div className="shrink-0 rounded-lg border bg-white p-2">
                      <QRCodeSVG value={qr.value} size={124} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {qr.direct ? (
                        <InputCopy
                          label={
                            tunnelUrl
                              ? "手机扫码打开公网地址（快速隧道转发到本机应用），地址与配对码已自动填入。"
                              : "手机扫码将直接打开应用网页（本机提供，无需另外部署），地址与配对码已自动填入。"
                          }
                          value={qr.value}
                          className="text-muted-foreground rounded-lg bg-background/60 mr-1 border px-2.5 py-1.5 font-mono break-all "
                        />
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          未检测到可用地址，扫码可得连接配置
                          JSON；可在网页连接页地址框粘贴解析。
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground rounded-2xl bg-muted/50 px-5 py-4 text-sm">
                    网关当前仅本机可达，手机扫码需要先在下方「安全与设备」里打开
                    局域网访问，或开启上方「公网访问」的快速隧道。
                  </div>
                )}
              </section>
            ) : null}

            {/* 浏览器访问 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">浏览器访问</h2>
              <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
                {httpAddrs.length ? (
                  httpAddrs.map((addr) => (
                    <AddressRow
                      key={addr}
                      addr={addr}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    未检测到局域网 IP，可开启上方「公网访问」的快速隧道。
                  </div>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                {tunnelUrl
                  ? "第一行是公网地址（快速隧道），任意网络可访问。"
                  : status?.lan
                    ? "手机与本机同一网络，扫码或输入地址即可使用。"
                    : "当前仅本机可达，127.0.0.1 只能在这台电脑上打开；手机访问请先打开「局域网访问」，或开启「公网访问」的快速隧道。"}
              </p>
            </section>

            {/* WS 连接地址 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">WS 连接地址</h2>
              <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
                {wsAddrs.length ? (
                  wsAddrs.map((addr) => (
                    <AddressRow
                      key={addr}
                      addr={addr}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    未检测到局域网 IP。
                  </div>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                供其他客户端 / 隧道使用。
              </p>
            </section>

            {/* 配对码 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">配对码</h2>
              <div className="bg-muted/50 flex items-center gap-3 rounded-2xl px-5 py-4">
                <span className="rounded-lg border bg-background/60 px-4 py-2 font-mono text-2xl tracking-[0.4em] tabular-nums">
                  {status?.code ?? "------"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void refreshCode()}
                >
                  <RefreshCwIcon className="size-4" />
                  换一个
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
                    复制
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                每连接 5 次输错即锁定。
              </p>
            </section>

            {/* 安全与设备 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">安全与设备</h2>
              <div className="bg-muted/50 flex flex-col divide-y rounded-2xl">
                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">局域网访问</div>
                    <div className="text-muted-foreground text-sm">
                      打开后同一网络下的设备可直连本机（0.0.0.0）；默认关闭，仅本机（127.0.0.1）可连接。切换会重启网关并生成新配对码。
                    </div>
                    {status?.lan ? (
                      <div className="text-destructive/90 mt-1.5 text-xs leading-relaxed">
                        网关当前没有 TLS，配对码与 token 在局域网内是明文传输
                        （同网段任意设备可抓包）。请只在家中可信网络下开启；跨网络访问请改用
                        上方「公网访问」的快速隧道（HTTPS/WSS）或 Tailscale。
                      </div>
                    ) : null}
                  </div>
                  <Switch
                    checked={status?.lan ?? false}
                    disabled={busy}
                    onCheckedChange={(v) => void applyLan(v)}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">已连接设备</div>
                    <div className="text-muted-foreground text-sm">
                      撤销后所有已配对设备立即断开、token 失效，需重新扫码配对。
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void revokeAll()}
                  >
                    撤销所有设备
                  </Button>
                </div>
              </div>
            </section>

            <div className="text-muted-foreground rounded-2xl bg-muted/50 px-5 py-4 text-xs leading-relaxed">
              {REMOTE_HINT}
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
  <div className="w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2">
    <InputCopy value={addr} className="shrink-0" />
  </div>
);
