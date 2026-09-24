"use client";

import dynamic from "next/dynamic";
import { useMemo, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import { FileCodeIcon, FileIcon, GlobeIcon, LayoutPanelTopIcon } from "lucide-react";
import {
  formatBytes,
  isBrowserPreviewable,
  messageArtifacts,
  toFileUrl,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import { focusPanelTab, focusPluginPanel } from "@/lib/panels/panel-tabs";
import { findPanelForFile, usePluginPanels } from "@/lib/plugins/plugin-panels";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
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
  // 有效工作目录：当前工作区 → 任务工作区兜底（异步补齐后自动重渲染）。
  // 没有它就没有任何相对路径可谈：预览/在画布中打开都以它为锚。
  const cwd = usePanelCwd();
  // 地球按钮只对能在浏览器里渲染的类型出现（md 等交给「代码」的文件标签预览）
  const canPreview = !!cwd && isBrowserPreviewable(artifact.path);
  // 产物命中已装面板的 opens glob（如 *.canvas.json）→ 追加「在画布中打开」
  const relPath = cwd && artifact.path.startsWith(`${cwd}/`)
    ? artifact.path.slice(cwd.length + 1)
    : artifact.path;
  const { panels } = usePluginPanels();
  const panelForFile = cwd ? findPanelForFile(panels, relPath) : undefined;

  const openCode = () => {
    focusPanelTab("file", { focus: artifact.toolCallId, title: artifact.base });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openPreview = () => {
    if (!cwd) return;
    focusPanelTab("browser", {
      url: toFileUrl(cwd, artifact.path),
      title: artifact.base,
    });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openInPanel = () => {
    if (!cwd || !panelForFile) return;
    focusPluginPanel(panelForFile.pluginId, panelForFile.panel.id, {
      cwd,
      path: relPath,
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
      {panelForFile ? (
        <button
          type="button"
          onClick={openInPanel}
          aria-label={`在${panelForFile.panel.title}中打开`}
          title={`在${panelForFile.panel.title}中打开`}
          className={cn(iconBtn)}
        >
          <LayoutPanelTopIcon className="size-4" />
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
