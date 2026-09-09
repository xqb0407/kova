"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  decodePairPayload,
  setRemoteConfig,
  type PairPayload,
  type RemoteConfig,
} from "@/lib/remote";

/**
 * 远程连接屏：输入桌面网关地址 + 6 位配对码，换取长效 token 后进入远程运行时。
 * 地址示例：ws://192.168.x.x:8787/ws（局域网/Tailscale）或 wss://xxx.trycloudflare.com/ws（隧道）。
 * 支持扫码直达：链接带 #h=（或 ?h=）参数时自动填入；地址框粘贴配置 JSON 也可解析。
 * 页面从网关直接打开时（http 访问）自动推导同源 WS 地址，通常无需手输。
 */
export function ConnectScreen({
  onConnected,
}: {
  onConnected: (config: RemoteConfig) => void;
}) {
  const [url, setUrl] = useState("ws://127.0.0.1:8787/ws");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  // 扫码直达：解析 #h= / ?h= 参数自动填入；无参数时同源推导（页面由网关 serve 的场景）
  useEffect(() => {
    const hash = window.location.hash;
    const raw = hash.startsWith("#h=")
      ? hash.slice(3)
      : (new URLSearchParams(window.location.search).get("h") ?? "");
    const payload = raw ? decodePairPayload(raw) : null;
    if (payload) {
      setUrl(payload.host);
      setCode(payload.code);
      setScanned(true);
      return;
    }
    if (/^https?:$/.test(window.location.protocol)) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      setUrl(`${proto}//${window.location.host}/ws`);
    }
  }, []);

  const applyPasted = (raw: string): boolean => {
    const trimmed = raw.trim();
    // 粘贴配置 JSON：{"v":1,"host":"ws://...","code":"483920"}
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Partial<PairPayload>;
        if (typeof parsed.host === "string" && typeof parsed.code === "string") {
          setUrl(parsed.host);
          setCode(parsed.code);
          setScanned(true);
          return true;
        }
      } catch {
        // 非配置 JSON，按普通地址处理
      }
    }
    // 粘贴带 #h= 的完整网页链接
    const match = /[?#]h=([^&\s]+)/.exec(trimmed);
    if (match) {
      const payload = decodePairPayload(match[1]);
      if (payload) {
        setUrl(payload.host);
        setCode(payload.code);
        setScanned(true);
        return true;
      }
    }
    return false;
  };

  const submit = async () => {
    const trimmedUrl = url.trim().replace(/\/+$/, "");
    const trimmedCode = code.trim();
    if (!/^wss?:\/\//.test(trimmedUrl)) {
      setError("地址需以 ws:// 或 wss:// 开头");
      return;
    }
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError("请输入 6 位配对码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await pair(trimmedUrl, trimmedCode);
      const config = { url: trimmedUrl, token };
      setRemoteConfig(config);
      onConnected(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">连接到桌面助手</h1>
          <p className="text-sm text-muted-foreground">
            输入桌面端「设置 → 远程访问」中显示的配对码，通过你的桌面客户端处理对话。
          </p>
        </div>

        {scanned && (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            已识别扫码/粘贴的连接配置，确认无误后点击连接。
          </p>
        )}

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">桌面端地址</span>
          <Input
            value={url}
            onChange={(e) => {
              if (!applyPasted(e.target.value)) setUrl(e.target.value);
            }}
            placeholder="ws://192.168.1.5:8787 或 wss://xxx.trycloudflare.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">配对码</span>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6 位数字"
            inputMode="numeric"
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button onClick={() => void submit()} disabled={busy}>
          {busy ? "连接中..." : "连接"}
        </Button>
      </div>
    </div>
  );
}

/** 临时 WS 连接完成配对，成功返回 token */
function pair(url: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error("连接超时，请检查地址是否可达"));
    }, 15000);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn();
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "pair", code }));
    };
    ws.onmessage = (ev) => {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (v.type === "paired" && typeof v.token === "string") {
        finish(() => resolve(v.token as string));
      } else if (v.type === "error") {
        const text = String(v.errorText ?? "配对失败");
        const left = v.attemptsLeft;
        finish(() =>
          reject(
            new Error(
              typeof left === "number" ? `${text}（剩余 ${left} 次机会）` : text,
            ),
          ),
        );
      }
    };
    ws.onerror = () => {
      finish(() => reject(new Error("无法连接到桌面端，请检查地址与网络")));
    };
    ws.onclose = () => {
      finish(() => reject(new Error("连接已关闭")));
    };
  });
}
