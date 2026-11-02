"use client";

import { useCallback, useEffect, useState, type FC } from "react";
import { openOrFocusFileTab } from "@/lib/panels/panel-tabs";
import { usePanelCwd } from "@/lib/workspace/use-panel-cwd";
import { useIsRemoteWorkspace } from "@/lib/workspace/remote-projects";
import { fetchProjectDirs } from "@/lib/pi/pi-project-dirs";
import type { PiExternalDir } from "@/lib/pi/pi-bridge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileExplorer, type ExplorerFileRef } from "@/components/files/file-explorer";
import { useFilePreviewMenuPrefix } from "@/components/files/file-preview-menu";
import { TabEmpty } from "./tab-empty";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  FolderTreeIcon,
} from "lucide-react";

/**
 * 「文件树」标签（explorer）：当前工作目录的文件树浏览。
 * 根 = usePanelCwd 三级解析：选了工作区就是工作区；没选（全局会话）落到
 * 该会话按隔离的任务目录 <task-workspace>/<sessionId>，与 agent 实际读写
 * 同源（Rust resolve_root 已放行任务工作区子树，fs_* 读写命令直接可用）。
 *
 * 项目虚拟目录：项目配置了附加根时，标签顶部出现根切换器（主目录 + 附加根），
 * 默认当前会话 cwd。主进程 fs-cmds 的 resolveRoot 同步放行这些根，否则切过去
 * 只会得到空目录。树本体与右键菜单/对话框在 components/files/FileExplorer。
 * 仅 桌面端出现（tab-registry 可见性过滤），web 端不渲染。
 * 远程项目暂不支持：树根是远端路径，目录口径（.git/node_modules 过滤、目录
 * 优先排序）与本地不一致，入口在 tab-registry 与本组件双层收掉；已恢复的
 * 旧标签显示空态，不渲染空树。
 */

function pathLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export const FileTreeTab: FC = () => {
  const rootCwd = usePanelCwd();
  // 远程项目：暂不支持文件树（远端目录口径未对齐）。门控放在树本体外层，
  // 既挡住已恢复的旧标签，也避免为一个必然不渲染的标签去拉项目根清单。
  const remote = useIsRemoteWorkspace(rootCwd);
  if (remote) {
    return <TabEmpty icon={FolderTreeIcon} text="远程项目暂不支持文件树浏览" />;
  }
  return <FileTreeTabContent rootCwd={rootCwd} />;
};

/** 本地工作区的树本体（远程门控见 FileTreeTab） */
const FileTreeTabContent: FC<{ rootCwd: string | null }> = ({ rootCwd }) => {
  /** 项目根清单（主目录在首位）；null = 未取到/普通任务，不显示切换器 */
  const [projectRoots, setProjectRoots] = useState<PiExternalDir[] | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);

  useEffect(() => {
    if (!rootCwd) {
      setProjectRoots(null);
      setSelectedRoot(null);
      return;
    }
    let alive = true;
    // 切会话/切 cwd 时默认回到该会话自己的目录，不沿用上一个项目的选择
    setSelectedRoot(rootCwd);
    void fetchProjectDirs(rootCwd)
      .then((info) => {
        if (!alive) return;
        // 缺失的根主进程不授权（fs-cmds 只认存在的目录），切换器里也不展示，
        // 避免点过去只能是空树
        const missing = new Set(info.missing);
        setProjectRoots(info.roots.filter((root) => !missing.has(root.path)));
      })
      .catch(() => {
        if (alive) setProjectRoots(null);
      });
    return () => {
      alive = false;
    };
  }, [rootCwd]);

  const treeRoot = selectedRoot ?? rootCwd;
  const switcher = projectRoots && projectRoots.length > 1 ? projectRoots : null;

  /** 打开文件标签：同 (cwd, path) 已有标签则聚焦，否则新开（规则与
   *  文件预览右栏的 FileRail 共享，见 openOrFocusFileTab） */
  const openFile = useCallback((file: ExplorerFileRef) => {
    openOrFocusFileTab(file.cwd, file.rel, file.name);
  }, []);

  /** 浏览器标签预览项与文件预览右栏共用一份实现（见 useFilePreviewMenuPrefix） */
  const fileMenuPrefix = useFilePreviewMenuPrefix(treeRoot);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {switcher ? (
        <div className="border-border/60 flex h-8 shrink-0 items-center border-b px-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-6 max-w-full cursor-pointer items-center gap-1 rounded px-1.5 text-xs"
                  title={treeRoot ?? undefined}
                >
                  <FolderOpenIcon className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {treeRoot ? pathLabel(treeRoot) : "选择目录"}
                  </span>
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-72">
              {/* Base UI：MenuGroupLabel 必须有 Menu.Group 上下文，否则渲染即抛
                  error #31（多项目根时切换器才出现，单根不会触发） */}
              <DropdownMenuGroup>
                <DropdownMenuLabel>项目目录</DropdownMenuLabel>
                {switcher.map((root, index) => (
                  <DropdownMenuItem
                    key={root.path}
                    onClick={() => setSelectedRoot(root.path)}
                  >
                    <FolderOpenIcon className="size-3.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm">{root.label}</span>
                        {index === 0 ? (
                          <span className="bg-muted text-muted-foreground rounded px-1 text-[10px] leading-4">
                            主目录
                          </span>
                        ) : null}
                      </div>
                      <div
                        className="text-muted-foreground truncate text-xs"
                        title={root.path}
                      >
                        {root.path}
                      </div>
                    </div>
                    {treeRoot === root.path ? (
                      <CheckIcon className="size-3.5 shrink-0" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <FileExplorer
          rootCwd={treeRoot}
          onOpenFile={openFile}
          fileMenuPrefix={fileMenuPrefix}
          stateKey="panel"
          ariaLabel="工作区文件"
          pendingText="正在准备任务目录…"
        />
      </div>
    </div>
  );
};
