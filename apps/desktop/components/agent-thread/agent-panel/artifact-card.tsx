"use client";

import dynamic from "next/dynamic";
import { useMemo, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { FileCodeIcon, FileIcon, GlobeIcon } from "lucide-react";
import {
  formatBytes,
  isBrowserPreviewable,
  messageArtifacts,
  type MessageArtifact,
} from "@/lib/artifacts";
import { focusPanelTab } from "@/lib/panel-tabs";
import { getWorkspace } from "@/lib/workspace-store";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** 彩色文件图标（material-file-icons ~1.5MB）按需加载，别拉进消息列表主 chunk */
const FileTypeIcon = dynamic(
  () =>
    import("./file-type-icon").then((m) => m.FileTypeIcon),
  {
    ssr: false,
    loading: () => <FileIcon className="size-8 shrink-0" />,
  },
);

/**
 * 工作区相对/绝对路径 → file:// URL（内置浏览器只吃 URL，本地文件靠它加载）。
 * 逐段 encodeURIComponent 兼容空格/中文；Windows 盘符走三斜杠 file:///C:/…。
 */
function toFileUrl(cwd: string, rel: string): string {
  let abs = rel.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(abs) && !abs.startsWith("/")) {
    abs = `${cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/")}/${abs.replace(/^\/+/, "")}`;
  }
  const encoded = abs.split("/").map(encodeURIComponent).join("/");
  return /^[A-Za-z]:\//.test(encoded) ? `file:///${encoded}` : `file://${encoded}`;
}

const iconBtn =
  "text-muted-foreground hover:bg-muted hover:text-foreground size-8 shrink-0 grid place-items-center rounded-lg transition-colors";

/**
 * 单张产物卡（对齐参考图：图标 + 文件名 + 大小 + 操作）：
 * - 代码：开右侧「文件」标签，用 CodeMirror 看这次 write 的内容快照（源码；md 默认给渲染预览）
 * - 预览：仅网页/PDF 类才有——开内置浏览器（原生 webview）加载这个文件；md/csv/json 走「代码」查看
 */
export const ArtifactCard: FC<{ artifact: MessageArtifact }> = ({
  artifact,
}) => {
  const workspace = isTauri() ? getWorkspace() : null;
  // 地球按钮只对能在浏览器里渲染的类型出现（md 等交给「代码」的文件标签预览）
  const canPreview = !!workspace && isBrowserPreviewable(artifact.path);

  const openCode = () => {
    focusPanelTab("file", { focus: artifact.toolCallId, title: artifact.base });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openPreview = () => {
    if (!workspace) return;
    focusPanelTab("browser", {
      url: toFileUrl(workspace, artifact.path),
      title: artifact.base,
    });
    window.dispatchEvent(new Event("agent-panel:open"));
  };

  return (
    <div
      data-slot="aui_artifact-card"
      className="bg-muted/40 border-border/60 flex items-center gap-3 rounded-xl border px-3 py-2.5"
    >
      <FileTypeIcon path={artifact.path} className="size-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-medium text-foreground/90"
          title={artifact.path}
        >
          {artifact.base}
        </div>
        <div className="text-muted-foreground text-xs">
          {formatBytes(artifact.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={openCode}
        aria-label="查看代码"
        title="查看代码"
        className={cn(iconBtn)}
      >
        <FileCodeIcon className="size-4" />
      </button>
      {canPreview ? (
        <button
          type="button"
          onClick={openPreview}
          aria-label="浏览器预览"
          title="浏览器预览"
          className={cn(iconBtn)}
        >
          <GlobeIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
};

/**
 * 一条 assistant 消息尾部的产物卡列表。
 * 只在回合结束后计算一次：流式期间逐 token 重扫 parts、重算大文件字节数代价高，
 * 且半截内容出卡也不合理——运行中直接返回空。
 */
export const MessageArtifacts: FC = () => {
  const running = useAuiState((s) => s.message.status?.type === "running");
  const parts = useAuiState((s) => s.message.content);
  const artifacts = useMemo(
    () => (running ? [] : messageArtifacts(parts)),
    [running, parts],
  );
  if (artifacts.length === 0) return null;
  return (
    <div
      data-slot="aui_message-artifacts"
      className="mt-2 flex flex-col gap-2"
    >
      {artifacts.map((a) => (
        <ArtifactCard key={a.toolCallId} artifact={a} />
      ))}
    </div>
  );
};
