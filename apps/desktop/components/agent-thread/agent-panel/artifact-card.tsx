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
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import {
  ARTIFACT_CANDIDATE_LIMIT,
  collectTurnArtifactCandidates,
  formatBytes,
  mergeArtifactCandidates,
  openModeFor,
  resolveTurnStartMs,
  toFileUrl,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import { useCheckpointArtifactCandidates } from "@/lib/panels/use-checkpoint-artifacts";
import { useResolvedArtifacts } from "@/lib/panels/use-artifacts";
import { useRunCheckpoints } from "@/lib/pi/pi-checkpoints";
import { getTurnParts, packTurnSlot, parseTurnSlot } from "@/lib/panels/message-turns";
import { focusPanelTab, focusPluginPanel } from "@/lib/panels/panel-tabs";
import { findPanelForFile, usePluginPanels } from "@/lib/plugins/plugin-panels";
import { getSubagentArtifactPaths, useSubagentArtifactVersion } from "@/lib/subagent/subagent-runs";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { fsOpen, fsReveal } from "@/lib/workspace/fs";
import { isDesktop } from "@/lib/desktop-env";
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
 * - 代码：文本类开右侧「文件」标签，优先磁盘实时内容（append/后续 edit 也完整）；
 *   没有相对路径/没有磁盘桥时退回 write 快照；
 * - 预览：仅网页/PDF 类才有——开内置浏览器（原生 webview）加载这个文件；
 * - 系统打开：Office/压缩包/音视频等没有内置查看器的类型走默认应用；
 * - primary：能预览就预览，否则按打开模式分流。
 */
type ArtifactActions = {
  canPreview: boolean;
  panelTitle: string | null;
  codeLabel: string;
  codeTitle: string;
  openCode: () => void;
  openPreview: () => void;
  openInPanel: () => void;
  primary: () => void;
};

const useArtifactActions = (artifact: MessageArtifact): ArtifactActions => {
  // 有效工作目录：当前工作区 → 任务工作区兜底（异步补齐后自动重渲染）。
  // 没有它就没有任何相对路径可谈：预览/在画布中打开都以它为锚。
  const cwd = usePanelCwd();
  const openMode = artifact.openMode ?? openModeFor(artifact.path);
  // 地球按钮只对能在浏览器里渲染的类型出现（md 等交给「文件」标签预览）
  const canPreview = !!cwd && openMode === "browser";
  // 产物命中已装面板的 opens glob（如 *.canvas.json）→ 追加「在画布中打开」
  const relPath =
    artifact.relPath ??
    (cwd && artifact.path.startsWith(`${cwd}/`)
      ? artifact.path.slice(cwd.length + 1)
      : artifact.path);
  const { panels } = usePluginPanels();
  const panelForFile = cwd ? findPanelForFile(panels, relPath) : undefined;
  const isSystemOpen = openMode === "system";
  // write 的 toolCallId 才有内容快照；edit 只有替换片段，不能当全文渲染。
  const hasSnapshot =
    artifact.source === "write" && !artifact.toolCallId.startsWith("artifact:");

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
    // 相对路径优先磁盘实时模式：append 大文件/后续 edit 都能看到最终内容。
    if (cwd && artifact.relPath != null) {
      focusPanelTab("file", {
        cwd,
        path: artifact.relPath,
        title: artifact.base,
        focus: undefined,
      });
    } else if (hasSnapshot) {
      focusPanelTab("file", {
        focus: artifact.toolCallId,
        title: artifact.base,
      });
    } else {
      // 正文/子代理发现、无 write 快照、又是绝对路径：交给系统默认应用。
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
    codeLabel: isSystemOpen ? "打开文件" : "查看代码",
    codeTitle: isSystemOpen ? "用系统默认应用打开" : "查看代码",
    openCode,
    openPreview,
    openInPanel,
    primary: canPreview ? openPreview : isSystemOpen ? openSystem : openCode,
  };
};

/**
 * 行的操作按钮组：与行的主按钮并列，不是它的后代——按钮里套按钮既不合 ARIA，
 * 读屏也会把「查看代码/浏览器预览」并进行的可访问名。
 */
const RowActions: FC<{ actions: ArtifactActions }> = ({ actions }) => {
  const ActionIcon =
    actions.codeLabel === "打开文件" ? SquareArrowOutUpRightIcon : FileCodeIcon;
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={actions.openCode}
        aria-label={actions.codeLabel}
        title={actions.codeTitle}
        className={cn(rowIconBtn)}
      >
        <ActionIcon className="size-3.5" />
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
};

/**
 * 单张产物卡（对齐参考图：图标 + 文件名 + 大小 + 操作）。
 * 只在「一轮只有一个产物」时用——它是交付物本身，值得一张有分量的卡；
 * 多个产物改走 ArtifactFold 的折叠清单。
 */
export const ArtifactCard: FC<{ artifact: MessageArtifact }> = ({
  artifact,
}) => {
  const actions = useArtifactActions(artifact);
  const ActionIcon =
    actions.codeLabel === "打开文件" ? SquareArrowOutUpRightIcon : FileCodeIcon;

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
        aria-label={actions.codeLabel}
        title={actions.codeTitle}
        className={cn(iconBtn)}
      >
        <ActionIcon className="size-4" />
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
 *
 * 挂载点从“轮末消息”放宽到“轮末或 answer tail”：空闲/手动压缩会在轮末留下
 * 一条纯分隔线消息，轮末身份归它，但产物属于答案面，不能被折叠过程区带走。
 * 数据仍取本轮全部 assistant parts（折叠轮里轮中消息不挂载，交付物必须保留）。
 *
 * 单个产物 = 一张卡；多个 = 一个折叠组（摘要一行，展开是紧凑清单）。
 */
export const MessageArtifacts: FC = () => {
  const cwd = usePanelCwd();
  const subagentVersion = useSubagentArtifactVersion();
  // 选择器只回稳定字符串：packed slot + turnStartMs。对象/数组会破坏
  // useSyncExternalStore 的身份比较，流式期间反复重渲。
  const gate = useAuiState((s) => {
    if (s.message.role !== "assistant") return "";
    const packed = packTurnSlot(s.thread.messages, String(s.message.id));
    const slot = parseTurnSlot(packed);
    if (
      !slot ||
      slot.dividerOnly ||
      (!slot.isTurnEnd && !slot.isAnswerTail) ||
      slot.turnRunning
    ) {
      return "";
    }
    const createdAt = (s.message as { createdAt?: Date | string }).createdAt;
    // 选择器必须返回稳定值：没有 createdAt 时用 0 兜底，不能在这里调
    // Date.now()（每次 getSnapshot 都变会让 useSyncExternalStore 反复重渲）。
    const fallbackMs =
      createdAt instanceof Date
        ? createdAt.getTime()
        : typeof createdAt === "string"
          ? Date.parse(createdAt)
          : 0;
    const startMs = resolveTurnStartMs(
      s.thread.messages,
      slot.anchorUserIndex,
      Number.isFinite(fallbackMs) ? fallbackMs : 0,
    );
    return `${packed}\u0001${startMs}`;
  });
  const { slot, turnStartMs } = useMemo(() => {
    const [packed = "", rawStart = ""] = gate.split("\u0001");
    return {
      slot: packed ? parseTurnSlot(packed) : null,
      turnStartMs: Number(rawStart) || Date.now(),
    };
  }, [gate]);
  // 选择器回的是缓存过的 parts 数组（按 messages 数组身份 + 轮次键缓存，
  // 同一批消息下引用稳定），不是新数组——不会因新身份反复重渲
  const parts = useAuiState((s) =>
    slot ? getTurnParts(s.thread.messages, slot.turnKey) : null,
  );
  const subagentPaths = useMemo(() => {
    const pathsByTask = new Map<string, string[]>();
    for (const part of parts ?? []) {
      if (part.type !== "tool-call" || part.toolName !== "Task") continue;
      const paths = getSubagentArtifactPaths(part.toolCallId);
      if (paths.length > 0) pathsByTask.set(part.toolCallId, paths);
    }
    return pathsByTask;
  }, [parts, subagentVersion]);
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const checkpoints = useRunCheckpoints(threadId ?? undefined);
  const checkpointEntry = useMemo(() => {
    const anchor = slot?.anchorUserIndex ?? -1;
    if (anchor < 0) return null;
    // 同一 anchor 有多条（重试等）时取最新一条。
    for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
      if (checkpoints[index]?.anchorIndex === anchor) return checkpoints[index]!;
    }
    return null;
  }, [checkpoints, slot?.anchorUserIndex]);
  const checkpointRequests = useMemo(
    () =>
      checkpointEntry && cwd
        ? [
            {
              hash: checkpointEntry.hash,
              turnStartMs,
              // 与会话级（turnIndex*1e6+999999）同语义：排在全部同步候选之后。
              orderBase: (parts?.length ?? 0) + 999_999,
            },
          ]
        : [],
    [checkpointEntry, cwd, turnStartMs, parts?.length],
  );
  const checkpointCandidates = useCheckpointArtifactCandidates(
    cwd,
    checkpointRequests,
  );
  const candidates = useMemo(() => {
    if (!parts || !cwd) return [];
    return mergeArtifactCandidates(
      [
        ...collectTurnArtifactCandidates({
          parts,
          cwd,
          turnStartMs,
          subagentPaths,
          includeTextReferences: isDesktop(),
        }),
        // checkpoint diff 兜底：bash/脚本/插件写出、正文没提到的文件。
        ...checkpointCandidates,
      ],
      ARTIFACT_CANDIDATE_LIMIT,
    );
  }, [parts, cwd, turnStartMs, subagentPaths, checkpointCandidates]);
  const { artifacts, settled } = useResolvedArtifacts(candidates, cwd);
  if (!settled || artifacts.length === 0) return null;
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
