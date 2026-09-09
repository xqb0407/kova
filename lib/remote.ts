"use client";

import { isTauri } from "@/lib/tauri";

/**
 * 远程模式配置：网页端保存桌面网关地址与配对换取的 token。
 * 仅在非 Tauri 环境下生效（桌面端永远走本地通道）。
 */

export type RemoteConfig = {
  /** 桌面网关 WS 地址，如 ws://192.168.1.5:8787 或 wss://xxx.trycloudflare.com */
  url: string;
  /** 配对成功后服务端下发的长效 token */
  token: string;
};

const KEY = "pi.remote";

export function getRemoteConfig(): RemoteConfig | null {
  if (typeof window === "undefined" || isTauri()) return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RemoteConfig>;
    if (!parsed?.url || !parsed?.token) return null;
    return { url: parsed.url, token: parsed.token };
  } catch {
    return null;
  }
}

export function setRemoteConfig(config: RemoteConfig) {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearRemoteConfig() {
  localStorage.removeItem(KEY);
}

/** 远程模式：非 Tauri 环境且已配置过远程连接（SSR 端恒 false） */
export function isRemoteMode(): boolean {
  return getRemoteConfig() !== null;
}

// ---------- 配对二维码 payload（桌面端生成、网页端解析） ----------

export type PairPayload = {
  v: 1;
  /** 桌面网关地址，如 ws://192.168.1.5:8787 或 wss://xxx.trycloudflare.com */
  host: string;
  /** 6 位配对码 */
  code: string;
};

/** base64url 编码配对信息，用于二维码内容 / 扫码链接的 #h= 参数 */
export function encodePairPayload(payload: PairPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 解析 base64url 编码的配对信息（#h= / ?h= 参数或纯文本），失败返回 null */
export function decodePairPayload(raw: string): PairPayload | null {
  try {
    const b64 = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PairPayload>;
    if (v?.v === 1 && typeof v.host === "string" && typeof v.code === "string") {
      return { v: 1, host: v.host, code: v.code };
    }
  } catch {
    // 非 base64 内容，返回 null
  }
  return null;
}

/** 复制文本：优先 Clipboard API，失败退回 execCommand（Tauri WebView 兼容） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
