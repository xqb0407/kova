/**
 * 宿主桥客户端（协议 xulux-ui-plugin/1，权威定义在应用仓 lib/plugins/ui-plugin-bridge.ts）。
 * 独立运行时（vite dev 直接开浏览器）宿主消息永不到达：桥层自动降级为
 * 本地 mock（handshake 模拟 + doc.change 落地 localStorage），开发体验不依赖桌面端。
 */
import { DOC_VERSION } from "./doc";

const PROTOCOL = "xulux-ui-plugin/1";

type HostHandlers = {
  onHandshake: (theme: "light" | "dark", ctx: { workspaceName: string; fileRelPath: string | null }) => void;
  onDocOpen: (rev: number, json: string, external: boolean, path: string | null) => void;
  onSaved: (rev: number) => void;
  onDocError: (text: string) => void;
  onTheme: (theme: "light" | "dark") => void;
  onAssetReply: (reqId: string, base64: string | null) => void;
};

export type BridgeState = "standalone" | "connected" | "open";

class Bridge {
  private handlers: HostHandlers | null = null;
  private state: BridgeState = "standalone";
  private assetWaiters = new Map<string, (b64: string | null) => void>();
  private themeListeners = new Set<(t: "light" | "dark") => void>();
  readonly standalone = typeof window !== "undefined" && window.parent === window;

  attach(handlers: HostHandlers): void {
    this.handlers = handlers;
    window.addEventListener("message", this.onMessage);
    if (this.standalone) {
      // 浏览器直开：合成握手，主题跟随 prefers-color-scheme
      this.state = "connected";
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      setTimeout(() => {
        handlers.onHandshake(mq.matches ? "dark" : "light", {
          workspaceName: "standalone",
          fileRelPath: null,
        });
        handlers.onDocOpen(1, this.loadLocal(), true, null);
      }, 0);
      mq.addEventListener("change", (e) => this.emitTheme(e.matches ? "dark" : "light"));
      return;
    }
    this.post({ kind: "ui.ready" });
  }

  get bridgeState(): BridgeState {
    return this.state;
  }

  private onMessage = (ev: MessageEvent) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.v !== PROTOCOL || d.dir !== "host") return;
    const h = this.handlers;
    if (!h) return;
    switch (d.kind) {
      case "handshake":
        this.state = "connected";
        h.onHandshake(d.theme === "dark" ? "dark" : "light", d.context ?? { workspaceName: "", fileRelPath: null });
        break;
      case "doc.open":
        this.state = "open";
        h.onDocOpen(Number(d.rev) || 0, String(d.json ?? ""), d.external === true, typeof d.path === "string" ? d.path : null);
        break;
      case "doc.saved":
        h.onSaved(Number(d.rev) || 0);
        break;
      case "doc.error":
        h.onDocError(String(d.errorText ?? "未知错误"));
        break;
      case "theme.update":
        this.emitTheme(d.theme === "dark" ? "dark" : "light");
        break;
      case "asset.reply": {
        const w = this.assetWaiters.get(String(d.reqId));
        if (w) {
          this.assetWaiters.delete(String(d.reqId));
          w(typeof d.base64 === "string" ? d.base64 : null);
        }
        break;
      }
      default:
        break;
    }
  };

  private emitTheme(t: "light" | "dark") {
    document.documentElement.dataset.theme = t;
    for (const l of this.themeListeners) l(t);
  }

  onTheme(cb: (t: "light" | "dark") => void): () => void {
    this.themeListeners.add(cb);
    return () => this.themeListeners.delete(cb);
  }

  private post(msg: Record<string, unknown>): void {
    if (this.standalone) return;
    window.parent.postMessage({ v: PROTOCOL, dir: "ui", ...msg }, "*");
  }

  requestDoc(): void {
    if (this.standalone) return;
    this.post({ kind: "doc.request" });
  }

  change(json: string): void {
    if (this.standalone) {
      try {
        localStorage.setItem("slide-canvas-local-doc", json);
      } catch {}
      return;
    }
    this.post({ kind: "doc.change", json });
  }

  create(path: string, json: string): void {
    this.post({ kind: "doc.create", path, json });
  }

  attachFile(name: string, base64: string): void {
    this.post({ kind: "doc.attach", name, base64 });
  }

  exportFile(filename: string, base64: string): void {
    this.post({ kind: "doc.export", filename, base64 });
  }

  prefill(text: string): void {
    this.post({ kind: "agent.prefill", text });
  }

  notify(text: string, level: "info" | "error" = "info"): void {
    if (this.standalone) {
      // eslint-disable-next-line no-console
      console.log(`[slide-canvas:${level}]`, text);
      return;
    }
    this.post({ kind: "ui.notify", text, level });
  }

  requestAsset(path: string): Promise<string | null> {
    if (this.standalone) return Promise.resolve(null);
    const reqId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((res) => {
      this.assetWaiters.set(reqId, res);
      setTimeout(() => {
        if (this.assetWaiters.delete(reqId)) res(null);
      }, 15000);
      this.post({ kind: "asset.request", reqId, path });
    });
  }

  /* standalone 的本地文档存取（开发态） */
  private loadLocal(): string {
    try {
      return localStorage.getItem("slide-canvas-local-doc") ?? JSON.stringify({ version: DOC_VERSION, slides: [] }, null, 2);
    } catch {
      return '{"version":1,"slides":[]}';
    }
  }
}

export const bridge = new Bridge();

/** ArrayBuffer/base64 互转（attach/export 载荷） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
