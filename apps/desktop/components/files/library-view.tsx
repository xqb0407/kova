"use client";

/**
 * 资料库（侧边栏「资料库」主区视图）。
 *
 * 布局：通栏固定 header（跨整页宽，左侧页面动作、右侧搜索/导入/刷新）之下
 * 是内容区，只有两列——**一棵树 + 查看器**：用户自己的文件是主根，AI 产物
 * （task-workspace）作为合成顶层节点挂在同一棵树里，不再有二级页与额外竖栏。
 * 树本体与右键菜单在 components/files/FileExplorer（与 agent 面板共用）。
 */

import { useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDownIcon,
  ImportIcon,
  NotebookPenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useLibraryRoot } from "@/lib/workspace/library-root";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LibraryPane, type LibrarySelection } from "./library-pane";
import { useLibraryActions } from "./use-library-actions";

export const LibraryView: FC = () => {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  /** 内容刷新信号（树 + 搜索 + 当前打开的文件一起刷新） */
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  /** 应用 Header 的页面槽位（base 与本页同一次提交渲染，DOM 已就位） */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const rootInfo = useLibraryRoot();
  const root = rootInfo?.root ?? null;

  useEffect(() => {
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="page-header-actions"]'),
    );
  }, []);

  const actions = useLibraryActions({
    root,
    onChanged: (newNote) => {
      setRefreshSignal((n) => n + 1);
      if (newNote) setSelection({ value: newNote.rel, cwd: root ?? "", ...newNote });
    },
  });

  /** 顶栏内容（注入应用 Header 的页面槽位）：左侧身份 + 新建，右侧搜索/导入/刷新 */
  const headerContent = (
    <>
      <span
        data-drag-region="false"
        className="shrink-0 pr-1 text-sm font-semibold tracking-tight whitespace-nowrap"
      >
        资料库
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => void actions.newNote("")}
      >
        <NotebookPenIcon />
        新建笔记
      </Button>
      {/* 弹性中段：列被面板挤窄时截断，而不是把标题/按钮挤成两行；
          data-drag-region="false" 让说明文字可选中/复制（顶栏整行是拖拽区） */}
      <span
        data-drag-region="false"
        className="text-muted-foreground/60 min-w-0 flex-1 truncate text-xs"
      >
        也可以把文件直接拖进来；AI 产物也在同一棵树里
      </span>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索笔记与文件…"
        className="h-8 w-40 shrink-0 rounded-md border-none bg-muted/60 text-sm xl:w-56"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" className="shrink-0">
              <ImportIcon />
              导入
              <ChevronDownIcon className="size-3.5 opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={() => void actions.pickImport("", false)}>
            <ImportIcon />
            导入文件…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void actions.pickImport("", true)}>
            <ImportIcon />
            导入文件夹…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        title="刷新"
        onClick={() => setRefreshSignal((n) => n + 1)}
      >
        <RefreshCwIcon className="size-4" />
      </Button>
    </>
  );

  return (
    <div className="flex h-full overflow-hidden">
      {headerSlot ? createPortal(headerContent, headerSlot) : null}
      <div className="min-w-0 flex-1">
        <LibraryPane
          root={root}
          query={debouncedQuery}
          selected={selection}
          onSelect={setSelection}
          refreshSignal={refreshSignal}
          actions={actions}
        />
      </div>
    </div>
  );
};