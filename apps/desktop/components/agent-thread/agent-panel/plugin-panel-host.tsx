"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { useAui } from "@assistant-ui/react";
import { Loader2Icon, PanelTopIcon } from "lucide-react";
import {
  piRequest,
  type PiPluginPanelAssetResponse,
} from "@/lib/pi/pi-bridge";
import {
  fsErrorText,
  fsReadFile,
  fsReadFileBase64,
  fsReveal,
  fsWriteFile,
  fsWriteFileBase64,
} from "@/lib/workspace/fs";
import {
  updatePanelTab,
  type PanelTab,
} from "@/lib/panels/panel-tabs";
import {
  encodeHostMessage,
  decodeUiMessage,
  MESSAGE_PERMISSION,
  type HostMessage,
  type PanelPermission,
  type UiMessage,
} from "@/lib/plugins/ui-plugin-bridge";
import { usePluginPanels } from "@/lib/plugins/plugin-panels";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { toast } from "@/components/ui/toast";
import { TabEmpty } from "./tab-empty";

/**
 * UI 插件面板宿主（桥协议 xulux-ui-plugin/1，纯解码层在 lib/plugins/ui-plugin-bridge）。
 *
 * 生命周期：挂载 → get_plugin_panel_asset 取 entry 单文件 HTML → blob: URL →
 * iframe(sandbox=allow-scripts，不透明源) → 内层脚本发 ui.ready → 回
 * handshake{theme, context} → UI 发 doc.request → 宿主读盘推 doc.open。
 * 编辑回流：doc.change 防抖 800ms 写盘（关标签/卸载即时 flush）；
 * agent 经 open_plugin_panel 改绑/更新文档 → pi-transport 发
 * "plugin-panel:refresh" 窗件事件 → 宿主重读盘推 doc.open{external}，
 * 冲突（UI 有未保存内容）由插件按 SKILL.md 约定自行提示。
 *
 * 安全边界：event.source 严格等于本 iframe 的 contentWindow；消息经
 * decodeUiMessage 白名单解码；kind→权限门控取面板声明（未声明即拒绝）；
 * 文件读写全部走 Tauri fs 命令（workspace 信任根 + 相对路径守卫）。
 */

/** doc.change 写盘防抖；与插件侧自动保存体感一致 */
const SAVE_DEBOUNCE_MS = 800;

function currentTheme(): "light" | "dark" {
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

/** 工作区绝对路径 → 展示名（末段目录名；跨平台分隔符） */
function workspaceName(cwd: string | null): string {
  if (!cwd) return "";
  const segs = cwd.split(/[/\\]+/).filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

/** base64 → Uint8Array（atob 分块防超长调用栈）；显式 ArrayBuffer 泛型满足 BlobPart */
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 文档路径 → 附属资产目录：`dir/name.ext` → `dir/name-assets` */
function assetsDirFor(docPath: string): string {
  const cut = docPath.lastIndexOf("/");
  const dir = cut >= 0 ? docPath.slice(0, cut) : "";
  const base = (cut >= 0 ? docPath.slice(cut + 1) : docPath).replace(
    /\.[^.]*$/,
    "",
  );
  return `${dir ? `${dir}/` : ""}${base}-assets`;
}

export const PluginPanelHost: FC<{ tab: PanelTab }> = ({ tab }) => {
  const workspace = useWorkspace();
  const aui = useAui();
  const contributions = usePluginPanels();
  const contrib = contributions.panels.find(
    (c) => c.pluginId === tab.pluginId && c.panel.id === tab.panelId,
  );

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const docRevRef = useRef(0);
  /** UI 最近一次 doc.change 的内容（未落盘）；null = 与盘上一致 */
  const pendingJsonRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameReadyRef = useRef(false);
  const openedPathRef = useRef<string | null>(null);

  const cwd = tab.cwd ?? workspace ?? null;
  const docPath = tab.path ?? null;
  const permsRef = useRef<Set<PanelPermission>>(new Set());
  permsRef.current = new Set(
    (contrib?.panel.permissions ?? []) as PanelPermission[],
  );
  // 最新上下文给消息回调（避免 stale closure）
  const ctxRef = useRef({ cwd, docPath });
  ctxRef.current = { cwd, docPath };

  const post = useCallback((m: HostMessage) => {
    frameRef.current?.contentWindow?.postMessage(encodeHostMessage(m), "*");
  }, []);

  /* ---------------- 文档读写 ---------------- */

  const pushDoc = useCallback(
    async (external: boolean) => {
      const { cwd, docPath } = ctxRef.current;
      if (!cwd || !docPath) {
        post({ kind: "doc.error", errorText: "面板尚未绑定文档文件" });
        return;
      }
      const res = await fsReadFile(cwd, docPath);
      if (!res) {
        post({
          kind: "doc.error",
          errorText: `读取文档失败（不存在或不可读）：${docPath}`,
        });
        return;
      }
      if (res.binary || res.truncated) {
        post({
          kind: "doc.error",
          errorText: "文档过大或为二进制，面板拒绝加载（避免截断保存损坏）",
        });
        return;
      }
      docRevRef.current += 1;
      openedPathRef.current = docPath;
      pendingJsonRef.current = null;
      post({ kind: "doc.open", rev: docRevRef.current, json: res.content, path: docPath, ...(external ? { external: true } : {}) });
    },
    [post],
  );

  const saveNow = useCallback(async () => {
    const json = pendingJsonRef.current;
    const { cwd, docPath } = ctxRef.current;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (json === null || !cwd || !docPath) return;
    const err = await fsWriteFile(cwd, docPath, json);
    if (err) {
      post({ kind: "doc.error", errorText: `保存失败：${fsErrorText(err)}` });
      toast.error(`面板文档保存失败：${fsErrorText(err)}`);
      return;
    }
    if (pendingJsonRef.current === json) pendingJsonRef.current = null;
    post({ kind: "doc.saved", rev: docRevRef.current });
  }, [post]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS);
  }, [saveNow]);

  /* ---------------- UI→host 消息处理 ---------------- */

  const handleUiMessage = useCallback(
    async (msg: UiMessage) => {
      const { cwd, docPath } = ctxRef.current;
      switch (msg.kind) {
        case "ui.ready":
          frameReadyRef.current = true;
          post({
            kind: "handshake",
            theme: currentTheme(),
            context: { workspaceName: workspaceName(cwd), fileRelPath: docPath },
          });
          return;
        case "doc.request":
          await pushDoc(false);
          return;
        case "doc.change":
          pendingJsonRef.current = msg.json;
          scheduleSave();
          return;
        case "doc.create": {
          if (!cwd) return;
          // 新建文档拒绝覆盖：agent/用户文件安全优先，重名让 UI 换名
          const existing = await fsReadFile(cwd, msg.path);
          if (existing) {
            post({ kind: "doc.error", errorText: `文件已存在，未覆盖：${msg.path}` });
            return;
          }
          const err = await fsWriteFile(cwd, msg.path, msg.json);
          if (err) {
            post({ kind: "doc.error", errorText: `新建失败：${fsErrorText(err)}` });
            return;
          }
          updatePanelTab(tab.id, { path: msg.path, cwd });
          docRevRef.current += 1;
          openedPathRef.current = msg.path;
          pendingJsonRef.current = null;
          post({ kind: "doc.open", rev: docRevRef.current, json: msg.json });
          return;
        }
        case "doc.attach": {
          if (!cwd || !docPath) {
            post({ kind: "doc.error", errorText: "未绑定文档，无法落盘资产" });
            return;
          }
          const err = await fsWriteFileBase64(
            cwd,
            `${assetsDirFor(docPath)}/${msg.name}`,
            msg.base64,
          );
          if (err)
            post({ kind: "doc.error", errorText: `资产落盘失败：${fsErrorText(err)}` });
          return;
        }
        case "doc.export": {
          if (!cwd) return;
          const err = await fsWriteFileBase64(cwd, msg.filename, msg.base64);
          if (err) {
            post({ kind: "doc.error", errorText: `导出失败：${fsErrorText(err)}` });
            toast.error(`导出失败：${fsErrorText(err)}`);
            return;
          }
          toast.add({
            title: `已导出 ${msg.filename}`,
            status: "success",
            action: {
              label: "显示",
              onClick: () => void fsReveal(cwd, msg.filename),
            },
          });
          return;
        }
        case "asset.request": {
          if (!cwd) {
            post({ kind: "asset.reply", reqId: msg.reqId, base64: null });
            return;
          }
          const res = await fsReadFileBase64(cwd, msg.path);
          post({
            kind: "asset.reply",
            reqId: msg.reqId,
            base64: res && res !== "too-large" ? res.base64 : null,
          });
          return;
        }
        case "agent.prefill":
          aui.composer.setText(msg.text);
          return;
        case "ui.notify":
          if (msg.level === "error") toast.error(msg.text);
          else toast.info(msg.text);
          return;
      }
    },
    [aui, post, pushDoc, scheduleSave, tab.id],
  );

  /* ---------------- 资产加载（blob iframe） ---------------- */

  useEffect(() => {
    if (!tab.pluginId || !tab.panelId) return;
    let cancelled = false;
    let url = "";
    frameReadyRef.current = false;
    openedPathRef.current = null;
    setBlobUrl(null);
    setAssetError(null);
    void (async () => {
      try {
        const res = await piRequest<PiPluginPanelAssetResponse>(
          { type: "get_plugin_panel_asset", pluginId: tab.pluginId, panelId: tab.panelId },
          30000,
        );
        if (cancelled) return;
        const bytes = b64ToBytes(res.base64);
        url = URL.createObjectURL(new Blob([bytes], { type: "text/html" }));
        setBlobUrl(url);
      } catch (err) {
        if (!cancelled)
          setAssetError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [tab.pluginId, tab.panelId]);

  /* ---------------- 消息监听（含来源与权限门控） ---------------- */

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || ev.source !== frame.contentWindow) return;
      const msg = decodeUiMessage(ev.data);
      if (!msg) return;
      if (msg.kind !== "ui.ready") {
        const need = MESSAGE_PERMISSION[msg.kind];
        if (need && !permsRef.current.has(need)) {
          post({
            kind: "doc.error",
            errorText: `面板未声明权限 "${need}"，该请求被宿主拒绝`,
          });
          return;
        }
      }
      void handleUiMessage(msg);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleUiMessage, post]);

  /* ---------------- 主题跟随 ---------------- */

  useEffect(() => {
    const obs = new MutationObserver(() =>
      post({ kind: "theme.update", theme: currentTheme() }),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, [post]);

  /* ---------------- agent 写盘后的外部刷新 ---------------- */

  useEffect(() => {
    const onRefresh = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { plugin?: string; panel?: string }
        | undefined;
      if (
        !detail ||
        detail.plugin !== tab.pluginId ||
        detail.panel !== tab.panelId
      )
        return;
      if (frameReadyRef.current) void pushDoc(true);
    };
    window.addEventListener("plugin-panel:refresh", onRefresh);
    return () => window.removeEventListener("plugin-panel:refresh", onRefresh);
  }, [pushDoc, tab.pluginId, tab.panelId]);

  /* ---------------- 绑定文档变更（重开不同文件 / doc.create 换绑） ---------------- */

  useEffect(() => {
    if (!frameReadyRef.current || !docPath) return;
    if (docPath === openedPathRef.current) return;
    void pushDoc(false);
  }, [docPath, pushDoc]);

  /* ---------------- 标题：面板声明名（异步清单到达后一次性写入） ---------------- */

  useEffect(() => {
    if (!contrib) return;
    const want = tab.path
      ? `${contrib.panel.title} · ${tab.path.split("/").pop()}`
      : contrib.panel.title;
    if (tab.title !== want) updatePanelTab(tab.id, { title: want });
  }, [contrib, tab.id, tab.title, tab.path]);

  /* ---------------- 卸载即时 flush 未保存内容 ---------------- */

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const json = pendingJsonRef.current;
      const { cwd, docPath } = ctxRef.current;
      if (json !== null && cwd && docPath)
        void fsWriteFile(cwd, docPath, json);
    };
  }, []);

  /* ---------------- 渲染 ---------------- */

  if (!contrib) {
    if (contributions.loading)
      return (
        <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          加载面板…
        </div>
      );
    return <TabEmpty icon={PanelTopIcon} text="插件未安装、已禁用或面板已移除" />;
  }
  if (assetError)
    return <TabEmpty icon={PanelTopIcon} text={`面板加载失败：${assetError}`} />;
  if (!blobUrl)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-1.5 text-xs">
        <Loader2Icon className="size-3.5 animate-spin" />
        加载面板…
      </div>
    );
  return (
    <iframe
      key={blobUrl}
      ref={frameRef}
      title={contrib.panel.title}
      src={blobUrl}
      // 不透明源：插件页面拿不到宿主 DOM/存储/网络身份，一切经桥
      sandbox="allow-scripts"
      allow="fullscreen; clipboard-write"
      className="bg-background h-full w-full border-0"
    />
  );
};
