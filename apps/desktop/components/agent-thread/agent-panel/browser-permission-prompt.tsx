"use client";

import { useEffect, useState, type FC } from "react";
import { ShieldQuestionIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const desktopCore = () => import("@/desktop-bridge/core");

/** 主进程 browser:permission-request 的载荷 */
type PermissionRequest = {
  id: string;
  origin: string;
  permission: string;
  mediaTypes?: string[];
};

type PermissionAction = "allow-session" | "allow-always" | "block-always" | "dismiss";

const PERMISSION_LABELS: Record<string, string> = {
  media: "摄像头/麦克风",
  "clipboard-read": "读取剪贴板",
  geolocation: "地理位置",
  notifications: "通知",
  midi: "MIDI 设备",
  midiSysex: "MIDI 设备",
  "idle-detection": "空闲状态",
  "speaker-selection": "扬声器选择",
  "window-management": "窗口管理",
  "storage-access": "跨站存储",
  "top-level-storage-access": "跨站存储",
  keyboardLock: "键盘锁定",
  fileSystem: "文件系统",
};

const TIMEOUT_SECONDS = 20;

function permissionLabel(req: PermissionRequest): string {
  if (req.permission === "media" && req.mediaTypes && req.mediaTypes.length > 0) {
    const hasVideo = req.mediaTypes.includes("video");
    const hasAudio = req.mediaTypes.includes("audio");
    if (hasVideo && hasAudio) return "摄像头与麦克风";
    if (hasVideo) return "摄像头";
    if (hasAudio) return "麦克风";
  }
  return PERMISSION_LABELS[req.permission] ?? req.permission;
}

/**
 * 网页权限确认气泡（仿 X 的内置浏览器权限治理）：
 * 主进程在 permission request handler 里挂起回调并发来请求，这里由用户四态决策；
 * 20s 不答复或面板不可见时主进程按拒绝收口。agent 驱动页面期间主进程直接拒绝，
 * 不会弹出这个气泡，避免把自动化卡住 20 秒。
 *
 * 只渲染一条：主进程侧按 origin+permission 去重并全局排队，渲染端无需队列。
 */
export const BrowserPermissionPrompt: FC = () => {
  const [request, setRequest] = useState<PermissionRequest | null>(null);
  const [remaining, setRemaining] = useState(TIMEOUT_SECONDS);

  const answer = (id: string, action: PermissionAction) => {
    setRequest((current) => (current?.id === id ? null : current));
    desktopCore()
      .then(({ invoke }) => invoke("browser_permission_resolve", { id, action }))
      .catch(() => {});
  };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    import("@/desktop-bridge/event")
      .then(({ listen }) =>
        listen<PermissionRequest>("browser:permission-request", (e) => {
          const payload = e.payload;
          if (!payload?.id || !payload.origin || !payload.permission) return;
          setRequest(payload);
          setRemaining(TIMEOUT_SECONDS);
        }),
      )
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 倒计时：到 0 自动按「关闭」处理（主进程也会在 20s 兜底拒绝，这里只是 UI 同步）。
  useEffect(() => {
    if (!request) return;
    if (remaining <= 0) {
      setRequest(null);
      desktopCore()
        .then(({ invoke }) =>
          invoke("browser_permission_resolve", { id: request.id, action: "dismiss" }),
        )
        .catch(() => {});
      return;
    }
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [request, remaining]);

  // Esc 关闭：与「关闭」同义（本次拒绝，不记忆）。
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      answer(request.id, "dismiss");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  if (!request) return null;

  return (
    <div
      role="dialog"
      aria-label={`网站权限请求：${permissionLabel(request)}`}
      className={cn(
        "bg-background/95 border-border/70 absolute top-2 left-1/2 z-30 flex w-[min(26rem,calc(100%-1rem))] -translate-x-1/2 flex-col gap-2 rounded-lg border p-2.5 shadow-lg backdrop-blur",
      )}
    >
      <div className="flex items-start gap-2">
        <ShieldQuestionIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 text-xs leading-5">
          <p className="text-foreground/90">
            <span className="font-mono break-all">{request.origin}</span>
            <span className="text-muted-foreground"> 请求使用 </span>
            <span className="font-medium">{permissionLabel(request)}</span>
          </p>
          <p className="text-muted-foreground/70">
            {remaining}s 后自动拒绝；自动化操作期间该请求会被直接拒绝。
          </p>
        </div>
        <button
          type="button"
          aria-label="关闭（本次拒绝）"
          title="关闭（本次拒绝）"
          onClick={() => answer(request.id, "dismiss")}
          className="text-muted-foreground hover:text-foreground hover:bg-muted -mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => answer(request.id, "allow-session")}
          className="hover:bg-muted rounded-md px-2 py-1 text-xs"
        >
          仅本次允许
        </button>
        <button
          type="button"
          onClick={() => answer(request.id, "allow-always")}
          className="hover:bg-muted rounded-md px-2 py-1 text-xs"
        >
          始终允许
        </button>
        <button
          type="button"
          onClick={() => answer(request.id, "block-always")}
          className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-md px-2 py-1 text-xs"
        >
          不允许
        </button>
      </div>
    </div>
  );
};
