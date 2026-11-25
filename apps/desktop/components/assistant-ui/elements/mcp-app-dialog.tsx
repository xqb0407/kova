"use client";

/**
 * MCP Apps 宿主：把 tool._meta.ui.resourceUri 对应的 ui:// HTML 渲染进沙箱
 * iframe，并实现最小但完整的 postMessage JSON-RPC 桥：
 * - ui/initialize / initialized 握手
 * - host → app: tool-input / tool-result / host-context-changed
 * - app → host: tools/call、resources/read、ui/open-link、ui/message、
 *   ui/request-display-mode、ui/update-model-context（明确报不支持）、ping
 * - ui/notifications/size-changed 自适应高度
 *
 * 安全边界：iframe sandbox 只给 allow-scripts（不给 same-origin），CSP 按
 * 资源声明的 csp domains 注入；工具调用只走 sidecar 的 app 可见性白名单。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useAui } from "@assistant-ui/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { openExternal } from "@/lib/external-link";
import {
  callMcpAppTool,
  readMcpAppResource,
} from "@/lib/mcp/mcp";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { t } from "@/lib/i18n";
import type { PiMcpAppResourceMeta } from "@/lib/pi/pi-bridge";

export type McpAppLaunch = {
  server: string;
  tool: string;
  resourceUri: string;
  arguments?: Record<string, unknown>;
  content?: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
};

type ResourceState =
  | { status: "loading" }
  | { status: "ready"; html: string; meta?: PiMcpAppResourceMeta }
  | { status: "error"; error: string };

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function allowedDomains(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter(
      (value): value is string =>
        typeof value === "string" &&
        /^(https:\/\/|http:\/\/localhost|wss:\/\/|ws:\/\/localhost)/i.test(value),
    )
    .map((value) => value.replace(/["\s;]/g, ""))
    .slice(0, 32);
}

/** 把服务端声明的 CSP 注入 srcdoc；没声明的外部资源一律拒绝 */
function injectCsp(html: string, meta: PiMcpAppResourceMeta | undefined): string {
  const resource = allowedDomains(meta?.csp?.resourceDomains).join(" ");
  const connect = allowedDomains(meta?.csp?.connectDomains).join(" ");
  const frame = allowedDomains(meta?.csp?.frameDomains).join(" ");
  const base = allowedDomains(meta?.csp?.baseUriDomains).join(" ");
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${resource}`.trim(),
    `style-src 'unsafe-inline' ${resource}`.trim(),
    `img-src data: blob: ${resource}`.trim(),
    `font-src data: ${resource}`.trim(),
    `media-src data: blob: ${resource}`.trim(),
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frame || "'none'"}`,
    `base-uri ${base || "'none'"}`,
    "form-action 'none'",
  ];
  const tag = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(
    directives.join("; "),
  )}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${tag}`);
  }
  return `${tag}${html}`;
}

function iframeAllow(meta: PiMcpAppResourceMeta | undefined): string | undefined {
  const permissions = meta?.permissions;
  if (!permissions) return undefined;
  const allow: string[] = [];
  if (permissions.camera) allow.push("camera");
  if (permissions.microphone) allow.push("microphone");
  if (permissions.geolocation) allow.push("geolocation");
  if (permissions.clipboardWrite) allow.push("clipboard-write");
  return allow.length ? allow.join("; ") : undefined;
}

function messageText(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const content = (params as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

export function McpAppDialog({
  app,
  open,
  onOpenChange,
}: {
  app: McpAppLaunch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const aui = useAui();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initializedRef = useRef(false);
  const toolDataSentRef = useRef(false);
  const appRef = useRef(app);
  appRef.current = app;
  const [resource, setResource] = useState<ResourceState>({ status: "loading" });
  const [height, setHeight] = useState(420);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    if (!app?.resourceUri || !app.server) return;
    setResource({ status: "loading" });
    initializedRef.current = false;
    toolDataSentRef.current = false;
    try {
      const res = await readMcpAppResource(
        app.server,
        app.resourceUri,
        getWorkspace(),
      );
      if (res.mimeType && !res.mimeType.startsWith("text/html")) {
        throw new Error(`MCP App resource is not HTML (${res.mimeType})`);
      }
      const html =
        res.content ??
        (res.blob
          ? new TextDecoder().decode(
              Uint8Array.from(atob(res.blob), (c) => c.charCodeAt(0)),
            )
          : "");
      if (!html.trim()) {
        setResource({ status: "error", error: t("chat.mcpApp.empty") });
        return;
      }
      setResource({ status: "ready", html, ...(res.meta ? { meta: res.meta } : {}) });
    } catch (err) {
      setResource({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [app?.resourceUri, app?.server]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, nonce]);

  const sendToApp = useCallback((message: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const reply = useCallback(
    (id: string | number | undefined, result: unknown) => {
      if (id === undefined) return;
      sendToApp({ jsonrpc: "2.0", id, result });
    },
    [sendToApp],
  );

  const replyError = useCallback(
    (id: string | number | undefined, message: string, code = -32000) => {
      if (id === undefined) return;
      sendToApp({ jsonrpc: "2.0", id, error: { code, message } });
    },
    [sendToApp],
  );

  const sendToolData = useCallback(() => {
    const current = appRef.current;
    if (!current || toolDataSentRef.current) return;
    toolDataSentRef.current = true;
    sendToApp({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: current.arguments ?? {} },
    });
    sendToApp({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: current.content ?? [],
        ...(current.structuredContent !== undefined
          ? { structuredContent: current.structuredContent }
          : {}),
      },
    });
  }, [sendToApp]);

  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const msg = event.data as RpcRequest | string | null;
      if (typeof msg === "string") return;
      if (!msg || typeof msg !== "object") return;
      const method = msg.method;
      const id = msg.id;
      if (!method) return;
      const params = msg.params as Record<string, unknown> | undefined;
      switch (method) {
        case "ui/initialize": {
          reply(id, {
            protocolVersion: "2026-01-26",
            hostCapabilities: {
              openLinks: {},
              serverTools: {},
              serverResources: {},
              logging: {},
            },
            hostInfo: { name: "Kova", version: "1.2.5" },
            hostContext: {
              theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light",
              displayMode: "inline",
              availableDisplayModes: ["inline"],
              containerDimensions: { width: 880, maxHeight: 760 },
              platform: "desktop",
              locale: navigator.language,
              userAgent: navigator.userAgent,
            },
          });
          return;
        }
        case "ui/notifications/initialized": {
          if (!initializedRef.current) {
            initializedRef.current = true;
            sendToolData();
          }
          return;
        }
        case "tools/call": {
          const name = typeof params?.name === "string" ? params.name : "";
          const callArgs =
            typeof params?.arguments === "object" &&
            params.arguments !== null &&
            !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};
          if (!name) {
            replyError(id, "tools/call: name is required", -32602);
            return;
          }
          void callMcpAppTool(appRef.current?.server ?? "", name, callArgs, getWorkspace())
            .then((res) => reply(id, res.result))
            .catch((err) =>
              replyError(id, err instanceof Error ? err.message : String(err)),
            );
          return;
        }
        case "resources/read": {
          const uri = typeof params?.uri === "string" ? params.uri : "";
          if (!uri) {
            replyError(id, "resources/read: uri is required", -32602);
            return;
          }
          void readMcpAppResource(appRef.current?.server ?? "", uri, getWorkspace())
            .then((res) => {
              const content: Record<string, unknown> = {
                uri: res.uri,
                mimeType: res.mimeType,
              };
              if (res.content !== undefined) content.text = res.content;
              else if (res.blob) content.blob = res.blob;
              if (res.meta) content._meta = { ui: res.meta };
              reply(id, { contents: [content] });
            })
            .catch((err) =>
              replyError(id, err instanceof Error ? err.message : String(err)),
            );
          return;
        }
        case "ui/open-link": {
          const url = typeof params?.url === "string" ? params.url : "";
          try {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              replyError(id, "Invalid URL");
              return;
            }
            void openExternal(parsed.toString());
            reply(id, {});
          } catch {
            replyError(id, "Invalid URL");
          }
          return;
        }
        case "ui/message": {
          const text = messageText(params);
          if (!text?.trim()) {
            replyError(id, "Invalid message format");
            return;
          }
          try {
            const current = aui.composer.getState().text;
            aui.composer.setText(
              current.trim() ? `${current}\n\n${text}` : text,
            );
            reply(id, {});
          } catch {
            replyError(id, t("chat.mcpApp.messageUnavailable"));
          }
          return;
        }
        case "ui/request-display-mode": {
          reply(id, { mode: "inline" });
          return;
        }
        case "ui/update-model-context": {
          replyError(id, "Context updates are not supported by this host yet.");
          return;
        }
        case "ping": {
          reply(id, {});
          return;
        }
        case "ui/notifications/size-changed": {
          const nextHeight = Number(params?.height);
          if (Number.isFinite(nextHeight)) {
            setHeight(Math.min(Math.max(Math.round(nextHeight), 120), 760));
          }
          return;
        }
        case "notifications/message": {
          console.info("[mcp-app]", params);
          return;
        }
        default: {
          if (id !== undefined) replyError(id, `Method not found: ${method}`, -32601);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [aui, open, reply, replyError, sendToolData]);

  const title = app
    ? t("chat.mcpApp.title", { server: app.server })
    : t("chat.mcpApp.title", { server: "" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(82vh,780px)] w-[min(94vw,960px)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm font-medium">{title}</DialogTitle>
            <DialogDescription className="truncate text-xs text-muted-foreground">
              {app?.resourceUri}
            </DialogDescription>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground grid size-8 place-items-center rounded-lg"
            onClick={() => setNonce((value) => value + 1)}
            aria-label={t("chat.mcpApp.retry")}
          >
            <RefreshCwIcon className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 bg-background">
          {resource.status === "loading" && (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {t("chat.mcpApp.loading")}
            </div>
          )}
          {resource.status === "error" && (
            <div className="text-destructive flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
              <p className="font-medium">{t("chat.mcpApp.loadFailed")}</p>
              <p className="text-muted-foreground break-words text-xs">{resource.error}</p>
            </div>
          )}
          {resource.status === "ready" && (
            <iframe
              key={`${app?.server}:${app?.resourceUri}:${nonce}`}
              ref={iframeRef}
              title={title}
              sandbox="allow-scripts allow-forms"
              allow={iframeAllow(resource.meta)}
              referrerPolicy="no-referrer"
              className="block w-full border-0"
              style={{ height }}
              srcDoc={injectCsp(resource.html, resource.meta)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
