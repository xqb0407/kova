"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FC,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  FolderTreeIcon,
  ListFilterIcon,
  PanelRightCloseIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  FileExplorer,
  type ExplorerFileRef,
} from "@/components/files/file-explorer";
import { useFilePreviewMenuPrefix } from "@/components/files/file-preview-menu";
import { useTreeDropImport } from "@/components/files/use-tree-drop-import";
import { fsErrorText, fsMove } from "@/lib/workspace/fs";
import { toast } from "@/components/ui/toast";
import {
  clampFileRailWidth,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  setFileRailWidth,
  toggleFileRail,
  toggleFileRailChangedOnly,
  useFileRailChangedOnly,
  useFileRailOpen,
  useFileRailWidth,
} from "@/lib/panels/file-rail";
import { previewFileTab, pinFileTab } from "@/lib/panels/panel-tabs";
import { useIsRemoteWorkspace } from "@/lib/workspace/remote-projects";
import { useGitStatus } from "@/lib/git/git-status";
import { cn } from "@/lib/utils";

/**
 * 文件预览右缘的文件树栏：看代码时不再切到「文件树」标签。
 * - 展开态（默认 224px，左缘拖拽可调 160–480）：头部「文件树 + 收起」，
 *   下方整块挂 FileExplorer（右键菜单/拖拽/新建/浏览器预览等原样继承）
 * - 收起态 32px 竖条：只留一枚展开按钮，右缘永远有入口
 * - 展开态与宽度存在 lib/panels/file-rail（模块级）：切文件标签不重置；
 *   树的展开/选中经 FileExplorer 的 stateKey 缓存跨重挂载保持。
 * - 远程项目暂不支持文件树：整条右栏（含收起态入口）都不渲染，文件预览
 *   本身仍走 remote_fs_* 正常显示。
 */
export const FileRail: FC<{ cwd: string; activePath: string | null }> = ({
  cwd,
  activePath,
}) => {
  const remote = useIsRemoteWorkspace(cwd);
  const open = useFileRailOpen();
  const width = useFileRailWidth();
  const changedOnly = useFileRailChangedOnly();
  // 只在过滤开启时拉 git status：平时打开文件不额外跑一条 git 命令；开启后
  // 挂到同一个 cwd 缓存，后续 git-changed/聚焦刷新由 store 统一负责。
  const git = useGitStatus(remote || !changedOnly ? null : cwd);
  /** git 状态 → 树根相对路径；`../x`（工作区是仓库子目录时的上级改动）不在
   *  这棵树里，剔除；重命名取新路径（旧路径通常已不存在）。 */
  const changedPaths = useMemo(() => {
    if (!changedOnly) return null;
    const paths = new Set<string>();
    for (const file of git.status?.files ?? []) {
      const rel = file.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
      if (!rel || rel.startsWith("../") || rel.startsWith("/")) continue;
      paths.add(rel);
    }
    return paths;
  }, [changedOnly, git.status]);
  const filterEmptyText = git.loading
    ? "正在读取变更…"
    : git.status
      ? "当前没有可显示的变更文件"
      : "当前目录不是 Git 仓库";
  const fileMenuPrefix = useFilePreviewMenuPrefix(cwd);
  // 单击 = 预览替换（VS Code 语义）：复用当前会话唯一的临时标签，不再每点
  // 一个文件就多一个标签；双击 / 右键「在新标签页中打开」转常驻
  const onOpenFile = useCallback((file: ExplorerFileRef) => {
    previewFileTab(file.cwd, file.rel, file.name);
  }, []);
  const onOpenFilePermanent = useCallback((file: ExplorerFileRef) => {
    pinFileTab(file.cwd, file.rel, file.name);
  }, []);
  // 外部文件（Finder/桌面）拖进树栏：拷入落点目录，完成后重拉（共用实现）
  const onDropPaths = useTreeDropImport(cwd);
  // 树内拖动（行拖进文件夹 / 空白区落根）：fs_move 同根内移动，重名自动加
  // 序号；返回 moved/name（FileExplorer 侧统一失效缓存重拉，并用 name 把
  // 多选 rel 跟到改号后的新路径）
  const onMoveRow = useCallback(
    async (
      srcRel: string,
      destDir: string,
    ): Promise<{ moved: boolean; name: string } | false> => {
      const r = await fsMove(cwd, srcRel, destDir);
      if (!r.ok) {
        toast.error(fsErrorText(r.error));
        return false;
      }
      // name 用于多选拖拽后把选区 rel 跟到重名自动改号后的新路径
      return { moved: r.moved, name: r.name };
    },
    [cwd],
  );
  // 受控选中的写回调：选中跟随 activePath（打开哪个文件就亮哪个），
  // 用户点选本身由 onOpenFile 驱动；给稳定引用，别让行处理器每渲染换身份
  const onSelectedChange = useCallback(() => {}, []);

  // 左缘拖拽调宽：右栏贴右缘，向左拖（clientX 变小）= 变宽。
  // 拖拽中直接改 aside 的 style.width（不写 store）：写 store 会让
  // FileExplorer 跟着逐帧重渲染，大树掉帧；松手才提交最终宽度。
  const asideRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: width, width };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width],
  );
  const onHandlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampFileRailWidth(
        drag.startWidth + (drag.startX - event.clientX),
      );
      drag.width = next;
      asideRef.current?.style.setProperty("width", `${next}px`);
    },
    [],
  );
  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const final = dragRef.current?.width;
    dragRef.current = null;
    setDragging(false);
    if (final !== undefined) setFileRailWidth(final);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  // 远程项目：文件树暂不支持，连收起态的入口也不挂（避免点开只有一个空树）
  if (remote) return null;

  if (!open) {
    return (
      <div className="border-border/60 flex w-8 shrink-0 flex-col items-center border-l py-1.5">
        <TooltipIconButton
          tooltip="展开文件树"
          side="left"
          onClick={toggleFileRail}
          className="size-7"
        >
          <FolderTreeIcon className="size-4" />
        </TooltipIconButton>
      </div>
    );
  }

  return (
    <aside
      ref={asideRef}
      aria-label="文件树栏"
      className={`border-border/60 relative flex shrink-0 flex-col border-l ${
        dragging ? "select-none" : ""
      }`}
      style={{ width }}
    >
      {/* 左缘拖拽把手：骑在边框上（不外扩，别抢内容区点击） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整文件树宽度"
        aria-valuemin={RAIL_MIN_WIDTH}
        aria-valuemax={RAIL_MAX_WIDTH}
        aria-valuenow={width}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none transition-colors hover:bg-primary/25 ${
          dragging ? "bg-primary/35" : ""
        }`}
      />
      <div
        className={`border-border/60 text-muted-foreground flex h-9 shrink-0 items-center gap-1.5 border-b px-2 ${
          dragging ? "select-none" : ""
        }`}
      >
        <FolderTreeIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs">
          {changedOnly ? "变更文件" : "文件树"}
        </span>
        <TooltipIconButton
          tooltip={changedOnly ? "显示全部文件" : "只显示变更"}
          side="left"
          onClick={toggleFileRailChangedOnly}
          aria-pressed={changedOnly}
          className={cn(
            "size-6 shrink-0",
            changedOnly && "bg-muted text-foreground",
          )}
        >
          <ListFilterIcon className="size-4" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip="收起文件树"
          side="left"
          onClick={toggleFileRail}
          className="size-6 shrink-0"
        >
          <PanelRightCloseIcon className="size-4" />
        </TooltipIconButton>
      </div>
      <div className="min-h-0 flex-1">
        <FileExplorer
          rootCwd={cwd}
          multiSelect
          onOpenFile={onOpenFile}
          onOpenFilePermanent={onOpenFilePermanent}
          fileMenuPrefix={fileMenuPrefix}
          onDropPaths={onDropPaths}
          onMoveRow={onMoveRow}
          // 独立记忆槽：与「文件树」标签（"panel"）互不覆盖——两处的
          // 根可能不同（标签里有项目根切换器），展开态各自独立演进
          stateKey="panel-file-rail"
          // 受控选中：高亮当前正在看的文件；点选即开/聚焦对应标签
          selected={activePath}
          onSelectedChange={onSelectedChange}
          ariaLabel={changedOnly ? "变更文件" : "文件树"}
          pendingText="正在准备任务目录…"
          changedPaths={changedPaths}
          filterEmptyText={filterEmptyText}
        />
      </div>
    </aside>
  );
};
