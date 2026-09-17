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

const REMOTE_HINT =
  "开启后手机扫码或访问地址即可直接使用（应用自带网页，无需另外部署）；公网访问可用 Cloudflare Tunnel（cloudflared tunnel --url http://localhost:端口）或 Tailscale，详见 docs/remote-access.md。网页端凭配对码换取长效 token 后即可远程操作本机助手（含文件能力），请勿泄露配对码与地址。";

/** 远程访问页：启停 WS 网关、扫码/配对码、局域网地址 */
export const RemoteSettings: FC = () => {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isTauri()) return;
    invoke<RemoteStatus>("pi_remote_status")
      .then(setStatus)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 运行中轻量轮询：刷新连接数等状态
  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [status?.running, load]);

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

  // 二维码内容：本机预览地址（扫码直达），无局域网 IP 时退回配置 JSON
  const qr = useMemo(() => {
    if (!status?.running || !status.code) return null;
    const host =
      status.lanAddresses[0] ?? `ws://127.0.0.1:${status.port ?? 8787}/ws`;
    const data: PairPayload = { v: 1, host, code: status.code };
    const preview = status.httpAddresses[0];
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
  ]);

  if (!isTauri()) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        远程访问配置依赖桌面端，请在 Tauri 应用中打开设置。
      </div>
    );
  }

  const running = status?.running ?? false;

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

        {running && (
          <>
            {/* 扫码连接 */}
            {qr && (
              <section className="flex flex-col gap-3">
                <h2 className="text-base font-semibold">扫码连接</h2>
                <div className="bg-muted/50 flex items-start gap-5 rounded-2xl p-5">
                  <div className="shrink-0 rounded-lg border bg-white p-2">
                    <QRCodeSVG value={qr.value} size={124} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {qr.direct ? (
                      <InputCopy
                        label="手机扫码将直接打开应用网页（本机提供，无需另外部署），地址与配对码已自动填入。"
                        value={qr.value}
                        className="text-muted-foreground rounded-lg bg-background/60 mr-1 border px-2.5 py-1.5 font-mono break-all "
                      />
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        未检测到局域网 IP，扫码可得连接配置
                        JSON；可在网页连接页地址框粘贴解析。
                      </p>
                    )}
                    {/* <p className="text-muted-foreground rounded-lg bg-background/60 mr-1 border px-2.5 py-1.5 font-mono break-all text-xs">
                      {qr.value}
                    </p> */}
                  </div>
                </div>
              </section>
            )}

            {/* 浏览器访问 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">浏览器访问</h2>
              <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
                {status?.httpAddresses.length ? (
                  status.httpAddresses.map((addr) => (
                    <AddressRow
                      key={addr}
                      addr={addr}
                    />
                  ))
                ) : (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    未检测到局域网 IP，可使用隧道（如 Cloudflare
                    Tunnel）地址访问。
                  </div>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                手机与本机同一网络，扫码或输入地址即可使用。
              </p>
            </section>

            {/* WS 连接地址 */}
            <section className="flex flex-col gap-3">
              <h2 className="text-base font-semibold">WS 连接地址</h2>
              <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
                {status?.lanAddresses.length ? (
                  status.lanAddresses.map((addr) => (
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
                      关闭后仅本机（127.0.0.1）可连接；切换会重启网关并生成新配对码。
                    </div>
                  </div>
                  <Switch
                    checked={status?.lan ?? true}
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
