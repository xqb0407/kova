"use client";

/**
 * 资料库一级页（参考图 1）：**知识库卡片网格**——知识库是一等实体
 * { 名称, 生效范围: 用户|工作区, 绑定工作区 }，一个工作空间可有多个；
 * 「全局」= 用户级知识库（全部工作区生效）。
 *
 * 数据 = KB 清单（lib/workspace/knowledge-bases.ts，由 LibraryView 传入）
 * + library_scan 按 `folder/` 前缀计数。虚线卡 = 创建知识库弹窗（对齐截图：
 * 名称 0/50 + 生效范围 用户/工作区 + 选择工作区）；卡片悬浮「…」= 重命名 /
 * 删除。旧散文件不迁移不展示（只留在磁盘上）。
 *
 * 版式：通栏左对齐（大留白 px-14），卡片白底描边、宽度封顶 400px 自然换行；
 * 筛选行「全部工作区 ▾」= 显示用户级 + 绑定该工作区的 KB。点卡片进二级页
 * （LibraryPane 空间详情，folder 即空间根）。
 */

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  GlobeIcon,
  LibraryIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchXIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/toast";
import { useT, getLocale } from "@/lib/i18n";
import { isDesktop } from "@/lib/desktop-env";
import { libraryScan } from "@/lib/workspace/library-files";
import { projectFolderFor } from "@/lib/workspace/library-save-note";
import { fsErrorText } from "@/lib/workspace/fs";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  renameKnowledgeBase,
  type KnowledgeBase,
} from "@/lib/workspace/knowledge-bases";
import {
  projectDisplayName,
  projectPrimaryPath,
  useProjectRegistry,
  useProjectWorkspaceDir,
} from "@/lib/pi/pi-projects";

/** 一张知识库卡（一级页 → 二级页的路由载荷） */
export interface LibrarySpaceCard {
  /** KB id；临时卡（旧散文件直达）= `adhoc:<prefix>` */
  id: string;
  title: string;
  /** 库根相对前缀 = KB folder */
  prefix: string;
  /** footer 左侧生效范围提示 */
  scopeHint: string;
  count: number;
  modifiedAt: number;
}

/** 日期（不带时间）：卡片「更新于」用 */
function formatDay(ts: number, locale: string): string {
  return new Date(ts).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const NAME_MAX = 50;

export const LibraryLanding: FC<{
  root: string | null;
  /** KB 清单（LibraryView 持有并随 refreshSignal 重载） */
  kbs: KnowledgeBase[];
  /** 已防抖的页头搜索词（知识库名或卡内文件名命中即保留） */
  query: string;
  refreshSignal: number;
  onOpenSpace: (card: LibrarySpaceCard) => void;
  /** KB 增删改后 bump（清单写入也会触发 watcher，双保险取更快的一路） */
  onChanged: () => void;
}> = ({ root, kbs, query, refreshSignal, onOpenSpace, onChanged }) => {
  const t = useT();
  const registry = useProjectRegistry();
  const currentDir = useProjectWorkspaceDir();
  /** 每个 KB 一棵子树的清单（scoped scan：大库里计数/搜索也不受全库 500 条上限影响） */
  const [scan, setScan] = useState<{
    loading: boolean;
    entriesByKb: Map<string, { rel: string; name: string; modified: string | null }[]>;
    truncated: boolean;
  }>({ loading: true, entriesByKb: new Map(), truncated: false });
  const [createOpen, setCreateOpen] = useState(false);
  /** 筛选行选中的工作区目录名（null = 全部工作区） */
  const [scopeDir, setScopeDir] = useState<string | null>(null);
  /** 重命名/删除目标（KB id） */
  const [renaming, setRenaming] = useState<KnowledgeBase | null>(null);
  const [deleting, setDeleting] = useState<KnowledgeBase | null>(null);
  /** 删除进行中：确认按钮禁用，防连点重复删除 */
  const [deletingBusy, setDeletingBusy] = useState(false);

  useEffect(() => {
    if (!isDesktop()) {
      setScan({ loading: false, entriesByKb: new Map(), truncated: false });
      return;
    }
    // 库根信息是异步镜像：首帧还在解析时保持 loading，别闪一下空态
    if (!root) {
      setScan((s) => (s.loading ? s : { ...s, loading: true }));
      return;
    }
    if (kbs.length === 0) {
      setScan({ loading: false, entriesByKb: new Map(), truncated: false });
      return;
    }
    let stale = false;
    setScan((s) => ({ ...s, loading: true }));
    void Promise.all(
      kbs.map(async (kb) => {
        const r = await libraryScan({ scope: "library", under: kb.folder }).catch(
          () => null,
        );
        return [kb.id, r] as const;
      }),
    ).then((rows) => {
      if (stale) return;
      const entriesByKb = new Map<
        string,
        { rel: string; name: string; modified: string | null }[]
      >();
      let truncated = false;
      for (const [id, r] of rows) {
        entriesByKb.set(id, r?.entries ?? []);
        if (r?.truncated) truncated = true;
      }
      setScan({ loading: false, entriesByKb, truncated });
    });
    return () => {
      stale = true;
    };
  }, [root, refreshSignal, kbs]);

  /** 工作区目录名 → 显示名（与落盘同一套 projectFolderFor 净化后匹配，
   *  缺省退目录名） */
  const workspaceLabel = useCallback(
    (dirName: string | null | undefined): string => {
      if (!dirName) return "";
      const project = registry.find((row) => {
        const primary = projectPrimaryPath(row);
        if (!primary) return false;
        const folder = projectFolderFor(primary);
        return (
          folder.startsWith("项目/") &&
          folder.slice("项目/".length) === dirName
        );
      });
      return project ? projectDisplayName(project) : dirName;
    },
    [registry],
  );

  /** KB 卡片：计数/最新修改来自各自子树的 scoped scan（含嵌套子目录） */
  const cards = useMemo<LibrarySpaceCard[]>(() => {
    return kbs
      .map((kb) => {
        const entries = scan.entriesByKb.get(kb.id) ?? [];
        let modifiedAt = 0;
        for (const e of entries) {
          const at = e.modified ? Date.parse(e.modified) : 0;
          if (at > modifiedAt) modifiedAt = at;
        }
        return {
          id: kb.id,
          title: kb.name,
          prefix: kb.folder,
          count: entries.length,
          modifiedAt,
          scopeHint:
            kb.scope === "user"
              ? t("library.landing.globalScope")
              : workspaceLabel(kb.workspaceDir),
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }, [kbs, scan.entriesByKb, t, workspaceLabel]);

  /** 工作区选项（注册表去重目录名；带项目 id 供创建清单绑定用） */
  const workspaceOptions = useMemo(() => {
    const byDir = new Map<
      string,
      { dirName: string; label: string; projectId: string }
    >();
    for (const project of registry) {
      // 已归档的项目不再作为知识库的创建/筛选目标（存量 KB 卡片照常显示）
      if (project.archived) continue;
      const primary = projectPrimaryPath(project);
      if (!primary) continue;
      // 与划词落盘/清单 folder 同一套净化规则（projectFolderFor），
      // 否则含非法字符的目录名会在「弹窗创建」与「划词懒创建」间分叉
      const folder = projectFolderFor(primary);
      if (!folder.startsWith("项目/")) continue;
      const dirName = folder.slice("项目/".length);
      if (byDir.has(dirName)) continue;
      byDir.set(dirName, {
        dirName,
        label: projectDisplayName(project),
        projectId: project.id,
      });
    }
    return [...byDir.values()];
  }, [registry]);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    let rows = cards;
    if (scopeDir) {
      // 生效于该工作区 = 用户级（全部工作区生效）+ 绑定它的工作区级
      rows = rows.filter((card) => {
        const kb = kbs.find((row) => row.id === card.id);
        return kb?.scope === "user" || kb?.workspaceDir === scopeDir;
      });
    }
    if (!needle) return rows;
    return rows.filter((card) => {
      if (card.title.toLowerCase().includes(needle)) return true;
      // 文件名命中也保留该卡（搜「部署」能看到它的知识库）
      const entries = scan.entriesByKb.get(card.id) ?? [];
      return entries.some(
        (e) =>
          e.name.toLowerCase().includes(needle) ||
          e.rel.toLowerCase().includes(needle),
      );
    });
  }, [cards, kbs, scopeDir, needle, scan.entriesByKb]);

  const scopeLabel = scopeDir
    ? (workspaceOptions.find((o) => o.dirName === scopeDir)?.label ?? scopeDir)
    : t("library.landing.filterAll");

  if (!isDesktop()) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center px-8 text-sm">
        {t("library.explorer.desktopOnly")}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* 通栏左对齐（参考图 1）：不设窄容器，大留白随窗口铺开 */}
      <div className="flex w-full flex-col gap-7 px-6 py-10 md:px-10 md:py-12 xl:px-14">
        {/* hero：两行大标题，「资料库」着主题色 */}
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("library.landing.heading")}{" "}
            <span className="text-primary">{t("library.view.title")}</span>
          </h1>
          <p className="text-2xl font-bold tracking-tight">
            {t("library.landing.subheading")}
          </p>
        </div>

        {/* 筛选行（参考图 1 的「全部工作区 ▾」） */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
              >
                {scopeLabel}
                <ChevronDownIcon className="size-3 opacity-60" />
              </button>
            }
          />
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={() => setScopeDir(null)}>
              {t("library.landing.filterAll")}
            </DropdownMenuItem>
            {workspaceOptions.map((option) => (
              <DropdownMenuItem
                key={option.dirName}
                onClick={() => setScopeDir(option.dirName)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {scan.truncated && (
          <p className="text-muted-foreground text-xs">
            {t("library.search.truncated", { count: 500 })}
          </p>
        )}

        {scan.loading && kbs.length === 0 ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {t("library.common.searching")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,400px))] gap-5">
            {/* 创建知识库（虚线卡，对齐参考图 1） */}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="text-muted-foreground hover:bg-muted/30 hover:text-foreground flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm transition-colors"
            >
              <span className="grid size-9 place-items-center rounded-lg border border-border">
                <PlusIcon className="size-4.5" />
              </span>
              {t("library.landing.createKb")}
            </button>

            {filtered.map((card) => {
              const kb = kbs.find((row) => row.id === card.id);
              return (
                <div key={card.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onOpenSpace(card)}
                    className="hover:border-border hover:shadow-sm flex min-h-28 w-full flex-col justify-between gap-3 rounded-xl border border-border/70 bg-background p-4 text-left transition-all"
                  >
                    <div className="flex min-w-0 items-center gap-2.5 pr-6">
                      <span className="bg-muted/60 grid size-9 shrink-0 place-items-center rounded-lg">
                        {kb?.scope === "user" ? (
                          <GlobeIcon className="text-muted-foreground size-4" />
                        ) : (
                          <FolderGit2Icon className="text-muted-foreground size-4" />
                        )}
                      </span>
                      <span className="truncate text-lg font-semibold">
                        {card.title}
                      </span>
                    </div>
                    <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <LibraryIcon className="size-3.5 shrink-0" />
                      {t("library.landing.itemCount", { count: card.count })}
                    </div>
                    <div className="text-muted-foreground flex items-center justify-between gap-2 text-2xs">
                      <span className="min-w-0 truncate" title={card.scopeHint}>
                        {card.scopeHint}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {card.modifiedAt
                          ? t("library.landing.updatedAt", {
                              date: formatDay(card.modifiedAt, getLocale()),
                            })
                          : ""}
                      </span>
                    </div>
                  </button>
                  {/* 悬浮「…」：卡片按钮的兄弟节点（嵌套 button 不合法） */}
                  {kb && (
                    <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title={t("library.landing.cardMenu.more")}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-32">
                          <DropdownMenuItem onClick={() => setRenaming(kb)}>
                            {t("library.landing.cardMenu.rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleting(kb)}
                          >
                            {t("library.landing.cardMenu.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!scan.loading && needle && filtered.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed p-10 text-sm">
            <SearchXIcon className="size-4" />
            {t("library.search.noMatch", { query: needle })}
          </div>
        )}

        {!scan.loading && !needle && kbs.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed p-10 text-sm">
            <LibraryIcon className="size-4" />
            {t("library.landing.empty")}
          </div>
        )}
      </div>

      <CreateKbDialog
        open={createOpen}
        root={root}
        workspaceOptions={workspaceOptions}
        onClose={() => setCreateOpen(false)}
        onCreated={onChanged}
      />
      <RenameKbDialog
        kb={renaming}
        root={root}
        onClose={() => setRenaming(null)}
        onRenamed={onChanged}
      />
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.landing.cardMenu.deleteTitle", {
                name: deleting?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("library.landing.cardMenu.deleteDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">
              {t("library.landing.cardMenu.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={deletingBusy}
              onClick={() => {
                const kb = deleting;
                if (!kb || !root || deletingBusy) return;
                setDeletingBusy(true);
                void deleteKnowledgeBase(root, kb)
                  .then(() => {
                    toast.success(t("library.landing.cardMenu.deleted"));
                    onChanged();
                    setDeleting(null);
                  })
                  .catch((err) => {
                    toast.error(
                      fsErrorText(err instanceof Error ? err.message : String(err)),
                    );
                  })
                  .finally(() => {
                    setDeletingBusy(false);
                  });
              }}
            >
              {t("library.landing.cardMenu.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

/** 创建知识库弹窗（对齐截图：名称 0/50 + 生效范围 + 选择工作区） */
const CreateKbDialog: FC<{
  open: boolean;
  root: string | null;
  workspaceOptions: { dirName: string; label: string; projectId: string }[];
  onClose: () => void;
  onCreated: () => void;
}> = ({ open, root, workspaceOptions, onClose, onCreated }) => {
  const t = useT();
  const currentDir = useProjectWorkspaceDir();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"user" | "workspace">("user");
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 打开时重置表单；scope=工作区 时预选当前工作区（有注册表匹配才预选）
  useEffect(() => {
    if (!open) return;
    setName("");
    setScope("user");
    setSelectedDir(null);
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || scope !== "workspace" || selectedDir) return;
    // 与 workspaceOptions/清单同一套净化规则（projectFolderFor），否则含
    // 非法字符的目录名预选失配
    const folder = projectFolderFor(currentDir);
    const base = folder.startsWith("项目/") ? folder.slice("项目/".length) : "";
    if (base && workspaceOptions.some((o) => o.dirName === base)) {
      setSelectedDir(base);
    }
  }, [open, scope, selectedDir, currentDir, workspaceOptions]);

  const valid =
    name.trim().length > 0 && (scope === "user" || Boolean(selectedDir));

  const create = () => {
    if (!root || !valid || busy) return;
    setBusy(true);
    const option = workspaceOptions.find((o) => o.dirName === selectedDir);
    void createKnowledgeBase(root, {
      name: name.trim(),
      scope,
      ...(scope === "workspace" && selectedDir
        ? { workspaceDir: selectedDir, workspaceId: option?.projectId }
        : {}),
    })
      .then(() => {
        toast.success(t("library.landing.kbCreated"));
        onCreated();
        onClose();
      })
      .catch((err) => {
        toast.error(
          fsErrorText(err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const selectedLabel = workspaceOptions.find(
    (o) => o.dirName === selectedDir,
  )?.label;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-xl gap-6 p-6">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {t("library.landing.createKb")}
          </DialogTitle>
          <DialogDescription>
            {t("library.landing.createDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {/* 名称 + 0/50 计数（对齐截图右上角） */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium">
                {t("library.landing.createDialog.nameLabel")}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {name.length}/{NAME_MAX}
              </span>
            </div>
            <Input
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
              placeholder={t("library.landing.createDialog.namePlaceholder")}
              className="h-10 rounded-lg"
              autoFocus
              spellCheck={false}
            />
          </div>

          {/* 生效范围：用户 / 工作区 */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {t("library.landing.createDialog.scopeLabel")}
            </span>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value as "user" | "workspace")}
              className="flex items-center gap-6"
            >
              <label
                className="flex cursor-pointer items-center gap-2 text-sm"
                onClick={() => setScope("user")}
              >
                <RadioGroupItem value="user" />
                {t("library.landing.createDialog.scopeUser")}
              </label>
              <label
                className="flex cursor-pointer items-center gap-2 text-sm"
                onClick={() => setScope("workspace")}
              >
                <RadioGroupItem value="workspace" />
                {t("library.landing.createDialog.scopeWorkspace")}
              </label>
            </RadioGroup>
          </div>

          {/* 选择工作区（scope=工作区 时出现，对齐截图） */}
          {scope === "workspace" && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {t("library.landing.createDialog.workspaceLabel")}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      className="h-10 w-full justify-between"
                    >
                      {selectedLabel ??
                        t("library.landing.createDialog.workspacePick")}
                      <ChevronDownIcon className="size-4 opacity-60" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="start" className="w-72">
                  {workspaceOptions.length === 0 ? (
                    <div className="text-muted-foreground px-2 py-3 text-xs">
                      {t("library.landing.createDialog.workspaceEmpty")}
                    </div>
                  ) : (
                    workspaceOptions.map((option) => (
                      <DropdownMenuItem
                        key={option.dirName}
                        onClick={() => setSelectedDir(option.dirName)}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-muted-foreground text-xs">
                {t("library.landing.createDialog.workspaceHint")}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("library.landing.createDialog.cancel")}
          </Button>
          <Button disabled={!root || !valid || busy} onClick={create}>
            {t("library.landing.createDialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** 重命名知识库：文件夹同目录改名 + 清单同步 */
const RenameKbDialog: FC<{
  kb: KnowledgeBase | null;
  root: string | null;
  onClose: () => void;
  onRenamed: () => void;
}> = ({ kb, root, onClose, onRenamed }) => {
  const t = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (kb) setName(kb.name);
    setBusy(false);
  }, [kb]);

  const save = () => {
    if (!kb || !root || !name.trim() || busy) return;
    setBusy(true);
    void renameKnowledgeBase(root, kb, name.trim())
      .then(() => {
        onRenamed();
        onClose();
      })
      .catch((err) => {
        toast.error(
          fsErrorText(err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog
      open={kb !== null}
      onOpenChange={(next) => (next ? null : onClose())}
    >
      <DialogContent className="sm:max-w-md gap-6 p-6">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {t("library.landing.cardMenu.renameTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("library.landing.cardMenu.renameDesc")}
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          className="h-10 rounded-lg"
          autoFocus
          spellCheck={false}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("library.landing.cardMenu.cancel")}
          </Button>
          <Button disabled={!root || !name.trim() || busy} onClick={save}>
            {t("library.landing.cardMenu.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
