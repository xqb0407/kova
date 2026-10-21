"use client";

import dynamic from "next/dynamic";
import { type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  FileCodeIcon,
  FileIcon,
  GlobeIcon,
  PackageIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import {
  formatBytes,
  openModeFor,
  toFileUrl,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import { useThreadArtifacts } from "@/lib/panels/use-artifacts";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { fsOpen, fsReveal } from "@/lib/workspace/fs";
import { isDesktop } from "@/lib/desktop-env";
import { cn } from "@/lib/utils";
import { TabEmpty } from "./tab-empty";

/** 彩色文件图标（material-file-icons ~1.5MB）按需加载，别拉进面板主 chunk */
const FileTypeIcon = dynamic(
  () => import("./file-type-icon").then((m) => m.FileTypeIcon),
  {
    ssr: false,
    loading: () => <FileIcon className="size-8 shrink-0" />,
  },
);

const iconBtn =
  "text-muted-foreground hover:bg-muted hover:text-foreground size-8 shrink-0 grid place-items-center rounded-lg transition-colors";

/**
 * 「产物」标签页：当前会话的交付文件汇总。
 * 与消息尾部产物卡同源：write/edit/子代理 write/edit/正文引用 → Host stat →
 * 路径去重（最新轮胜出）。定位是常驻的回收入口：浏览器/文件标签被关掉后，
 * 从这里随时重新打开。
 */
export const ArtifactsTab: FC = () => {
  const messages = useAuiState((s) => s.thread.messages);
  const cwd = usePanelCwd();
  const { artifacts, settled } = useThreadArtifacts(messages, cwd);
  if (!settled) return null;
  if (artifacts.length === 0) {
    return (
      <TabEmpty
        icon={PackageIcon}
        text="agent 写出网页、文档等交付文件后，会汇总在这里，随时重新打开"
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 p-3">
        {artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.toolCallId}
            artifact={artifact}
            cwd={cwd}
          />
        ))}
      </div>
    </div>
  );
};

const ArtifactRow: FC<{
  artifact: MessageArtifact;
  cwd: string | null;
}> = ({ artifact, cwd }) => {
  const openMode = artifact.openMode ?? openModeFor(artifact.path);
  // 预览仅桌面壳（file:// 喂原生 webview）；网页类才进浏览器
  const canPreview = isDesktop() && openMode === "browser";
  const isSystemOpen = openMode === "system";
  // write 的 toolCallId 才有内容快照；edit 只有替换片段，不能当全文渲染。
  const hasSnapshot =
    artifact.source === "write" && !artifact.toolCallId.startsWith("artifact:");
  const relPath = artifact.relPath ?? artifact.path;

  const openSystem = () => {
    void (async () => {
      const error = await fsOpen(cwd ?? "", artifact.path);
      if (error && cwd) await fsReveal(cwd, relPath);
    })();
  };
  const openCode = () => {
    if (isSystemOpen) {
      openSystem();
      return;
    }
    if (cwd && artifact.relPath != null) {
      focusPanelTab("file", {
        cwd,
        path: artifact.relPath,
        title: artifact.base,
        focus: undefined,
      });
    } else if (hasSnapshot) {
      focusPanelTab("file", { focus: artifact.toolCallId, title: artifact.base });
    } else {
      openSystem();
      return;
    }
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openPreview = () => {
    if (!cwd) return;
    focusPanelTab("browser", {
      url: toFileUrl(cwd, artifact.relPath ?? artifact.path),
      title: artifact.base,
    });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const primary = canPreview ? openPreview : isSystemOpen ? openSystem : openCode;
  const CodeIcon = isSystemOpen ? SquareArrowOutUpRightIcon : FileCodeIcon;
  const codeLabel = isSystemOpen ? "打开文件" : "查看代码";

  return (
    <div
      data-slot="aui_artifact-row"
      className="bg-muted/40 hover:bg-muted border-border/60 hover:border-border/80 flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors"
      onClick={primary}
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
        onClick={(event) => {
          event.stopPropagation();
          openCode();
        }}
        aria-label={codeLabel}
        title={codeLabel}
        className={cn(iconBtn)}
      >
        <CodeIcon className="size-4" />
      </button>
      {canPreview ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openPreview();
          }}
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
