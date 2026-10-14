"use client";

import dynamic from "next/dynamic";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ChevronDownIcon,
  FileCodeIcon,
  FileIcon,
  GlobeIcon,
  LayoutPanelTopIcon,
  PackageIcon,
} from "lucide-react";
import {
  formatBytes,
  isBrowserPreviewable,
  messageArtifacts,
  toFileUrl,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import { getTurnParts, packTurnSlot, parseTurnSlot } from "@/lib/panels/message-turns";
import { focusPanelTab, focusPluginPanel } from "@/lib/panels/panel-tabs";
import { findPanelForFile, usePluginPanels } from "@/lib/plugins/plugin-panels";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { useScrollLock } from "@/hooks/use-scroll-lock";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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

/** 单卡操作按钮（28px 触达区，与参考稿一致） */
const iconBtn =
  "text-muted-foreground hover:bg-muted hover:text-foreground size-8 shrink-0 grid place-items-center rounded-lg transition-colors";
/** 折叠行操作按钮：行高已压到 36px，按钮跟着收到 24px */
const rowIconBtn =
  "text-muted-foreground hover:bg-muted hover:text-foreground size-6 shrink-0 grid place-items-center rounded-md transition-colors";

function splitPath(path: string): { dir: string; base: string } {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: norm };
  return { dir: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

/**
 * 目录只留末两段：write 的路径多为工作区绝对路径，前缀（/Users/…/workspace）
 * 对用户没有信息量，而截断发生在行尾——直接 truncate 会恰好切掉最该看的那几段。
 * 完整路径挂在行的 title 上。
 */
function shortDir(dir: string): string {
  const segs = dir.split("/").filter(Boolean);
  if (segs.length <= 2) return dir;
  return `…/${segs.slice(-2).join("/")}`;
}

/**
 * 产物卡与折叠行共用的动作集：
 * - 代码：开右侧「文件」标签，用 CodeMirror 看这次 write 的内容快照（源码；md 默认给渲染预览）
 * - 预览：仅网页/PDF 类才有——开内置浏览器（原生 webview）加载这个文件；md/csv/json 走「代码」查看
 * - primary：行/卡主体的默认出口，能预览就预览，否则看代码
 */
type ArtifactActions = {
  canPreview: boolean;
  panelTitle: string | null;
  openCode: () => void;
  openPreview: () => void;
  openInPanel: () => void;
  primary: () => void;
};

const useArtifactActions = (artifact: MessageArtifact): ArtifactActions => {
  // 有效工作目录：当前工作区 → 任务工作区兜底（异步补齐后自动重渲染）。
  // 没有它就没有任何相对路径可谈：预览/在画布中打开都以它为锚。
  const cwd = usePanelCwd();
  // 地球按钮只对能在浏览器里渲染的类型出现（md 等交给「代码」的文件标签预览）
  const canPreview = !!cwd && isBrowserPreviewable(artifact.path);
  // 产物命中已装面板的 opens glob（如 *.canvas.json）→ 追加「在画布中打开」
  const relPath =
    cwd && artifact.path.startsWith(`${cwd}/`)
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

  return {
    canPreview,
    panelTitle: panelForFile?.panel.title ?? null,
    openCode,
    openPreview,
    openInPanel,
    primary: canPreview ? openPreview : openCode,
  };
};

/**
 * 行的操作按钮组：与行的主按钮并列，不是它的后代——按钮里套按钮既不合 ARIA，
 * 读屏也会把「查看代码/浏览器预览」并进行的可访问名。
 */
const RowActions: FC<{ actions: ArtifactActions }> = ({ actions }) => (
  <span className="flex shrink-0 items-center gap-0.5">
    <button
      type="button"
      onClick={actions.openCode}
      aria-label="查看代码"
      title="查看代码"
      className={cn(rowIconBtn)}
    >
      <FileCodeIcon className="size-3.5" />
    </button>
    {actions.canPreview ? (
      <button
        type="button"
        onClick={actions.openPreview}
        aria-label="浏览器预览"
        title="浏览器预览"
        className={cn(rowIconBtn)}
      >
        <GlobeIcon className="size-3.5" />
      </button>
    ) : null}
    {actions.panelTitle ? (
      <button
        type="button"
        onClick={actions.openInPanel}
        aria-label={`在${actions.panelTitle}中打开`}
        title={`在${actions.panelTitle}中打开`}
        className={cn(rowIconBtn)}
      >
        <LayoutPanelTopIcon className="size-3.5" />
      </button>
    ) : null}
  </span>
);

/**
 * 单张产物卡（对齐参考图：图标 + 文件名 + 大小 + 操作）。
 * 只在「一轮只有一个产物」时用——它是交付物本身，值得一张有分量的卡；
 * 多个产物改走 ArtifactFold 的折叠清单。
 */
export const ArtifactCard: FC<{ artifact: MessageArtifact }> = ({
  artifact,
}) => {
  const actions = useArtifactActions(artifact);

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
        onClick={actions.openCode}
        aria-label="查看代码"
        title="查看代码"
        className={cn(iconBtn)}
      >
        <FileCodeIcon className="size-4" />
      </button>
      {actions.canPreview ? (
        <button
          type="button"
          onClick={actions.openPreview}
          aria-label="浏览器预览"
          title="浏览器预览"
          className={cn(iconBtn)}
        >
          <GlobeIcon className="size-4" />
        </button>
      ) : null}
      {actions.panelTitle ? (
        <button
          type="button"
          onClick={actions.openInPanel}
          aria-label={`在${actions.panelTitle}中打开`}
          title={`在${actions.panelTitle}中打开`}
          className={cn(iconBtn)}
        >
          <LayoutPanelTopIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
};

/**
 * 折叠组里的一行（git 文件列表形态：小图标 + 文件名 + 目录 + 大小 + 操作）。
 * 「图标 + 文件名 + 目录」是一枚真按钮，撑满行内剩余宽度——大部分行面都能点开，
 * 键盘/读屏拿到的也是一个名字干净的按钮；大小与行尾操作是它的兄弟。
 * 一行 36px，替掉原来那张 ~90px 的通栏大卡。
 */
const ArtifactRow: FC<{ artifact: MessageArtifact }> = ({ artifact }) => {
  const actions = useArtifactActions(artifact);
  const { dir, base } = splitPath(artifact.path);

  return (
    <div
      data-slot="aui_artifact-row-inline"
      className="hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors"
    >
      <button
        type="button"
        onClick={actions.primary}
        title={artifact.path}
        className="focus-visible:ring-ring/40 flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2"
      >
        <FileTypeIcon path={artifact.path} />
        {/* 文件名封顶 60%：超长名不让目录和大小被挤出视野（截断发生在名字上） */}
        <span className="text-foreground/90 max-w-[60%] shrink-0 truncate text-sm font-medium">
          {base}
        </span>
        <span className="text-muted-foreground/70 min-w-0 flex-1 truncate text-xs">
          {shortDir(dir)}
        </span>
      </button>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {formatBytes(artifact.size)}
      </span>
      <RowActions actions={actions} />
    </div>
  );
};

/** 展开/收起动画：与检查点卡/轮次折叠/reasoning 同一套——globals.css 的
 *  collapsible-down/up 高度关键帧 + 同款缓动，chevron 与内层 fade/slide/blur
 *  同拍，动画期间钉住滚动位置 */
const FOLD_ANIMATION_MS = 200;
const FOLD_EASE = "ease-[cubic-bezier(0.32,0.72,0,1)]";

/**
 * 多产物折叠组的默认展开阈值：≤3 个直接铺开（一行摘要 + 三行清单也就百来像素，
 * 省掉一次没必要的点击），更多就先折成一行——长交付（一份报告带 5 个页面、
 * 一次跑出十几张图）不该把消息尾部撑成一面卡片墙。
 */
const FOLD_OPEN_MAX = 3;

/**
 * 多产物折叠组：头部一行「N 个产物 · 总大小」，展开才是逐文件的紧凑清单。
 * 与检查点卡同构（同款折叠头 + 高度关键帧），因为两者都是「本轮的交付物/改动
 * 汇总成一条、点开看明细」——git 的 N files changed 就是这个形态。
 */
const ArtifactFold: FC<{ artifacts: MessageArtifact[] }> = ({ artifacts }) => {
  // 初值只在挂载时定：产物列表在回合结束后才出现，此后不会再变（同轮不再有 write），
  // 用户手动开合过就不再被重新计算覆盖
  const [open, setOpen] = useState(artifacts.length <= FOLD_OPEN_MAX);
  const total = useMemo(
    () => artifacts.reduce((sum, a) => sum + a.size, 0),
    [artifacts],
  );

  // 高度动画期间钉住滚动位置（检查点卡同款）：折叠组在消息末尾，展开会把下方
  // 内容整体推走，不钉住的话视口会跟着乱跳
  const panelRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(panelRef, FOLD_ANIMATION_MS);
  const prevOpen = useRef(open);
  useLayoutEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    lockScroll();
  }, [open, lockScroll]);

  return (
    <Collapsible
      ref={panelRef}
      open={open}
      onOpenChange={setOpen}
      data-slot="aui_artifact-fold"
      className="bg-muted/40 border-border/60 rounded-xl border text-[13px]"
      style={{
        ["--animation-duration" as string]: `${FOLD_ANIMATION_MS}ms`,
      }}
    >
      {/* 整行头部即折叠开关；展开时下沿改直角，与明细连成一片 */}
      <CollapsibleTrigger
        className={cn(
          "hover:bg-muted/60 active:bg-muted/80 flex w-full cursor-pointer items-center gap-x-2.5 p-2 text-left transition-colors focus-visible:ring-ring/40 focus-visible:ring-2 focus-visible:outline-none",
          open ? "rounded-t-xl rounded-b-none" : "rounded-xl",
        )}
      >
        <ChevronDownIcon
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
        <PackageIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-foreground/90 shrink-0 text-sm font-medium">
          {artifacts.length} 个产物
        </span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatBytes(total)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent
        // 由 Trigger 控制开合：这里只负责高度关键帧与内层同拍动画
        className={cn(
          "group/artifact-content overflow-hidden outline-none",
          FOLD_EASE,
          "motion-reduce:animate-none",
          "data-closed:animate-collapsible-up",
          "data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards",
          "data-closed:pointer-events-none",
          "[--tw-duration:var(--animation-duration)]",
        )}
      >
        <div
          className={cn(
            "transform-gpu",
            FOLD_EASE,
            "motion-reduce:animate-none",
            "group-data-open/artifact-content:animate-in",
            "group-data-closed/artifact-content:animate-out",
            "group-data-open/artifact-content:fade-in-0",
            "group-data-closed/artifact-content:fade-out-0",
            "group-data-open/artifact-content:slide-in-from-top-1",
            "group-data-closed/artifact-content:slide-out-to-top-1",
            "group-data-open/artifact-content:blur-in-[2px]",
            "group-data-closed/artifact-content:blur-out-[2px]",
            "group-data-open/artifact-content:animation-duration-(--animation-duration)",
            "group-data-closed/artifact-content:animation-duration-(--animation-duration)",
          )}
        >
          <div className="border-border/60 flex flex-col gap-0.5 border-t px-1.5 py-1.5">
            {artifacts.map((a) => (
              <ArtifactRow key={a.toolCallId} artifact={a} />
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

/**
 * 一轮对话尾部的产物清单。
 * 只在回合结束后计算一次：流式期间逐 token 重扫 parts、重算大文件字节数代价高，
 * 且半截内容出卡也不合理——运行中直接返回空。
 * 挂在本轮末条 assistant 消息上、扫本轮全部 assistant 消息的 parts：
 * 折叠轮（Codex 风格）里轮中过程消息整体不挂载，产物是交付物，必须保留可见。
 * 单个产物 = 一张卡（交付物本身值得分量）；多个 = 一个折叠组（摘要一行，
 * 展开是紧凑清单），避免每个产物各占一张通栏卡。
 */
export const MessageArtifacts: FC = () => {
  const running = useAuiState((s) => s.message.status?.type === "running");
  // 选择器回的是缓存过的 parts 数组（按 messages 数组身份 + 轮次键缓存，
  // 同一批消息下引用稳定），不是新数组——不会因新身份反复重渲
  const parts = useAuiState((s) => {
    if (s.message.role !== "assistant") return null;
    const slot = parseTurnSlot(
      packTurnSlot(s.thread.messages, String(s.message.id)),
    );
    if (!slot?.isTurnEnd) return null;
    return getTurnParts(s.thread.messages, slot.turnKey);
  });
  const artifacts = useMemo(
    () => (running || !parts ? [] : messageArtifacts(parts)),
    [running, parts],
  );
  if (artifacts.length === 0) return null;
  const single = artifacts.length === 1 ? artifacts[0] : undefined;
  return (
    <div data-slot="aui_message-artifacts" className="mt-2">
      {single ? (
        <ArtifactCard artifact={single} />
      ) : (
        <ArtifactFold artifacts={artifacts} />
      )}
    </div>
  );
};
