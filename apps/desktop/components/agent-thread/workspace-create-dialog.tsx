"use client";

/**
 * 新建工作区对话框：把「选一个系统目录」升级成一张完整的工作区创建表单。
 *
 * - 源文件夹可反复点「添加文件夹」（系统选择器一次选一个），第一个是主目录，
 *   其余走项目虚拟目录（add_project_dir）成为同一项目的附加根；
 * - 名称存项目显示名（localStorage），图标/颜色复用项目外观；
 * - 只覆盖用户真正改过的外观字段，避免只加目录时把已有头像/图片清掉。
 *
 * 入口：composer 工作区胶囊「添加目录…」、侧栏「选择工作目录」。
 * 最近目录/远程项目仍留在原菜单里，不在本对话框展开。
 */
import { useEffect, useRef, useState, type FC } from "react";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { ProjectBadge } from "@/components/ui/project-badge";
import {
  ProjectColorPicker,
  ProjectIconPicker,
  type ProjectIconTab,
} from "@/components/ui/project-appearance-picker";
import { cn } from "@/lib/utils";
import { isDesktop } from "@/lib/desktop-env";
import { useT } from "@/lib/i18n";
import { open as openDialog } from "@/desktop-bridge/plugin-dialog";
import {
  hasProjectAppearance,
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
  saveProject,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";
import { setWorkspace } from "@/lib/workspace/workspace-store";
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
}> = ({ open, onClose }) => {
  const t = useT();
  const desktop = isDesktop();
  const [folders, setFolders] = useState<string[]>([]);
  const [name, setName] = useState("");
  /** 外观草稿：主目录已有 logo/颜色时先回填，用户改哪项由共享选择器负责 */
  const [appearance, setAppearance] = useState<ProjectAppearance | null>(null);
  /** 头像页签下颜色没有意义（头像自带配色），整个颜色区隐藏 */
  const [iconTab, setIconTab] = useState<ProjectIconTab>("glyph");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 主目录已属于某个项目：提示共享 + DB 名称/外观兜底回填 */
  const [existingProject, setExistingProject] = useState<ProjectRecord | null>(
    null,
  );
  /** 未归档项目的显示名（小写）：提交前做重名提醒，后端仍会兜底拒绝 */
  const [takenNames, setTakenNames] = useState<Set<string>>(() => new Set());
  /** 主目录变化时用已有项目身份回填一次；连续添加后续目录不重置草稿 */
  const lastMainRef = useRef<string | null>(null);

  const main = folders[0] ?? null;
  // 最终显示名：输入框优先；留空回落主文件夹名。两者都不能与已有项目重复。
  const fallbackName = main
    ? (main.split(/[\\/]/u).filter(Boolean).at(-1) ?? "")
    : "";
  const effectiveName = name.trim() || fallbackName;
  const nameExists =
    Boolean(effectiveName) &&
    takenNames.has(effectiveName.toLocaleLowerCase());

  // 关闭时清空，下次打开从干净草稿开始（不在 open=true 时清，
  // 否则回填 effect 会拿上一轮的 folders 快照把旧名字写回来）
  useEffect(() => {
    if (open) return;
    setFolders([]);
    setName("");
    setAppearance(null);
    setIconTab("glyph");
    setPicking(false);
    setBusy(false);
    setError(null);
    setExistingProject(null);
    setTakenNames(new Set());
    lastMainRef.current = null;
  }, [open]);

  // 主目录换了（首次添加/移除首个）→ 回填该目录已有的显示名与外观。
  // 优先 localStorage 同步缓存；缓存缺失时用项目实体的 DB 字段兜底，
  // 避免“清过缓存/换端后打开对话框把已有名称图标清空”。
  useEffect(() => {
    if (!open || !main || lastMainRef.current === main) return;
    lastMainRef.current = main;
    const localName = projectDisplayNameFor(main) ?? "";
    const localAppearance = projectAppearanceFor(main) ?? null;
    setName(localName);
    setAppearance(localAppearance);
    setIconTab(localAppearance?.avatar ? "avatar" : "glyph");
    setExistingProject(null);
    let alive = true;
    void fetchProjects(true)
      .then((projects) => {
        if (!alive) return;
        const match = projects.find(
          (project) => !project.archived && projectHasPath(project, main),
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
        if (!match) return;
        setExistingProject(match);
        // 这是“新建项目”对话框：已有项目仍占用该目录时，沿用它的名称
        // 必然撞唯一校验。清掉自动回填的名字（用户已手输则保留）。
        setName((prev) => (prev === localName ? "" : prev));
        if (!localAppearance) {
          const dbAppearance = projectAppearanceOf(match);
          if (dbAppearance) {
            setAppearance(dbAppearance);
            setIconTab(dbAppearance.avatar ? "avatar" : "glyph");
          }
        }
      })
      .catch(() => {
        /* 项目列表不可用：只按 localStorage 回填 */
      });
    return () => {
      alive = false;
    };
  }, [open, main]);

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
    setBusy(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      const appearanceJson = appearance ? JSON.stringify(appearance) : null;
      const project = await saveProject({
        name: trimmedName || null,
        folders: [nextMain, ...additional],
        primaryPath: nextMain,
        appearanceJson,
        showWhenEmpty: true,
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
      // 项目已落库：设置工作区（cwd=primary folder）并带上项目 id
      setWorkspace(nextMain, "user", project.id);

      const label = trimmedName || workspaceFolderName(nextMain);
      if (additional.length > 0) {
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
      setError(
        /already exists/i.test(message)
          ? t("chat.workspaceDialog.nameExists", { name: effectiveName })
          : t("chat.workspaceDialog.createFailed", { error: message }),
      );
    } finally {
      setBusy(false);
    }
  };

  const canAdd = desktop && !busy && !atLimit;
  // 头像/上传图使用自己的配色，颜色行没有意义：头像页签或已有非 glyph 身份时隐藏
  const showColor =
    iconTab === "glyph" && !appearance?.avatar && !appearance?.image;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("chat.workspaceDialog.title")}</DialogTitle>
        </DialogHeader>

        {/* 不用 <form>：自定义取色面板里的 hex 输入按 Enter 会触发表单提交，
            误创建工作区。创建入口只保留「创建」按钮与名称输入框的 Enter */}
        <div className="flex flex-col gap-5">
          {/* 源文件夹：空态整块可点；有内容后保留底部添加入口，支持反复追加 */}
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
                                  ? "bg-foreground/[0.06] text-foreground/80"
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
                  <button
                    type="button"
                    onClick={() => void addFolder()}
                    disabled={!canAdd || picking}
                    className="text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 text-xs transition-colors disabled:cursor-default disabled:opacity-50"
                  >
                    {picking ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <PlusIcon className="size-3.5" />
                    )}
                    {t("chat.workspaceDialog.addFolder")}
                  </button>
                </>
              )}
            </div>
            {atLimit ? (
              <p className="text-muted-foreground text-xs">
                {t("chat.workspaceDialog.limit", { count: WORKSPACE_MAX_FOLDERS })}
              </p>
            ) : null}
            {existingProject ? (
              <p className="text-muted-foreground text-xs">
                {t("chat.workspaceDialog.sharedHint", {
                  project: projectDisplayName(existingProject),
                })}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="workspace-create-name">
              {t("chat.workspaceDialog.name")}
            </Label>
            <Input
              id="workspace-create-name"
              value={name}
              maxLength={PROJECT_NAME_MAX_CHARS}
              placeholder={t("chat.workspaceDialog.namePlaceholder")}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
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

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm leading-none font-medium">
                {t("chat.workspaceDialog.icon")}
              </span>
              {/* 主目录已有头像/上传图时给个预览，和侧栏弹层头部保持一致 */}
              {hasProjectAppearance(appearance) ? (
                <ProjectBadge
                  appearance={appearance}
                  className="size-6 rounded-md [&>svg]:size-4"
                />
              ) : null}
            </div>
            {/* 与侧栏项目「⋯」共用同一套吉祥物/头像页签，避免两处图标体系分叉 */}
            <ProjectIconPicker
              appearance={appearance}
              onChange={setAppearance}
              onTabChange={setIconTab}
              resetKey={open}
            />
          </div>

          {showColor ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm leading-none font-medium">
                {t("chat.workspaceDialog.color")}
              </span>
              <ProjectColorPicker
                appearance={appearance}
                onChange={setAppearance}
              />
            </div>
          ) : null}

          {error ? <div className="text-destructive text-xs">{error}</div> : null}

          <DialogFooter className="border-border/60 border-t pt-4">
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
              disabled={!desktop || busy || folders.length === 0}
              onClick={() => void submit()}
            >
              {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {busy
                ? t("chat.workspaceDialog.creating")
                : t("chat.workspaceDialog.create")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};
