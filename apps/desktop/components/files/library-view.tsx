"use client";

/**
 * 资料库页（侧边栏「资料库」主区视图）：**两级页面**。
 *
 * 一级 = LibraryLanding（参考图 1）：**知识库卡片网格**——知识库是一等实体
 * { 名称, 生效范围: 用户|工作区, 绑定工作区 }（lib/workspace/knowledge-bases.ts
 * 清单管理），虚线卡 = 创建知识库弹窗；二级 = LibraryPane（参考图 2）：当前
 * KB 的「搜索 + 添加知识 + 树 + 查看器」。路由是本地 state，无地址栏——
 * 点卡片进入，页头「返回」回一级。
 *
 * 空间（LibrarySpaceCard.prefix）= KB 的内容文件夹（用户级 `知识库/<名>/`、
 * 工作区级 `项目/<工作区目录名>/<名>/`）；旧散文件不迁移不展示，只有
 * kova://library 直链会以临时卡打开。
 *
 * 「引用到对话」两个空间都提供：树右键 / 查看器顶部按钮 / 编辑器选区浮层
 * 三条路都汇到 handleReference——把 `:library[...]` 芯片写进当前会话草稿
 * （aui.composer.setText，输入框不在场也能写），用户点 toast 的「去对话」
 * 切回聊天页。
 *
 * 跨页打开请求（kova://library 链接 / 存为笔记 toast 的「打开」）按 KB
 * folder 最长前缀落到对应空间并选中；无匹配（旧散文件）造临时卡。
 */

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { useAui } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useLibraryRoot, refreshLibraryRoot } from "@/lib/workspace/library-root";
import {
  joinFsPath,
  parseLibraryDirectiveId,
  buildLibraryDirective,
  type LibraryReference,
} from "@/lib/composer/library-reference";
import { invalidateLibraryIndex } from "@/lib/workspace/library-index";
import {
  LIBRARY_OPEN_REQUEST_EVENT,
  consumePendingLibraryOpen,
  peekPendingLibraryOpen,
} from "@/lib/workspace/knowledge-link";
import { listen } from "@/desktop-bridge/event";
import { invoke } from "@/desktop-bridge/core";
import { appendDirectiveToComposer } from "@/components/agent-thread/cm-composer-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useT } from "@/lib/i18n";
import { isDesktop } from "@/lib/desktop-env";
import {
  listKnowledgeBases,
  reconcileWorkspaceKbs,
  type KnowledgeBase,
  type WorkspaceProjectRef,
} from "@/lib/workspace/knowledge-bases";
import {
  getRegistryProjects,
  isRegistryLoaded,
  projectPrimaryPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";
import {
  LibraryPane,
  type LibrarySelection,
  type LibrarySpace,
} from "./library-pane";
import { LibraryLanding, type LibrarySpaceCard } from "./library-landing";
import { useLibraryActions } from "./use-library-actions";

/** 卡片前缀 → 空间根绝对路径 */
function spaceRootOf(card: LibrarySpaceCard, libRoot: string): string {
  return card.prefix ? joinFsPath(libRoot, card.prefix) : libRoot;
}

export const LibraryView: FC<{
  onBackToChat?: () => void;
  /** 空间路由变化：一级（null）/ 二级（KB 卡）——base 用它决定顶栏分割线 */
  onSpaceChange?: (space: LibrarySpaceCard | null) => void;
}> = ({ onBackToChat, onSpaceChange }) => {
  const t = useT();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [selection, setSelection] = useState<LibrarySelection | null>(null);
  /** 应用 Header 的页面槽位（base 与本页同一次提交渲染，DOM 已就位） */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  /** watcher 报告根消失（library:root-missing）：刷新后 exists 恢复就清除 */
  const [rootMissing, setRootMissing] = useState(false);
  /** null = 一级页（空间卡片）；非空 = 二级页（该空间详情） */
  const [space, setSpace] = useState<LibrarySpaceCard | null>(null);
  // 空间路由向上同步（base 的顶栏分割线按二级/一级切换）
  useEffect(() => {
    onSpaceChange?.(space);
  }, [space, onSpaceChange]);
  const [landingQuery, setLandingQuery] = useState("");
  const debouncedLandingQuery = useDebouncedValue(landingQuery, 200);

  const rootInfo = useLibraryRoot();
  const root = rootInfo?.root ?? null;
  const rootUnavailable =
    rootMissing || Boolean(root && rootInfo?.exists === false);
  // 订阅项目注册表：主目录改名后要重跑清单加载 + 工作区对账
  const registry = useProjectRegistry();
  const registrySig = useMemo(
    () =>
      registry
        .map((project) => `${project.id}:${projectPrimaryPath(project) ?? ""}`)
        .join("|"),
    [registry],
  );

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
      // 新笔记落在当前空间（新建 dir = space.prefix）：选中并打开
      if (!newNote || !space || !root) return;
      const spaceRel = space.prefix
        ? newNote.rel.startsWith(`${space.prefix}/`)
          ? newNote.rel.slice(space.prefix.length + 1)
          : null
        : newNote.rel;
      if (spaceRel === null) return;
      setSelection({
        value: spaceRel,
        cwd: spaceRootOf(space, root),
        rel: spaceRel,
        name: newNote.name,
        rootRel: newNote.rel,
      });
    },
  });

  /** KB 清单（landing 卡片 + 跨页打开的归属匹配共用；随刷新信号重载）。
   *  null = 还没读完——跨页打开必须先等清单，否则 KB 内嵌套文件会被当成
   *  旧散文件、以子目录为空间根落错位置。 */
  const [kbs, setKbs] = useState<KnowledgeBase[] | null>(null);
  useEffect(() => {
    if (!isDesktop()) {
      setKbs([]);
      return;
    }
    if (!root) {
      setKbs(null);
      return;
    }
    let alive = true;
    const refs: WorkspaceProjectRef[] = isRegistryLoaded()
      ? getRegistryProjects()
          .map((project) => ({
            id: project.id,
            primary: projectPrimaryPath(project) ?? "",
          }))
          .filter((ref) => Boolean(ref.primary))
      : [];
    listKnowledgeBases(root)
      // 工作区目录改名的对账（无变化时不写盘；失败按原清单继续）
      .then((rows) =>
        refs.length > 0
          ? reconcileWorkspaceKbs(root, refs).catch(() => rows)
          : rows,
      )
      .then((rows) => {
        if (alive) setKbs(rows);
      })
      .catch(() => {
        // 清单读失败按空处理（新安装/损坏），pending 打开走临时卡兜底
        if (alive) setKbs([]);
      });
    return () => {
      alive = false;
    };
    // registrySig：项目主目录改名后重跑（对账依赖它）
  }, [root, refreshSignal, registrySig]);

  /** rel（库根相对）→ 归属知识库卡：KB folder 最长前缀匹配；
   *  旧散文件（不迁移不展示）造临时卡直达，不进一级页 */
  const cardForRel = useCallback(
    (rel: string): LibrarySpaceCard => {
      let best: KnowledgeBase | null = null;
      for (const kb of kbs ?? []) {
        if (rel === kb.folder || rel.startsWith(`${kb.folder}/`)) {
          if (!best || kb.folder.length > best.folder.length) best = kb;
        }
      }
      if (best) {
        return {
          id: best.id,
          title: best.name,
          prefix: best.folder,
          scopeHint:
            best.scope === "user"
              ? t("library.landing.globalScope")
              : (best.workspaceDir ?? ""),
          count: 0,
          modifiedAt: 0,
        };
      }
      const slash = rel.lastIndexOf("/");
      const prefix = slash > 0 ? rel.slice(0, slash) : "";
      const title = prefix
        ? (prefix.split("/").pop() ?? prefix)
        : t("library.view.title");
      return {
        id: `adhoc:${prefix}`,
        title,
        prefix,
        scopeHint: prefix,
        count: 0,
        modifiedAt: 0,
      };
    },
    [kbs, t],
  );

  // 回答里的资料库引用芯片 / 存为笔记 toast 的「打开」：消费跨页 pending
  // 请求，按 rel 前缀落到对应空间；等 root 与 KB 清单都就绪后再选中
  // （清单未就绪时先不消费，加载完成后本次 effect 重跑再取走）
  useEffect(() => {
    const apply = () => {
      const pending = peekPendingLibraryOpen();
      if (!pending || !root || kbs === null) return;
      consumePendingLibraryOpen();
      const card = cardForRel(pending.rel);
      const spaceRel = card.prefix
        ? pending.rel.slice(card.prefix.length + 1)
        : pending.rel;
      const name = spaceRel.split("/").pop() ?? spaceRel;
      setSpace(card);
      setSelection({
        value: spaceRel,
        cwd: spaceRootOf(card, root),
        rel: spaceRel,
        name,
        rootRel: pending.rel,
      });
      // 不 bump：打开请求不改变库内容，别为它重载清单/重扫全部子树
    };
    apply();
    window.addEventListener(LIBRARY_OPEN_REQUEST_EVENT, apply);
    return () => window.removeEventListener(LIBRARY_OPEN_REQUEST_EVENT, apply);
  }, [root, cardForRel, bumpRefresh]);

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
            toast.error(t("library.view.toast.newChatNotReady"));
            return;
          }
          onBackToChat?.();
        } catch (err) {
          toast.error(
            t("library.view.toast.newChatFailed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
    },
    [aui, onBackToChat, t],
  );

  /** 删除确认框的引用提示：当前草稿是否引用了该文件/目录（rel 已是库根相对） */
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

  const openSpace = useCallback((card: LibrarySpaceCard) => {
    setSpace(card);
    setSelection(null);
  }, []);

  /** 二级页的空间描述（pane 需要绝对根 + 前缀 + 展开记忆槽） */
  const paneSpace: LibrarySpace | null = useMemo(
    () =>
      space
        ? {
            rootCwd: root ? spaceRootOf(space, root) : "",
            prefix: space.prefix,
            stateKey: `library:${space.id}`,
          }
        : null,
    [space, root],
  );

  /** 顶栏内容（注入应用 Header 的页面槽位）：一级/二级各一套。
   *  一级（参考图 1）：右上只有搜索 + 刷新；二级（参考图 2）：面包屑
   *  「资料库 › KB 名」——两级都可点回跳，当前级加粗不可点 */
  const headerContent = space ? (
    <>
      <nav
        data-drag-region="false"
        aria-label={t("library.view.title")}
        className="flex min-w-0 shrink-0 items-center gap-1 text-sm"
      >
        <button
          type="button"
          onClick={() => setSpace(null)}
          className="text-muted-foreground hover:text-foreground rounded px-1 py-0.5 transition-colors"
        >
          {t("library.view.title")}
        </button>
        <ChevronRightIcon className="text-muted-foreground/60 size-3.5 shrink-0" />
        <span
          className="max-w-60 truncate font-semibold whitespace-nowrap"
          title={space.title}
        >
          {space.title}
        </span>
      </nav>
      <span className="min-w-0 flex-1" />
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        title={t("library.common.refresh")}
        onClick={bumpRefresh}
      >
        <RefreshCwIcon className="size-4" />
      </Button>
    </>
  ) : (
    <>
      <span className="min-w-0 flex-1" />
      <Input
        value={landingQuery}
        onChange={(e) => setLandingQuery(e.target.value)}
        placeholder={t("library.landing.searchPlaceholder")}
        className="h-8 w-40 shrink-0 rounded-md border-none bg-muted/60 text-sm xl:w-56"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        title={t("library.common.refresh")}
        onClick={bumpRefresh}
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
            {t("library.view.rootUnavailable")}
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void retryRoot()}>
            {t("common.action.retry")}
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={openLibrarySettings}>
            {t("library.view.changeLocation")}
          </Button>
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        {space && paneSpace ? (
          <LibraryPane
            root={root}
            space={paneSpace}
            selected={selection}
            onSelect={setSelection}
            refreshSignal={refreshSignal}
            actions={actions}
            onReference={handleReference}
            isReferenced={isReferenced}
            onLibraryChanged={bumpRefresh}
          />
        ) : (
          <LibraryLanding
            root={root}
            kbs={kbs ?? []}
            query={debouncedLandingQuery}
            refreshSignal={refreshSignal}
            onOpenSpace={openSpace}
            onChanged={bumpRefresh}
          />
        )}
      </div>
    </div>
  );
};
