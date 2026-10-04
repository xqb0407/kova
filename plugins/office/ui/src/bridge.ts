/**
 * 宿主桥客户端（协议 kova-ui-plugin/1，权威定义在应用仓 lib/plugins/ui-plugin-bridge.ts）。
 * 本模块是 office 聚合面板（幻灯片+表格+文档三引擎）唯一的桥实现：attach 为
 * **多播**——外壳与各引擎视图各自注册 handlers，宿主帧按 kind 自行过滤消费
 * （视图只处理自己认领后缀的 doc.open），解除单一 handlers 的相互覆盖。
 * 独立运行时（vite dev 直接开浏览器）宿主消息永不到达：桥层自动降级为
 * 本地 mock（handshake 模拟 + doc.change 落地 localStorage——沙箱不透明源下
 * localStorage 会抛 SecurityError，全部 try/catch 静默）。
 */
import { DOC_VERSION, type DocKind } from "./doc";

const PROTOCOL = "kova-ui-plugin/1";

/** 首页历史卡片：宿主按已装面板 opens glob 扫描工作区后回传（与宿主端 DocListItem 对齐） */
export type DocListItem = {
  /** workspace 相对路径，打开时原样回传 doc.bind */
  path: string;
  name: string;
  /** board/deck/ui=画布档；sheet/doc=Univer 快照档（`*.sheet/.doc.univer.json`） */
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
  /** 多播 handlers：attach 可被外壳与各视图多次调用，消息逐个投递、各自过滤 */
  private handlers = new Set<HostHandlers>();
  /** 最后一次握手（迟挂载的视图补发用：多播握手只发一次，视图是在绑文档后才挂载的） */
  private lastHandshake: {
    theme: "light" | "dark";
    ctx: { workspaceName: string; fileRelPath: string | null };
  } | null = null;
  private state: BridgeState = "standalone";
  private assetWaiters = new Map<string, (b64: string | null) => void>();
  private listWaiters = new Map<string, (items: DocListItem[] | null) => void>();
  private themeListeners = new Set<(t: "light" | "dark") => void>();
  private messageBound = false;
  /** ui.ready 是会话级信号（宿主回 handshake），多播 attach 下只发一次 */
  private readySent = false;
  readonly standalone = typeof window !== "undefined" && window.parent === window;

  attach(handlers: HostHandlers): () => void {
    this.handlers.add(handlers);
    if (!this.messageBound) {
      this.messageBound = true;
      window.addEventListener("message", this.onMessage);
    }
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
    } else {
      if (!this.readySent) {
        this.readySent = true;
        this.post({ kind: "ui.ready" });
      } else if (this.lastHandshake) {
        // 补发握手：否则后挂载的视图 connected 永远为 false（卡"正在连接"）
        handlers.onHandshake(this.lastHandshake.theme, this.lastHandshake.ctx);
      }
    }
    return () => this.detach(handlers);
  }

  /** 注销一组 handlers（视图卸载时调用；ui.ready 只在首个 attach 时发） */
  detach(handlers: HostHandlers): void {
    this.handlers.delete(handlers);
  }

  get bridgeState(): BridgeState {
    return this.state;
  }

  private onMessage = (ev: MessageEvent) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.v !== PROTOCOL || d.dir !== "host") return;
    if (this.handlers.size === 0) return;
    // 逐个投递给所有 attach 过的消费者（外壳 + 当前引擎视图），各自按 kind/后缀过滤
    const deliver = (fn: (h: HostHandlers) => void) => {
      for (const h of this.handlers) fn(h);
    };
    switch (d.kind) {
      case "handshake": {
        this.state = "connected";
        const hs = {
          theme: d.theme === "dark" ? ("dark" as const) : ("light" as const),
          ctx: d.context ?? { workspaceName: "", fileRelPath: null },
        };
        this.lastHandshake = hs;
        deliver((h) => h.onHandshake(hs.theme, hs.ctx));
        break;
      }
      case "doc.open":
        this.state = "open";
        deliver((h) =>
          h.onDocOpen(Number(d.rev) || 0, String(d.json ?? ""), d.external === true, typeof d.path === "string" ? d.path : null),
        );
        break;
      case "doc.saved":
        deliver((h) => h.onSaved(Number(d.rev) || 0));
        break;
      case "doc.error":
        deliver((h) => h.onDocError(String(d.errorText ?? "未知错误")));
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

  /** standalone 的当前文档（内存托管：新建/编辑后编辑器路由与重读才有据可依） */
  private localDoc: string | null = null;
  private localPath: string | null = null;

  requestDoc(): void {
    if (this.standalone) {
      if (this.localDoc !== null) {
        for (const h of this.handlers) h.onDocOpen(1, this.localDoc, true, this.localPath);
      }
      return;
    }
    this.post({ kind: "doc.request" });
  }

  change(json: string): void {
    if (this.standalone) {
      this.localDoc = json;
      try {
        localStorage.setItem("office-local-doc", json);
      } catch {}
      return;
    }
    this.post({ kind: "doc.change", json });
  }

  create(path: string, json: string): void {
    if (this.standalone) {
      // 浏览器直开没有宿主：内存托管 + 合成 doc.open（外壳路由到编辑器）
      this.localDoc = json;
      this.localPath = path;
      for (const h of this.handlers) h.onDocOpen(1, json, true, path);
      return;
    }
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
      console.log(`[office:${level}]`, text);
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
      return localStorage.getItem("office-local-doc") ?? JSON.stringify({ version: DOC_VERSION, slides: [] }, null, 2);
    } catch {
      return '{"version":1,"slides":[]}';
    }
  }
}

export const bridge = new Bridge();

/** ArrayBuffer/base64 互转（attach/export 载荷） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(buf);
}

/** Uint8Array → base64（分块防超长调用栈；sheet/doc 导出用） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
