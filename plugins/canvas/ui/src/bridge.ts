/**
 * 宿主桥客户端（协议 kova-ui-plugin/1，权威定义在应用仓 lib/plugins/ui-plugin-bridge.ts）。
 * 独立运行时（vite dev 直接开浏览器）宿主消息永不到达：桥层自动降级为
 * 本地 mock（handshake 模拟 + doc.change 落地 localStorage），开发体验不依赖桌面端。
 */
import { DOC_VERSION, type DocKind } from "./doc";

const PROTOCOL = "kova-ui-plugin/1";

/** 首页历史卡片：宿主按本面板 opens 扫描工作区后回传的摘要（与宿主端 DocListItem 对齐）。
 *  kind 理论上只会是 DocKind；宿主端面板并集扫出的 sheet/doc 档按未知 kind 容错。 */
export type DocListItem = {
  /** workspace 相对路径，打开时原样回传 doc.bind */
  path: string;
  name: string;
  kind: DocKind | "sheet" | "doc";
  /** 最后修改时间（ms epoch；0=宿主未提供） */
  mtime: number;
  frames: number;
  objects: number;
  /** 页框布局摘要（供卡片画示意缩略图，宿主已截断） */
  preview: { x: number; y: number; w: number; h: number; bg: string }[];
  /** 盘上存在但 JSON 已损坏：卡片照常显示并标注（宿主 corrupt 标记） */
  corrupt?: boolean;
};

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
  private listWaiters = new Map<string, (items: DocListItem[] | null) => void>();
  private themeListeners = new Set<(t: "light" | "dark") => void>();
  private theme: "light" | "dark" = "light";
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
        this.theme = d.theme === "dark" ? "dark" : "light";
        h.onHandshake(this.theme, d.context ?? { workspaceName: "", fileRelPath: null });
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
      case "doc.list.reply": {
        const w = this.listWaiters.get(String(d.reqId));
        if (w) {
          this.listWaiters.delete(String(d.reqId));
          w(Array.isArray(d.items) ? (d.items as DocListItem[]) : []);
        }
        break;
      }
      default:
        break;
    }
  };

  private emitTheme(t: "light" | "dark") {
    this.theme = t;
    document.documentElement.dataset.theme = t;
    for (const l of this.themeListeners) l(t);
  }

  /** 当前宿主主题（新建元素默认墨色随明暗切换用） */
  getTheme(): "light" | "dark" {
    return this.theme;
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
        localStorage.setItem("canvas-local-doc", json);
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
      console.log(`[canvas:${level}]`, text);
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

  /**
   * 列工作区里的画布档（首页历史卡片）。宿主不支持该消息时超时返回 null——
   * 调用方按"无历史"降级，只显示新建入口（协议向前兼容：旧宿主静默丢弃新 kind）。
   */
  listDocs(): Promise<DocListItem[] | null> {
    if (this.standalone) return Promise.resolve(null);
    const reqId = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((res) => {
      this.listWaiters.set(reqId, res);
      setTimeout(() => {
        if (this.listWaiters.delete(reqId)) res(null);
      }, 8000);
      this.post({ kind: "doc.list", reqId });
    });
  }

  /** 打开（并让宿主把本面板绑定到）已有画布档；成功后宿主推 doc.open */
  bindDoc(path: string): void {
    this.post({ kind: "doc.bind", path });
  }

  /* standalone 的本地文档存取（开发态） */
  private loadLocal(): string {
    try {
      return localStorage.getItem("canvas-local-doc") ?? JSON.stringify({ version: DOC_VERSION, meta: { name: "画布" }, objects: [] }, null, 2);
    } catch {
      return JSON.stringify({ version: DOC_VERSION, meta: { name: "画布" }, objects: [] }, null, 2);
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
