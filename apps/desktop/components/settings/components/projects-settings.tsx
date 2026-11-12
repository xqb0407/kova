"use client";

/**
 * 设置 → 项目：全部项目（含已移除/已归档）的统一管理页。
 * 支持查看全部/在用/已移除/已归档、切换为当前工作空间、归档、恢复、移除、
 * 彻底删除。移除只隐藏侧栏卡片，项目实体与会话归属保留；彻底删除才删除
 * 项目实体与 folders，会话默认解绑保留（可勾选一并删除数据）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  ListChecksIcon,
  Loader2Icon,
  PencilIcon,
  ServerIcon,
  Trash2Icon,
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectBadge } from "@/components/ui/project-badge";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import { useT } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import {
  deleteProject,
  projectAppearanceOf,
  projectDisplayName,
  removeProject,
  saveProject,
  projectPrimaryPath,
  restoreProject,
  sameProjectPath,
  useProjectRegistry,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import {
  clearWorkspace,
  getWorkspace,
  setWorkspace,
  useWorkspace,
} from "@/lib/workspace/workspace-store";
import {
  piSessionIdForThread,
  piSessionPrefsMap,
  piSessionProjectIdMap,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import { clearLastThread } from "@/lib/pi/pi-last-thread";
import { invoke } from "@/desktop-bridge/core";
import {
  deleteRemoteProject,
  useRemoteProjects,
  type RemoteProject,
  type SshHost,
} from "@/lib/workspace/remote-projects";

type Filter = "all" | "active" | "removed" | "archived";

const FILTERS: Filter[] = ["all", "active", "removed", "archived"];

/** 远程工作区：独立于本地项目实体（kv remote.projects），但有完整的
 *  打开/编辑/删除闭环；已有会话保留自己的远端绑定，删除只影响后续新建。 */
const RemoteProjectsSection: FC<{ onOpen?: () => void }> = ({ onOpen }) => {
  const t = useT();
  const { projects } = useRemoteProjects();
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [editing, setEditing] = useState<RemoteProject | null>(null);
  const [pending, setPending] = useState<{
    open: boolean;
    project: RemoteProject;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadHosts = () => {
    void invoke("ssh_host_list", {})
      .then((list) => setHosts((list as SshHost[]) ?? []))
      .catch(() => setHosts([]));
  };

  useEffect(() => {
    loadHosts();
  }, []);

  if (projects.length === 0) return null;

  const hostName = (hostId: string) =>
    hosts.find((host) => host.id === hostId)?.name ??
    t("settings.projects.remoteHostUnavailable");

  const open = (project: RemoteProject) => {
    setWorkspace(project.remotePath);
    toast.add({
      title: t("settings.projects.opened", { name: project.name }),
      type: "success",
    });
    onOpen?.();
  };

  const remove = async (project: RemoteProject) => {
    if (busyId) return;
    setBusyId(project.id);
    try {
      await deleteRemoteProject(project.id);
      // 当前主界面正选着这个远端路径：删掉配置后它不再是可绑定的远程项目，
      // 清空选择，避免新会话误按本地路径处理。
      if (sameProjectPath(getWorkspace() ?? "", project.remotePath)) {
        clearWorkspace();
      }
      toast.add({
        title: t("settings.projects.remoteDeleted", { name: project.name }),
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: t("settings.projects.actionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">
          {t("settings.projects.remoteTitle")}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {projects.length}
        </span>
        <span className="text-muted-foreground text-xs">
          {t("settings.projects.remoteDesc")}
        </span>
      </div>
      <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
        {projects.map((project) => {
          const rowBusy = busyId === project.id;
          const host = hostName(project.hostId);
          return (
            <div
              key={project.id}
              className="hover:bg-background/60 flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <ServerIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="truncate text-sm font-medium">
                    {project.name}
                  </span>
                  <span className="text-muted-foreground shrink-0 rounded bg-muted px-1 text-2xs">
                    {t("settings.projects.remoteBadge")}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {host}
                  </span>
                </div>
                <div
                  className="text-muted-foreground truncate font-mono text-[13px] leading-5"
                  title={project.remotePath}
                >
                  {project.remotePath}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                  disabled={rowBusy}
                  onClick={() => open(project)}
                >
                  <FolderOpenIcon className="size-4" />
                  {t("settings.projects.open")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                  disabled={rowBusy}
                  onClick={() => setEditing(project)}
                >
                  <PencilIcon className="size-4" />
                  {t("settings.projects.remoteEdit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive h-8 gap-1.5 px-2 text-[13px] font-normal"
                  disabled={rowBusy}
                  onClick={() => setPending({ open: true, project })}
                >
                  <Trash2Icon className="size-4" />
                  {t("settings.projects.remoteDelete")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <WorkspaceCreateDialog
        open={editing !== null}
        remoteProject={editing}
        onClose={() => {
          setEditing(null);
          // 编辑弹窗里可能新增/停用了 SSH 主机，回来重读一次
          loadHosts();
        }}
      />

      <AlertDialog
        open={pending?.open === true}
        onOpenChange={(open) => {
          setPending((prev) => (prev ? { ...prev, open } : prev));
        }}
      >
        {pending ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.projects.remoteDeleteTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.projects.remoteDeleteConfirm", {
                  name: pending.project.name,
                  path: pending.project.remotePath,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="default">
                {t("settings.archive.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                size="default"
                onClick={() => {
                  const action = pending;
                  setPending({ ...action, open: false });
                  void remove(action.project);
                }}
              >
                {t("settings.projects.remoteDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </section>
  );
};

export const ProjectsSettings: FC<{ onOpen?: () => void }> = ({ onOpen }) => {
  const t = useT();
  const aui = useAui();
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const workspace = useWorkspace();
  const projects = useProjectRegistry();
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 批量模式（参考归档页）：勾选态 + 进度；默认不显示勾选框 */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  /** 确认弹窗：归档 / 移除（应用内 AlertDialog，不用系统原生框）。
   *  open 与内容分开存：关闭动画期间要保留标题/描述/按钮文案，否则会闪一帧
   *  “空壳 + 默认按钮”。 */
  const [pending, setPending] = useState<{
    open: boolean;
    kind: "archive" | "remove" | "purge";
    project: ProjectRecord;
  } | null>(null);
  /** 移除确认里的「同时删除数据」勾选（参考通用删除确认：默认不删） */
  const [deleteDataChecked, setDeleteDataChecked] = useState(false);
  // 会话镜像版本：项目成员计数随清单刷新重算
  const summariesVersion = useSessionPrefsVersion();
  const sessionCounts = useMemo(() => {
    void summariesVersion;
    const counts = new Map<string, number>();
    for (const session of piSessionPrefsMap.values()) {
      if (!session.projectId) continue;
      counts.set(session.projectId, (counts.get(session.projectId) ?? 0) + 1);
    }
    return counts;
  }, [summariesVersion]);
  /** 批量确认：与单条确认分开，避免把「一批项目」塞进单条弹窗状态 */
  const [batchConfirm, setBatchConfirm] = useState<"archive" | "purge" | null>(
    null,
  );

  const rows = useMemo(() => {
    const rank = (project: ProjectRecord) =>
      project.archived ? 2 : project.hiddenFromSidebar ? 1 : 0;
    const list = projects
      .filter((project) =>
        filter === "all"
          ? true
          : filter === "active"
            ? !project.archived && !project.hiddenFromSidebar
            : filter === "removed"
              ? !project.archived && project.hiddenFromSidebar
              : project.archived,
      )
      .slice()
      // 在用优先，其次已移除，归档沉底；同状态按最近更新
      .sort(
        (a, b) =>
          rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt),
      );
    return list;
  }, [projects, filter]);

  /** 项目名下会话数（移除确认里说明「会话仍保留」用；注册表会话镜像） */
  const memberCount = (project: ProjectRecord): number => {
    void project;
    return sessionCounts.get(project.id) ?? 0;
  };

  /** 批量操作只作用于当前筛选下可见的行（与归档页「勾选可见集」一致） */
  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const allSelected =
    visibleIds.length > 0 &&
    visibleIds.every((id) => selected.has(id));
  const busy = busyId !== null || progress !== null;
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(
      allSelected ? new Set() : new Set(visibleIds),
    );

  /** 批量执行：顺序调 deleteProject，失败项保留选中便于重试 */
  const runBatch = async (kind: "archive" | "purge") => {
    const targets = selectedRows;
    if (targets.length === 0 || busy) return;
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    const failed = new Set<string>();
    for (let index = 0; index < targets.length; index += 1) {
      const project = targets[index]!;
      try {
        await deleteProject(
          project.id,
          kind === "purge" ? { permanent: true } : {},
        );
        if (kind === "purge") resetAfterPurge(project, false);
        ok += 1;
      } catch {
        failed.add(project.id);
      }
      setProgress({ done: index + 1, total: targets.length });
    }
    setProgress(null);
    if (failed.size === 0) {
      toast.success(
        kind === "purge"
          ? t("settings.projects.batchDeleted", { count: ok })
          : t("settings.projects.batchArchived", { count: ok }),
      );
      exitSelectMode();
    } else {
      setSelected(failed);
      toast.error(
        t("settings.projects.batchPartial", {
          ok,
          total: targets.length,
          failed: failed.size,
        }),
      );
    }
  };

  const open = (project: ProjectRecord) => {
    const primary = projectPrimaryPath(project);
    if (!primary) return;
    setWorkspace(primary, "user", project.id);
    toast.add({
      title: t("settings.projects.opened", {
        name: projectDisplayName(project),
      }),
      type: "success",
    });
    // 设置页内“打开”：切回聊天并在该项目下开新对话
    onOpen?.();
  };

  const archive = async (project: ProjectRecord) => {
    if (busyId) return;
    setBusyId(project.id);
    try {
      await deleteProject(project.id);
      toast.add({
        title: t("settings.projects.archivedToast", {
          name: projectDisplayName(project),
        }),
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: t("settings.projects.actionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  /** 恢复侧栏显示（移除的反向操作；移除本身走带确认的 remove） */
  const showInSidebar = async (project: ProjectRecord) => {
    if (busyId) return;
    setBusyId(project.id);
    try {
      await saveProject({ id: project.id, hiddenFromSidebar: false });
      toast.add({
        title: t("settings.projects.shownToast", {
          name: projectDisplayName(project),
        }),
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: t("settings.projects.actionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  /** 移除（参考通用移除确认）：默认只隐藏，勾选后连带删除会话数据 */
  const remove = async (project: ProjectRecord, deleteData?: boolean) => {
    if (busyId) return;
    const deletesCurrentThread = Boolean(
      deleteData && currentThreadProjectId() === project.id,
    );
    setBusyId(project.id);
    try {
      await removeProject(project.id, { deleteData });
      // 勾选删数据时当前会话已被删除：切回新对话并清掉项目工作区，
      // 避免停留在已不存在的会话或继续在隐藏项目里新建会话。
      if (deletesCurrentThread) resetAfterPurge(project, true);
      toast.add({
        title: t("settings.projects.removedToast", {
          name: projectDisplayName(project),
        }),
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: t("settings.projects.actionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (project: ProjectRecord) => {
    if (busyId) return;
    setBusyId(project.id);
    try {
      const restored = await restoreProject(project.id);
      toast.add({
        title: t("settings.projects.restored", {
          // 名称可能因归档期间被复用而自动加了序号，用后端返回值
          name: projectDisplayName(restored),
        }),
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: t("settings.projects.actionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  /** 删除请求发出前先快照“当前会话是否属于该项目”：sidecar 删除会话时会先
   *  广播 sessions_changed，等 delete_project 应答回来时映射可能已经被清掉，
   *  再查就会漏掉这次跳转。 */
  const currentThreadProjectId = (): string | undefined => {
    const sessionId = mainThreadId
      ? piSessionIdForThread(mainThreadId)
      : undefined;
    return sessionId ? piSessionProjectIdMap.get(sessionId) : undefined;
  };

  /** 彻底删除后的收尾：当前工作区属于该项目就清空；本次连数据删除了当前
   *  会话时切回新对话，避免界面继续显示已删除的会话。 */
  const resetAfterPurge = (
    project: ProjectRecord,
    currentThreadDeleted: boolean,
  ) => {
    if (
      workspace &&
      project.folders.some((folder) => sameProjectPath(folder.path, workspace))
    ) {
      clearWorkspace();
    }
    if (!currentThreadDeleted) return;
    clearLastThread();
    void aui.threads.switchToNewThread();
  };

  const purge = async (project: ProjectRecord, deleteData?: boolean) => {
    if (busyId) return;
    const deletesCurrentThread = Boolean(
      deleteData && currentThreadProjectId() === project.id,
    );
    setBusyId(project.id);
    try {
      await deleteProject(project.id, {
        permanent: true,
        ...(deleteData ? { deleteData: true } : {}),
      });
      resetAfterPurge(project, deletesCurrentThread);
      toast.add({
        title: t("settings.projects.deleted", {
          name: projectDisplayName(project),
        }),
        type: "success",
      });
    } catch (err) {
      toast.add({
        title: t("settings.projects.actionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.projects.title")}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            {t("settings.projects.desc")}
          </p>
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              value={filter}
              onValueChange={(value) => setFilter(value as Filter)}
            >
              <TabsList className="h-auto rounded-full bg-muted/50 p-[3px]">
                {FILTERS.map((key) => (
                  <TabsTrigger
                    key={key}
                    value={key}
                    className="rounded-full px-3 py-1 text-sm"
                  >
                    {t(`settings.projects.filter_${key}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <span className="text-muted-foreground ms-auto text-xs tabular-nums">
              {rows.length}
            </span>
            {rows.length > 0 ? (
              selectMode ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-7 px-2 text-[13px] leading-5"
                    disabled={busy}
                    onClick={toggleAll}
                  >
                    {allSelected
                      ? t("settings.projects.deselectAll")
                      : t("settings.projects.selectAll")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-7 px-2 text-[13px] leading-5"
                    disabled={busy}
                    onClick={exitSelectMode}
                  >
                    {t("settings.projects.exitBatch")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-7 gap-1.5 px-2 text-[13px] leading-5"
                    disabled={busy || selectedRows.length === 0}
                    onClick={() => setBatchConfirm("archive")}
                  >
                    <ArchiveIcon className="size-3.5" />
                    {t("settings.projects.batchArchiveCount", {
                      count: selectedRows.length,
                    })}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5 px-2 text-[13px] leading-5"
                    disabled={busy || selectedRows.length === 0}
                    onClick={() => setBatchConfirm("purge")}
                  >
                    {progress ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    {progress
                      ? t("settings.projects.batchProgress", {
                          done: progress.done,
                          total: progress.total,
                        })
                      : t("settings.projects.batchDeleteCount", {
                          count: selectedRows.length,
                        })}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-7 gap-1.5 px-2 text-[13px] leading-5"
                  onClick={() => setSelectMode(true)}
                >
                  <ListChecksIcon className="size-3.5" />
                  {t("settings.projects.batchMode")}
                </Button>
              )
            ) : null}
          </div>

          {rows.length === 0 ? (
            <div className="text-muted-foreground bg-muted/50 rounded-2xl px-3 py-8 text-center text-sm">
              {t("settings.projects.empty")}
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {rows.map((project) => {
                const primary = projectPrimaryPath(project);
                const rowBusy = busyId === project.id;
                const isSelected = selected.has(project.id);
                return (
                  <div
                    key={project.id}
                    className="hover:bg-background/60 flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2 transition-colors"
                    onClick={
                      selectMode
                        ? () => {
                            if (!busy) toggleOne(project.id);
                          }
                        : undefined
                    }
                  >
                    {selectMode ? (
                      <span
                        className="flex shrink-0 items-center"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={busy}
                          onCheckedChange={() => toggleOne(project.id)}
                          aria-label={t("settings.projects.selectAria", {
                            name: projectDisplayName(project),
                          })}
                        />
                      </span>
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {projectDisplayName(project)}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {project.archived
                            ? t("settings.projects.statusArchived")
                            : project.hiddenFromSidebar
                              ? t("settings.projects.statusHidden")
                              : t("settings.projects.statusActive")}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          {t("settings.projects.folderCount", {
                            count: project.folders.length,
                          })}
                        </span>
                      </div>
                      <div
                        className="text-muted-foreground truncate text-[13px] leading-5"
                        title={primary}
                      >
                        {primary}
                      </div>
                    </div>
                    <div className={selectMode ? "hidden" : "flex shrink-0 items-center gap-1"}>
                      {!project.archived && project.hiddenFromSidebar ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                          disabled={busy || selectMode}
                          onClick={() => void showInSidebar(project)}
                          title={t("settings.projects.showInSidebarHint")}
                        >
                          <EyeIcon className="size-4" />
                          {t("settings.projects.showInSidebar")}
                        </Button>
                      ) : null}
                      {!project.archived ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                            onClick={() => open(project)}
                            disabled={busy || selectMode}
                            title={t("settings.projects.openHint")}
                          >
                            <FolderOpenIcon className="size-4" />
                            {t("settings.projects.open")}
                          </Button>
                          {!project.hiddenFromSidebar ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                              disabled={busy || selectMode}
                              onClick={() => {
                                setDeleteDataChecked(false);
                                setPending({
                                  open: true,
                                  kind: "remove",
                                  project,
                                });
                              }}
                              title={t("settings.projects.removeHint")}
                            >
                              <EyeOffIcon className="size-4" />
                              {t("settings.projects.remove")}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                            onClick={() =>
                              setPending({
                                open: true,
                                kind: "archive",
                                project,
                              })
                            }
                            disabled={busy || selectMode}
                            title={t("settings.projects.archive")}
                          >
                            {rowBusy ? (
                              <Loader2Icon className="size-4 animate-spin" />
                            ) : (
                              <ArchiveIcon className="size-4" />
                            )}
                            {t("settings.projects.archive")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 gap-1.5 px-2 text-[13px] font-normal"
                          onClick={() => void restore(project)}
                          disabled={busy || selectMode}
                          title={t("settings.projects.restore")}
                        >
                          {rowBusy ? (
                            <Loader2Icon className="size-4 animate-spin" />
                          ) : (
                            <ArchiveRestoreIcon className="size-4" />
                          )}
                          {t("settings.projects.restore")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive h-8 gap-1.5 px-2 text-[13px] font-normal"
                        onClick={() => {
                          setDeleteDataChecked(false);
                          setPending({ open: true, kind: "purge", project });
                        }}
                        disabled={busy || selectMode}
                        title={t("settings.projects.delete")}
                      >
                        <Trash2Icon className="size-4" />
                        {t("settings.projects.delete")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <RemoteProjectsSection onOpen={onOpen} />
      </div>

      <AlertDialog
        open={pending?.open === true}
        // 勾选「同时删除数据」：与会话数量一起放在弹窗里（参考通用删除确认）
        onOpenChange={(open) => {
          // 关闭：只把 open 置 false，内容保留到卸载——关闭动画期间标题/描述
          // 和按钮文案不会塌成空壳（Base UI 卸载后才真正移除 Popup）
          setPending((prev) => (prev ? { ...prev, open } : prev));
        }}
      >
        {pending ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pending.kind === "remove"
                  ? t("settings.projects.removeTitle", { count: 1 })
                  : pending.kind === "purge"
                    ? t("settings.projects.deleteTitle", { count: 1 })
                    : t("settings.projects.archive")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pending.kind === "remove"
                  ? t("settings.projects.removeConfirm")
                  : pending.kind === "purge"
                    ? t("settings.projects.deleteConfirm")
                    : t("settings.projects.archiveConfirm", {
                        name: projectDisplayName(pending.project),
                      })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pending.kind !== "archive" ? (
              // 长项目名/长路径：外层必须 min-w-0（grid 子项默认 min-width:auto，
              // 超长路径会把 truncate 顶失效、撑破弹窗），行内再逐级 truncate。
              <div className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/50 px-3 py-2.5">
                <span className="bg-background text-muted-foreground relative grid size-8 shrink-0 place-items-center rounded-lg">
                  <FolderOpenIcon className="size-4" />
                  <ProjectBadge
                    appearance={projectAppearanceOf(pending.project)}
                    className="absolute inset-0 size-8 rounded-lg"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {projectDisplayName(pending.project)}
                  </div>
                  <div
                    className="text-muted-foreground truncate text-xs leading-5"
                    title={projectPrimaryPath(pending.project)}
                  >
                    {projectPrimaryPath(pending.project)}
                  </div>
                </div>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {t("settings.projects.cardSessions", {
                    count: memberCount(pending.project),
                  })}
                </span>
              </div>
            ) : null}
            {pending.kind !== "archive" ? (
              <div className="flex min-w-0 items-start gap-3 rounded-xl bg-muted/50 px-3 py-2.5">
                <Checkbox
                  checked={deleteDataChecked}
                  onCheckedChange={(checked) =>
                    setDeleteDataChecked(checked === true)
                  }
                  aria-label={t("settings.projects.deleteDataAria")}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t("settings.projects.deleteDataTitle")}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-[13px] leading-5">
                    {t("settings.projects.deleteDataDesc")}
                  </div>
                </div>
              </div>
            ) : null}
            {pending.kind === "remove" ? (
              <p className="text-muted-foreground px-1 text-[13px] leading-5">
                {t("settings.projects.removeRecoverHint")}
              </p>
            ) : pending.kind === "purge" ? (
              <p className="text-muted-foreground px-1 text-[13px] leading-5">
                {t("settings.projects.deleteRecoverHint")}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel size="default">
                {t("settings.archive.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={
                  pending.kind === "purge" || pending.kind === "remove"
                    ? "destructive"
                    : "default"
                }
                size="default"
                onClick={() => {
                  const action = pending;
                  setPending({ ...action, open: false });
                  if (action.kind === "purge")
                    void purge(action.project, deleteDataChecked);
                  else if (action.kind === "remove")
                    void remove(action.project, deleteDataChecked);
                  else void archive(action.project);
                }}
              >
                {pending.kind === "remove"
                  ? t("settings.projects.removeAction", { count: 1 })
                  : pending.kind === "purge"
                    ? t("settings.projects.deleteAction")
                    : t("settings.projects.archive")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      {/* 批量确认：与单条共用 AlertDialog 视觉，但内容常驻（关闭动画不塌陷） */}
      <AlertDialog
        open={batchConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setBatchConfirm(null);
        }}
      >
        {batchConfirm ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {batchConfirm === "purge"
                  ? t("settings.projects.batchDeleteTitle")
                  : t("settings.projects.batchArchiveTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {batchConfirm === "purge"
                  ? t("settings.projects.batchDeleteConfirm", {
                      count: selectedRows.length,
                    })
                  : t("settings.projects.batchArchiveConfirm", {
                      count: selectedRows.length,
                    })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="default">
                {t("settings.archive.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={batchConfirm === "purge" ? "destructive" : "default"}
                size="default"
                onClick={() => {
                  const kind = batchConfirm;
                  setBatchConfirm(null);
                  if (kind) void runBatch(kind);
                }}
              >
                {batchConfirm === "purge"
                  ? t("settings.projects.batchDelete")
                  : t("settings.projects.batchArchive")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
};
