"use client";

import dynamic from "next/dynamic";
import { useMemo, type FC } from "react";
import { FileCodeIcon, FileIcon, GlobeIcon, PackageIcon } from "lucide-react";
import { usePanelActivity } from "@/lib/panels/panel-activity";
import {
  formatBytes,
  isBrowserPreviewable,
  threadArtifacts,
  toFileUrl,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";
import { isTauri } from "@/lib/tauri";
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
 * 「产物」标签页：当前会话写出的交付文件汇总（write 白名单判定、大小口径与
 * 消息尾部产物卡同源，路径去重取最后一次成功 write，最新产出在最上）。
 * 定位是常驻的回收入口：浏览器预览标签被关掉/刷新丢弃后，从这里随时重新
 * 打开——行点击或地球按钮进浏览器，代码按钮进「文件」标签看内容快照。
 */
export const ArtifactsTab: FC = () => {
  const { files } = usePanelActivity();
  const artifacts = useMemo(() => threadArtifacts(files), [files]);
  if (artifacts.length === 0) {
    return (
      <TabEmpty
        icon={PackageIcon}
        text="agent 写出网页、文档等交付文件后，会汇总在这里，随时重新打开"
      />
    );
  }
  // 滚动容器自身不带内边距，p-3 放进随内容滚动的内层（review/git 视图同款）
  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-2 p-3">
        {artifacts.map((a) => (
          <ArtifactRow key={a.toolCallId} artifact={a} />
        ))}
      </div>
    </div>
  );
};

const ArtifactRow: FC<{ artifact: MessageArtifact }> = ({ artifact }) => {
  // 预览仅 Tauri（file:// 喂原生 webview）；网页类才进浏览器，其余走「代码」
  const canPreview = isTauri() && isBrowserPreviewable(artifact.path);
  const openCode = () => {
    focusPanelTab("file", { focus: artifact.toolCallId, title: artifact.base });
    window.dispatchEvent(new Event("agent-panel:open"));
  };
  const openPreview = () => {
    // 项目会话基于 workspace 拼绝对路径；无目录任务（无 workspace）用
    // task-workspace（与 sidecar PI_TASK_CWD 同源）——全局任务的产物同样可预览
    const ws = getWorkspace();
    const dir = ws ? Promise.resolve(ws) : taskWorkspaceDir();
    void dir.then((base) => {
      if (!base) return;
      focusPanelTab("browser", {
        url: toFileUrl(base, artifact.path),
        title: artifact.base,
      });
      window.dispatchEvent(new Event("agent-panel:open"));
    });
  };
  return (
    <div
      data-slot="aui_artifact-row"
      className="bg-muted/40 hover:bg-muted border-border/60 hover:border-border/80 flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors"
      onClick={canPreview ? openPreview : openCode}
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
        onClick={(e) => {
          e.stopPropagation();
          openCode();
        }}
        aria-label="查看代码"
        title="查看代码"
        className={cn(iconBtn)}
      >
        <FileCodeIcon className="size-4" />
      </button>
      {canPreview ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
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
