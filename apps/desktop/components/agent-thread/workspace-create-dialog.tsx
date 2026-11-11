"use client";

/**
 * 新建工作区对话框：把「选一个系统目录」升级成一张完整的工作区创建表单。
 *
 * - 「文件所在位置」可选本机或 SSH 远程主机：本机走项目实体（多文件夹、
 *   名称、图标/颜色）；远程走 remote.projects（名称 + 主机 + 远端路径），
 *   保存后把 workspace 设为远端路径，会话按路径绑定远程目标；
 * - 本机源文件夹可反复点「添加文件夹」（系统选择器一次选一个），第一个是
 *   主目录，其余走项目虚拟目录（add_project_dir）成为同一项目的附加根；
 * - 名称存项目显示名（localStorage），图标/颜色复用项目外观；
 * - 只覆盖用户真正改过的外观字段，避免只加目录时把已有头像/图片清掉。
 *
 * 入口：composer 工作区胶囊「新建工作区」、侧栏「选择工作目录」。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import {
  ArchiveIcon,
  EyeOffIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  MonitorIcon,
  PlusIcon,
  ServerIcon,
  XIcon,
} from "lucide-react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { SshConnectionDialog } from "@/components/settings/components/ssh-connection-dialog";
import { RemotePathPicker } from "@/components/agent-thread/remote-path-picker";
import { ProjectAppearancePicker } from "@/components/ui/project-appearance-picker";
import { cn } from "@/lib/utils";
import { isDesktop } from "@/lib/desktop-env";
import { useT } from "@/lib/i18n";
import { open as openDialog } from "@/desktop-bridge/plugin-dialog";
import {
  projectAppearanceFor,
  setProjectAppearance,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";
import {
  PROJECT_NAME_MAX_CHARS,
  projectDisplayNameFor,
  setProjectDisplayName,
} from "@/lib/projects/project-display-name";
import {
  fetchProjects,
  projectAppearanceOf,
  projectDisplayName,
  projectHasPath,
  projectPrimaryPath,
  sameProjectPath,
  saveProject,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import { getWorkspace, setWorkspace } from "@/lib/workspace/workspace-store";
import {
  trustProjectFolders,
  untrustedProjectFolders,
} from "@/lib/projects/project-trust";
import {
  saveRemoteProject,
  type RemoteProject,
  type SshHost,
} from "@/lib/workspace/remote-projects";
import {
  WORKSPACE_MAX_FOLDERS,
  appendWorkspaceFolder,
  hasWorkspaceFolder,
  normalizeFolderPath,
  splitWorkspaceFolders,
  workspaceFolderName,
} from "@/lib/workspace/workspace-creation";

export const WorkspaceCreateDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** 传入项目 = 编辑现有本地项目（复用表单，预填名称/目录/外观） */
  project?: ProjectRecord | null;
  /** 传入远程项目 = 编辑远程工作区（名称/主机/远端路径） */
  remoteProject?: RemoteProject | null;
  /** 编辑模式下底部操作 */
  onArchiveProject?: () => void;
  onRemoveProject?: () => void;
  /** 新建成功回调（已写入 workspace，供内嵌调用方同步自己的选择态） */
  onCreated?: (project: ProjectRecord) => void;
  /** 主目录被占用时点「在「X」新建对话」：由调用方切到该工作空间开新对话 */
  onOpenExistingProject?: (project: ProjectRecord) => void;
  /** 远程工作区保存成功 */
  onRemoteUpdated?: (project: RemoteProject) => void;
  /** 从另一个 Dialog 内打开时强制显示遮罩（Base UI 默认跳过嵌套 Backdrop） */
  forceOverlay?: boolean;
  /** 创建后是否切换主界面工作区；设置页只把新项目当作查看范围时传 false */
  selectAfterCreate?: boolean;
}> = ({
  open,
  onClose,
  project,
  remoteProject,
  onArchiveProject,
  onRemoveProject,
  onCreated,
  onOpenExistingProject,
  onRemoteUpdated,
  forceOverlay,
  selectAfterCreate = true,
}) => {
  const t = useT();
  const desktop = isDesktop();
  const editing = Boolean(project);
  const editingRemote = Boolean(remoteProject);
  const [folders, setFolders] = useState<string[]>([]);
  const [name, setName] = useState("");
  /** 外观草稿：主目录已有 logo/颜色时先回填，用户改哪项由共享选择器负责 */
  const [appearance, setAppearance] = useState<ProjectAppearance | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 主目录已属于某个项目：提示共享 + DB 名称/外观兜底回填 */
  const [existingProject, setExistingProject] = useState<ProjectRecord | null>(
    null,
  );
  /** 主目录被另一个项目占作主目录：禁止创建（同一主目录只能有一个工作空间） */
  const [mainConflict, setMainConflict] = useState<ProjectRecord | null>(null);
  /** 待信任的文件夹列表：非空时弹「信任此文件夹」确认 */
  const [trustPending, setTrustPending] = useState<string[] | null>(null);
  /** 未归档项目的显示名（小写）：提交前做重名提醒，后端仍会兜底拒绝 */
  const [takenNames, setTakenNames] = useState<Set<string>>(() => new Set());
  /** 主目录变化时用已有项目身份回填一次；连续添加后续目录不重置草稿 */
  const lastMainRef = useRef<string | null>(null);
  /** 文件所在位置：local = 此电脑，其余值为 SSH 主机 id（远程项目）。 */
  const [location, setLocation] = useState<"local" | string>("local");
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [connDialogOpen, setConnDialogOpen] = useState(false);
  const [remotePath, setRemotePath] = useState("");
  // 编辑远程项目时位置固定为远程（只允许换主机），避免首帧闪成本地表单
  const remoteMode = editingRemote || location !== "local";
  const enabledHosts = useMemo(
    () => hosts.filter((host) => host.enabled),
    [hosts],
  );
  const remoteHost = remoteMode
    ? enabledHosts.find((host) => host.id === location)
    : undefined;
  const locationItems = useMemo(
    () => [
      ...(editingRemote
        ? []
        : [{ value: "local", label: t("chat.workspaceDialog.locationLocal") }]),
      ...enabledHosts.map((host) => ({ value: host.id, label: host.name })),
      { value: "__add__", label: t("chat.workspaceDialog.addRemoteHost") },
    ],
    [editingRemote, enabledHosts, t],
  );

  const loadHosts = async () => {
    try {
      setHosts(((await invoke("ssh_host_list", {})) as SshHost[]) ?? []);
    } catch {
      setHosts([]);
    }
  };

  const main = folders[0] ?? null;
  // 最终显示名：输入框优先；留空回落主文件夹名。两者都不能与已有项目重复。
  const fallbackName = main
    ? (main.split(/[\\/]/u).filter(Boolean).at(-1) ?? "")
    : "";
  const remoteFallbackName =
    remotePath.split("/").filter(Boolean).at(-1) ?? "";
  const effectiveName =
    name.trim() || (remoteMode ? remoteFallbackName : fallbackName);
  const nameExists =
    !remoteMode &&
    Boolean(effectiveName) &&
    takenNames.has(effectiveName.toLocaleLowerCase());

  // 编辑模式：打开时把项目现值灌进表单（目录顺序、名称、外观）
  useEffect(() => {
    if (!open || !project) return;
    const primary = project.folders.find((f) => f.isPrimary)?.path
      ?? project.folders[0]?.path
      ?? "";
    const ordered = [
      primary,
      ...project.folders
        .map((f) => f.path)
        .filter((path) => path !== primary),
    ].filter(Boolean);
    setFolders(ordered);
    // 迁移出来的项目 display_name 为 NULL（名称由主文件夹名回落展示）；
    // 编辑时也要把回落名预填进输入框，否则看起来像“项目名是空的”。
    setName(project.displayName?.trim() || projectDisplayName(project));
    const appearance = projectAppearanceOf(project)
      ?? projectAppearanceFor(primary);
    setAppearance(appearance);
    setError(null);
    setExistingProject(null);
    setMainConflict(null);
    setTrustPending(null);
    setLocation("local");
    lastMainRef.current = primary;
  }, [open, project]);

  // 远程编辑：预填名称/主机/远端路径；位置下拉保持可见，允许换主机
  useEffect(() => {
    if (!open || !remoteProject) return;
    setFolders([]);
    setName(remoteProject.name);
    setAppearance(null);
    setLocation(remoteProject.hostId);
    setRemotePath(remoteProject.remotePath);
    setError(null);
    setExistingProject(null);
    setMainConflict(null);
    setTrustPending(null);
    lastMainRef.current = null;
  }, [open, remoteProject]);

  // 关闭时清空，下次打开从干净草稿开始（不在 open=true 时清，
  // 否则回填 effect 会拿上一轮的 folders 快照把旧名字写回来）
  useEffect(() => {
    if (open) return;
    setFolders([]);
    setName("");
    setAppearance(null);
    setPicking(false);
    setBusy(false);
    setError(null);
    setExistingProject(null);
    setMainConflict(null);
    setTrustPending(null);
    setTakenNames(new Set());
    lastMainRef.current = null;
    setLocation("local");
    setRemotePath("");
    setConnDialogOpen(false);
  }, [open]);

  // 打开对话框时拉 SSH 主机；编辑本地工作区时不需要位置切换
  useEffect(() => {
    if (!open || editing) return;
    let alive = true;
    void invoke("ssh_host_list", {})
      .then((list) => {
        if (alive) setHosts((list as SshHost[]) ?? []);
      })
      .catch(() => {
        if (alive) setHosts([]);
      });
    return () => {
      alive = false;
    };
  }, [open, editing]);

  // 主目录换了（首次添加/移除首个）→ 回填该目录已有的显示名与外观。
  // 优先 localStorage 同步缓存；缓存缺失时用项目实体的 DB 字段兜底，
  // 避免“清过缓存/换端后打开对话框把已有名称图标清空”。
  useEffect(() => {
    if (!open || editing || !main || lastMainRef.current === main) return;
    lastMainRef.current = main;
    // 名称回填：主目录本名直接填进输入框（可改），不必每次手输；
    // localStorage 里有自定义名则优先用它。
    const localName =
      projectDisplayNameFor(main) ?? workspaceFolderName(main) ?? "";
    const localAppearance = projectAppearanceFor(main) ?? null;
    setName(localName);
    setAppearance(localAppearance);
    setExistingProject(null);
    setMainConflict(null);
    let alive = true;
    void fetchProjects(true)
      .then((projects) => {
        if (!alive) return;
        // 含归档/隐藏项目：它们同样占着主目录/目录，预检要能看到
        const matches = projects.filter((project) =>
          projectHasPath(project, main),
        );
        // 主目录冲突要扫全部包含方：main 可能同时是 P1 的附加目录和 P2 的
        // 主目录，只看第一个命中会漏掉 P2 的冲突。
        const conflict = matches.find((project) =>
          sameProjectPath(projectPrimaryPath(project), main),
        );
        // 显示名唯一（留空时用主文件夹 basename）。这里只收集已占用名称，
        // 由表单给出“已存在”提醒；不自动改名，避免用户以为重名创建成功了。
        const taken = new Set(
          projects
            .filter((project) => !project.archived)
            .map((project) =>
              projectDisplayName(project).trim().toLocaleLowerCase(),
            ),
        );
        setTakenNames(taken);
        const match = conflict ?? matches[0];
        if (!match) return;
        setExistingProject(match);
        // 主目录被别的项目占作主目录：禁止创建（同一主目录只能有一个工作
        // 空间）。main 是别人的附加目录时只是共享上下文，允许继续。
        if (conflict) {
          setMainConflict(conflict);
          return;
        }
        // 主目录属于别的项目（作为其附加目录）：允许共享创建，但自动回填的
        // 名称若与已有显示名撞唯一校验，才清掉让用户改一个（用户已手输则保留）。
        // 不能无条件清空——否则“主文件夹名预填”在这类目录上永远不生效。
        setName((prev) =>
          prev === localName && taken.has(localName.toLocaleLowerCase())
            ? ""
            : prev,
        );
        if (!localAppearance) {
          const dbAppearance = projectAppearanceOf(match);
          if (dbAppearance) {
            setAppearance(dbAppearance);
          }
        }
      })
      .catch(() => {
        /* 项目列表不可用：只按 localStorage 回填 */
      });
    return () => {
      alive = false;
    };
  }, [open, main, editing]);

  const atLimit = folders.length >= WORKSPACE_MAX_FOLDERS;

  const addFolder = async () => {
    if (!desktop || picking || busy || atLimit) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("chat.workspaceDialog.pickerTitle"),
      });
      if (typeof picked !== "string") return;
      const normalized = normalizeFolderPath(picked);
      if (!normalized) return;
      if (hasWorkspaceFolder(folders, normalized)) {
        toast.info(t("chat.workspaceDialog.duplicate"));
        return;
      }
      setFolders((prev) => appendWorkspaceFolder(prev, normalized));
    } catch {
      setError(t("chat.workspaceDialog.desktopOnly"));
    } finally {
      setPicking(false);
    }
  };

  const removeFolder = (path: string) => {
    setError(null);
    setFolders((prev) =>
      prev.filter(
        (folder) => normalizeFolderPath(folder) !== normalizeFolderPath(path),
      ),
    );
  };

  const submit = async () => {
    if (!desktop || busy) return;

    if (remoteMode) {
      const nextPath = remotePath.trim();
      if (!remoteHost) {
        setError(t("chat.workspaceDialog.remoteHostUnavailable"));
        return;
      }
      if (!nextPath.startsWith("/")) {
        setError(t("chat.workspaceDialog.remotePathRequired"));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // 远端路径必须存在：保存前校验一次（避免会话里才炸）；
        // 存在但不可写仍允许创建，agent 写文件时会自然报权限错误
        const check = (await invoke("ssh_host_check_dir", {
          hostId: remoteHost.id,
          path: nextPath,
        })) as { exists: boolean; writable?: boolean; message: string };
        if (!check.exists) {
          setError(
            t("remote.project.remoteDirUnavailable", {
              message: check.message,
            }),
          );
          return;
        }
        const saved = await saveRemoteProject({
          ...(remoteProject ? { id: remoteProject.id } : {}),
          name: effectiveName,
          hostId: remoteHost.id,
          remotePath: nextPath,
        });
        if (remoteProject) {
          // 正在使用这个远程工作区时，路径/主机变更后同步主界面选择；
          // 否则只更新配置，不动当前会话。
          if (
            sameProjectPath(getWorkspace() ?? "", remoteProject.remotePath)
          ) {
            setWorkspace(saved.remotePath);
          }
          onRemoteUpdated?.(saved);
          toast.success(
            t("chat.workspaceDialog.remoteUpdated", { name: saved.name }),
          );
        } else {
          setWorkspace(saved.remotePath);
          toast.success(
            t("chat.workspaceDialog.remoteCreated", { name: saved.name }),
          );
        }
        if (check.writable === false) {
          toast.warning(
            t("remote.project.pathWarning", {
              message: check.message,
              path: saved.remotePath,
            }),
          );
        }
        onClose();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remoteName = /^remote-name-exists:\s*(.*)$/u.exec(message)?.[1];
        const remotePath = /^remote-path-exists:\s*(.*)$/u.exec(message)?.[1];
        setError(
          remoteName
            ? t("chat.workspaceDialog.remoteNameExists", { name: remoteName })
            : remotePath
              ? t("chat.workspaceDialog.remotePathExists", {
                  name: remotePath,
                })
              : t("chat.workspaceDialog.createFailed", { error: message }),
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    const { main: nextMain, additional } = splitWorkspaceFolders(folders);
    if (!nextMain) {
      setError(t("chat.workspaceDialog.needFolder"));
      return;
    }
    if (nameExists) {
      setError(
        t("chat.workspaceDialog.nameExists", { name: effectiveName }),
      );
      return;
    }
    if (mainConflict) {
      // 后端也会兜底拒绝；这里提前给出可操作的提示（快捷开新对话）
      setError(
        t("chat.workspaceDialog.mainInUse", {
          name: projectDisplayName(mainConflict),
        }),
      );
      return;
    }
    // 新文件夹交给 agent 前确认「信任此文件夹」；已有项目目录/已信任目录
    // 不重复打扰（编辑时只对本次新增的目录弹）。
    const newFolders = [nextMain, ...additional].filter(
      (folder) =>
        !(project?.folders ?? []).some((existing) =>
          sameProjectPath(existing.path, folder),
        ),
    );
    if (untrustedProjectFolders(newFolders).length > 0) {
      setTrustPending([nextMain, ...additional]);
      return;
    }
    await saveLocal();
  };

  /** 本地工作区落库（新建/编辑共用；信任确认后复用同一段） */
  const saveLocal = async () => {
    const { main: nextMain, additional } = splitWorkspaceFolders(folders);
    // busy 守卫：信任确认按钮/回车连点会重复进这里，避免并发建两个项目
    if (!nextMain || busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const appearanceJson = appearance ? JSON.stringify(appearance) : null;
      const saved = await saveProject({
        ...(project ? { id: project.id } : {}),
        name: trimmedName || null,
        folders: [nextMain, ...additional],
        primaryPath: nextMain,
        appearanceJson,
        showWhenEmpty: project?.showWhenEmpty ?? true,
      });
      // 名称写 localStorage：侧栏/胶囊标签即时生效（后端做持久化事实源）
      setProjectDisplayName(
        nextMain,
        trimmedName && trimmedName !== workspaceFolderName(nextMain)
          ? trimmedName
          : null,
      );
      // 外观写 localStorage：图标/颜色即时生效
      if (appearance) {
        setProjectAppearance(nextMain, appearance);
      }
      if (!project) {
        // 新建：默认切换主界面工作区（cwd=primary folder）并带上项目 id；
        // 设置页的范围选择只需要拿到新项目，不应顺带改主界面工作区。
        if (selectAfterCreate) setWorkspace(nextMain, "user", saved.id);
        onCreated?.(saved);
      }

      const label = trimmedName || workspaceFolderName(nextMain);
      if (project) {
        toast.success(t("chat.workspaceDialog.updated", { name: label }));
      } else if (additional.length > 0) {
        toast.success(
          t("chat.workspaceDialog.createdWithFolders", {
            name: label,
            count: additional.length,
          }),
        );
      } else {
        toast.success(t("chat.workspaceDialog.created", { name: label }));
      }
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const usedBy = /already used by workspace "([^"]+)"/u.exec(message)?.[1];
      setError(
        /already exists/i.test(message)
          ? t("chat.workspaceDialog.nameExists", { name: effectiveName })
          : usedBy
            ? t("chat.workspaceDialog.mainInUse", { name: usedBy })
            : t("chat.workspaceDialog.createFailed", { error: message }),
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmTrust = async () => {
    if (!trustPending) return;
    trustProjectFolders(trustPending);
    setTrustPending(null);
    await saveLocal();
  };

  /** 主目录被占用时的快捷入口：切到占用它的工作空间并开新对话。
   *  占用方若是移除/归档态，先落 archived=false / hidden=false 让卡片回侧栏
   *  （新对话本身也会在 sidecar 唤回，这里提前落一次保证 UI 立即可见）。 */
  const openExisting = async () => {
    if (!mainConflict) return;
    const primary = projectPrimaryPath(mainConflict);
    if (primary) {
      setWorkspace(primary, "user", mainConflict.id);
    }
    if (mainConflict.archived || mainConflict.hiddenFromSidebar) {
      try {
        await saveProject({
          id: mainConflict.id,
          ...(mainConflict.archived ? { archived: false } : {}),
          ...(mainConflict.hiddenFromSidebar
            ? { hiddenFromSidebar: false }
            : {}),
        });
      } catch {
        /* 唤回失败不阻断跳转：新对话创建时 sidecar 会再兜底 */
      }
    }
    onOpenExistingProject?.(mainConflict);
    onClose();
  };

  const canAdd = desktop && !busy && !atLimit && !remoteMode;

  /** 附加目录换主目录：移到首位即成主目录（保存时 primaryPath 取首位） */
  const makePrimary = (folder: string) => {
    setError(null);
    setFolders((prev) =>
      prev[0] === folder ? prev : [folder, ...prev.filter((f) => f !== folder)],
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        forceOverlay={forceOverlay}
        className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {editingRemote
              ? t("chat.workspaceDialog.editRemoteTitle")
              : editing
                ? t("chat.workspaceDialog.editTitle")
                : t("chat.workspaceDialog.title")}
          </DialogTitle>
        </DialogHeader>

        {/* 不用 <form>：自定义取色面板里的 hex 输入按 Enter 会触发表单提交，
            误创建工作区。创建入口只保留「创建」按钮与名称输入框的 Enter */}
        <div className="flex flex-col gap-5">
          {/* 文件所在位置：本机工作区 vs 走 SSH 的远程工作区。编辑本地项目时
              位置固定为本机，不展示切换入口。 */}
          {!editing ? (
            <div className="flex flex-col gap-1.5">
              <Label>{t("chat.workspaceDialog.location")}</Label>
              <Select
                value={location}
                items={locationItems}
                onValueChange={(value) => {
                  if (!value) return;
                  if (value === "__add__") {
                    setConnDialogOpen(true);
                    return;
                  }
                  setLocation(value);
                  setError(null);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {!editingRemote ? (
                    <SelectItem value="local">
                      <span className="inline-flex items-center gap-2">
                        <MonitorIcon className="size-3.5" />
                        {t("chat.workspaceDialog.locationLocal")}
                      </span>
                    </SelectItem>
                  ) : null}
                  {enabledHosts.map((host) => (
                    <SelectItem key={host.id} value={host.id}>
                      <span className="inline-flex items-center gap-2">
                        <ServerIcon className="size-3.5" />
                        {host.name}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value="__add__">
                    <span className="text-muted-foreground inline-flex items-center gap-1.5">
                      <PlusIcon className="size-3.5" />
                      {t("chat.workspaceDialog.addRemoteHost")}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {remoteMode ? (
                <p className="text-muted-foreground text-xs">
                  {t("chat.workspaceDialog.remoteLocationHint")}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* 源文件夹：空态整块可点；有内容后保留底部添加入口，支持反复追加 */}
          {remoteMode ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-sm leading-none font-medium">
                  {t("chat.workspaceDialog.sourceFolders")}
                </span>
                <p className="text-muted-foreground text-xs">
                  {t("chat.workspaceDialog.remoteSourceHint")}
                </p>
              </div>
              <RemotePathPicker
                hostId={remoteHost?.id ?? ""}
                value={remotePath}
                onChange={setRemotePath}
                inputId="workspace-create-remote-path"
                disabled={busy}
              />
            </div>
          ) : (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-sm leading-none font-medium">
                  {t("chat.workspaceDialog.sourceFolders")}
                </span>
                <p className="text-muted-foreground text-xs">
                  {t("chat.workspaceDialog.sourceHint", {
                    count: WORKSPACE_MAX_FOLDERS,
                  })}
                </p>
              </div>
              <div
                className={cn(
                  "rounded-xl border border-dashed border-border/80 bg-muted/30 p-1.5",
                  folders.length === 0 && "p-0",
                )}
              >
                {folders.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => void addFolder()}
                    disabled={!canAdd || picking}
                    className="hover:bg-muted/50 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring flex h-36 w-full flex-col items-center justify-center gap-2 rounded-xl text-sm transition-colors disabled:cursor-default disabled:opacity-60"
                  >
                    {picking ? (
                      <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
                    ) : (
                      <FolderPlusIcon className="text-muted-foreground size-5" />
                    )}
                    <span>
                      {desktop
                        ? t("chat.workspaceDialog.addFolderHint")
                        : t("chat.workspaceDialog.desktopOnly")}
                    </span>
                  </button>
                ) : (
                  <>
                    <div className="flex flex-col gap-0.5">
                      {folders.map((folder, index) => (
                        <div
                          key={folder}
                          className="group/folder hover:bg-muted/60 flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors"
                        >
                          <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium">
                                {workspaceFolderName(folder)}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1 text-2xs",
                                  index === 0
                                    ? "bg-primary/10 text-primary"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {index === 0
                                  ? t("chat.workspaceDialog.mainBadge")
                                  : t("chat.workspaceDialog.additionalBadge")}
                              </span>
                            </div>
                            <div
                              className="text-muted-foreground truncate font-mono text-2xs"
                              title={folder}
                            >
                              {folder}
                            </div>
                          </div>
                          {/* 附加目录可换主目录：移到首位即成主要（保存时取首位） */}
                          {index !== 0 ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => makePrimary(folder)}
                              className="text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {t("chat.workspaceDialog.setPrimary")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-label={t("chat.workspaceDialog.removeFolder", {
                              name: workspaceFolderName(folder),
                            })}
                            title={t("chat.workspaceDialog.removeFolder", {
                              name: workspaceFolderName(folder),
                            })}
                            disabled={busy}
                            onClick={() => removeFolder(folder)}
                            className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100 disabled:opacity-0 max-sm:opacity-100"
                          >
                            <XIcon className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                    {/* 添加：行尾 inline pill（空态仍是整块可点），支持反复追加 */}
                    <div className="mt-1 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => void addFolder()}
                        disabled={!canAdd || picking}
                        className="text-muted-foreground hover:bg-background/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring flex h-7 items-center gap-1 rounded-full border border-border/70 px-2.5 text-xs transition-colors disabled:cursor-default disabled:opacity-50"
                      >
                        {picking ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <PlusIcon className="size-3.5" />
                        )}
                        {t("chat.workspaceDialog.addFolder")}
                      </button>
                    </div>
                  </>
                )}
              </div>
              {atLimit ? (
                <p className="text-muted-foreground text-xs">
                  {t("chat.workspaceDialog.limit", { count: WORKSPACE_MAX_FOLDERS })}
                </p>
              ) : null}
              {mainConflict ? (
                <div className="border-destructive/40 bg-destructive/5 flex flex-col gap-2 rounded-xl border px-3 py-2.5">
                  <p className="text-destructive text-xs leading-5">
                    {t("chat.workspaceDialog.mainInUse", {
                      name: projectDisplayName(mainConflict),
                    })}
                  </p>
                  {/* 快捷入口只在调用方能「开新对话」时提供（composer）；
                      设置页等只有查看范围的场景不渲染，避免文案与行为不符 */}
                  {onOpenExistingProject ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-fit"
                      disabled={busy}
                      onClick={() => void openExisting()}
                    >
                      {t("chat.workspaceDialog.openExisting", {
                        name: projectDisplayName(mainConflict),
                      })}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {existingProject && !mainConflict ? (
                <p className="text-muted-foreground text-xs">
                  {t("chat.workspaceDialog.sharedHint", {
                    project: projectDisplayName(existingProject),
                  })}
                </p>
              ) : null}
            </div>
          </>
          )}

          <div className="flex flex-col gap-1.5">
            {/* 头像按钮和名称输入框合成一个控件：图标当 InputGroup 的前缀，
                中间留一条竖分割线，避免用户把图标当成纯装饰 */}
            <InputGroup className="h-9">
              {!remoteMode ? (
                <>
                  <InputGroupAddon className="h-full py-0 pl-0 pr-0 has-[>button]:ml-0">
                    <ProjectAppearancePicker
                      appearance={appearance}
                      onChange={setAppearance}
                      disabled={busy}
                      embedded
                    />
                  </InputGroupAddon>
                  <span aria-hidden className="bg-border h-5 w-px shrink-0" />
                </>
              ) : null}
              <InputGroupInput
                id="workspace-create-name"
                value={name}
                maxLength={PROJECT_NAME_MAX_CHARS}
                placeholder={t("chat.workspaceDialog.namePlaceholder")}
                className="min-w-0 flex-1"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  // IME 组合中（中文选字等）：回车是确认候选词，不是提交
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </InputGroup>
            <p
              className={
                nameExists ? "text-destructive text-xs" : "text-muted-foreground text-xs"
              }
            >
              {nameExists
                ? t("chat.workspaceDialog.nameExists", { name: effectiveName })
                : t("chat.workspaceDialog.nameHint")}
            </p>
          </div>

          {error ? <div className="text-destructive text-xs">{error}</div> : null}

          <DialogFooter className="border-border/60 border-t pt-4">
            {editing ? (
              <div className="me-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={busy}
                  onClick={onArchiveProject}
                >
                  <ArchiveIcon className="size-3.5" />
                  {t("chat.workspaceDialog.archiveProject")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={busy}
                  onClick={onRemoveProject}
                >
                  <EyeOffIcon className="size-3.5" />
                  {t("chat.workspaceDialog.removeFromSidebar")}
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
            >
              {t("common.action.cancel")}
            </Button>
            <Button
              type="button"
              disabled={
                !desktop ||
                busy ||
                Boolean(mainConflict) ||
                (remoteMode
                  ? !remoteHost || !remotePath.trim().startsWith("/")
                  : folders.length === 0)
              }
              onClick={() => void submit()}
            >
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {busy
                ? t("chat.workspaceDialog.creating")
                : editing || editingRemote
                  ? t("chat.workspaceDialog.save")
                  : t("chat.workspaceDialog.create")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>

      {/* 信任此文件夹：新目录交给 agent 前确认（读取/编辑/运行命令、
          AGENTS.md 与 .kova 钩子都可能触发执行）。确认后按路径记住。 */}
      <AlertDialog
        open={trustPending !== null}
        onOpenChange={(open) => {
          if (!open) setTrustPending(null);
        }}
      >
        {trustPending ? (
          <AlertDialogContent forceOverlay>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("chat.workspaceDialog.trustTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("chat.workspaceDialog.trustDesc")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="bg-muted/50 flex flex-col gap-1.5 rounded-xl px-3 py-2.5">
              {trustPending.map((folder) => (
                <div key={folder} className="flex min-w-0 items-center gap-2">
                  <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" />
                  <span
                    className="truncate font-mono text-xs"
                    title={folder}
                  >
                    {folder}
                  </span>
                </div>
              ))}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel size="default">
                {t("common.action.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                size="default"
                variant="default"
                disabled={busy}
                onClick={() => void confirmTrust()}
              >
                {t("chat.workspaceDialog.trustConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      {/* 位置下拉里的「添加远程主机…」：保存连接后自动选中并刷新主机列表 */}
      <SshConnectionDialog
        open={connDialogOpen}
        onClose={() => setConnDialogOpen(false)}
        onSaved={(saved) => {
          setConnDialogOpen(false);
          void loadHosts();
          setLocation(saved.id);
        }}
      />
    </Dialog>
  );
};
