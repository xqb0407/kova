"use client";

/**
 * 资料库（侧边栏「资料库」主区视图）。
 *
 * 布局：通栏固定 header（跨整页宽，左侧页面动作、右侧搜索/导入/刷新）之下
 * 是内容区，只有两列——**一棵树 + 查看器**：用户自己的文件是主根，AI 产物
 * （task-workspace）作为合成顶层节点挂在同一棵树里，不再有二级页与额外竖栏。
 * 树本体与右键菜单在 components/files/FileExplorer（与 agent 面板共用）。
 *
 * 「引用到对话」只对资料库根下的文件提供（AI 产物不参与引用）：树右键 /
 * 查看器顶部按钮 / 编辑器选区浮层三条路都汇到 `handleReference`——把
 * `:library[...]` 芯片写进当前会话草稿（aui.composer.setText，输入框不在场
 * 也能写），用户点 toast 的「去对话」切回聊天页。
 */

import { useCallback, useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { useAui } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ImportIcon,
  NotebookPenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useLibraryRoot, refreshLibraryRoot } from "@/lib/workspace/library-root";
import {
  parseLibraryDirectiveId,
  buildLibraryDirective,
  type LibraryReference,
} from "@/lib/composer/library-reference";
import { invalidateLibraryIndex } from "@/lib/workspace/library-index";
import { listen } from "@/desktop-bridge/event";
import { invoke } from "@/desktop-bridge/core";
import { appendDirectiveToComposer } from "@/components/agent-thread/cm-composer-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LibraryPane, type LibrarySelection } from "./library-pane";
import { useLibraryActions } from "./use-library-actions";

export const LibraryView: FC<{ onBackToChat?: () => void }> = ({
  onBackToChat,
}) => {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 200);
  /** 内容刷新信号（树 + 搜索 + 当前打开的文件一起刷新） */
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  /** 应用 Header 的页面槽位（base 与本页同一次提交渲染，DOM 已就位） */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  /** watcher 报告根消失（library:root-missing）：刷新后 exists 恢复就清除 */
  const [rootMissing, setRootMissing] = useState(false);

  const rootInfo = useLibraryRoot();
  const root = rootInfo?.root ?? null;
  const rootUnavailable = rootMissing || Boolean(root && rootInfo?.exists === false);

  const aui = useAui();

  useEffect(() => {
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="page-header-actions"]'),
    );
  }, []);

  const bumpRefresh = useCallback(() => {
    // 改名/删除/新建后 @ 选择器的最近条目缓存也要失效，否则名字还是旧的
    invalidateLibraryIndex();
    setRefreshSignal((n) => n + 1);
  }, []);

  // 系统删除/同步盘变更感知（主进程 watcher），加窗口聚焦兜底：
  // 刷新树/查看器，并让引用索引与草稿守卫在下一轮校验里更新
  useEffect(() => {
    let alive = true;
    const offs: (() => void)[] = [];
    void listen("library:changed", () => {
      invalidateLibraryIndex();
      bumpRefresh();
    }).then((un) => {
      if (!alive) un();
      else offs.push(un);
    });
    void listen("library:root-missing", () => {
      setRootMissing(true);
    }).then((un) => {
      if (!alive) un();
      else offs.push(un);
    });
    const onRefocus = () => {
      invalidateLibraryIndex();
      bumpRefresh();
    };
    window.addEventListener("focus", onRefocus);
    const onVisibility = () => {
      if (document.visibilityState === "visible") onRefocus();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      for (const off of offs) off();
      window.removeEventListener("focus", onRefocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [bumpRefresh]);

  const actions = useLibraryActions({
    root,
    onChanged: (newNote) => {
      invalidateLibraryIndex();
      setRefreshSignal((n) => n + 1);
      if (newNote) setSelection({ value: newNote.rel, cwd: root ?? "", ...newNote });
    },
  });

  /**
   * 「引用」：**新建对话 → 把芯片放进新会话草稿 → 跳转过去**。
   * 当前线程若是空会话（还没发过消息、也没在跑）就复用它，避免连点引用
   * 造出一串空会话；否则 switchToNewThread 新建。写入走 runtime 草稿
   * （appendDirectiveToComposer），聊天页挂载后 CmComposerInput 自动回填。
   */
  const handleReference = useCallback(
    (ref: LibraryReference) => {
      const directive = buildLibraryDirective(ref);
      void (async () => {
        try {
          const thread = aui.thread.getState();
          const emptyDraft =
            thread.messages.length === 0 && !thread.isRunning;
          if (!emptyDraft) await aui.threads.switchToNewThread();
          if (!appendDirectiveToComposer(aui, directive)) {
            toast.error("新对话未就绪，未能插入引用");
            return;
          }
          onBackToChat?.();
        } catch (err) {
          toast.error(
            `新建对话失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    [aui, onBackToChat],
  );

  /** 删除确认框的引用提示：当前草稿是否引用了该文件/目录（前缀匹配目录） */
  const isReferenced = useCallback((rel: string, isDir: boolean): boolean => {
    let text = "";
    try {
      text = aui.composer.getState().text ?? "";
    } catch {
      return false;
    }
    if (!text.includes(":library[")) return false;
    const segments = unstable_defaultDirectiveFormatter.parse(text);
    for (const segment of segments) {
      if (segment.kind === "text" || segment.type !== "library") continue;
      const ref =
        parseLibraryDirectiveId(segment.id) ??
        parseLibraryDirectiveId(segment.label);
      if (!ref) continue;
      if (ref.rel === rel) return true;
      if (isDir && ref.rel.startsWith(`${rel}/`)) return true;
    }
    return false;
  }, [aui]);

  const retryRoot = useCallback(async () => {
    await refreshLibraryRoot();
    try {
      await invoke("library_watch_restart");
    } catch {
      /* 主进程 watcher 重启失败不阻塞重试 */
    }
    setRootMissing(false);
    invalidateLibraryIndex();
    bumpRefresh();
  }, [bumpRefresh]);

  const openLibrarySettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("kova:open-settings-section", { detail: "general" }),
    );
  }, []);

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
        className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
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
        onClick={() => {
          invalidateLibraryIndex();
          setRefreshSignal((n) => n + 1);
        }}
      >
        <RefreshCwIcon className="size-4" />
      </Button>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {headerSlot ? createPortal(headerContent, headerSlot) : null}
      {rootUnavailable && (
        <div className="border-amber-500/40 bg-amber-500/10 mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2">
          <AlertTriangleIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-muted-foreground min-w-0 flex-1 text-xs">
            资料库位置不可用（目录可能被移动、删除或未挂载），引用已停用
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void retryRoot()}>
            重试
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={openLibrarySettings}>
            更改位置
          </Button>
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        <LibraryPane
          root={root}
          query={debouncedQuery}
          selected={selection}
          onSelect={setSelection}
          refreshSignal={refreshSignal}
          actions={actions}
          onReference={handleReference}
          isReferenced={isReferenced}
          onLibraryChanged={bumpRefresh}
        />
      </div>
    </div>
  );
};
