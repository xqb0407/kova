"use client";

import {
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactElement,
} from "react";
import {
  AlertTriangleIcon,
  ArchiveIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isDesktop, isMacPlatform, isWindowsPlatform } from "@/lib/desktop-env";
import { isRemoteMode } from "@/lib/remote";
import { fsErrorText, projectReveal } from "@/lib/workspace/fs";
import { pathBasename } from "@/lib/workspace/workspace-store";
import {
  addProjectDir,
  confirmRemoveProjectDir,
  fetchProjectDirs,
  pickProjectDir,
  removeProjectDir,
  type ProjectDirsInfo,
} from "@/lib/pi/pi-project-dirs";
import {
  patchRegistryAppearance,
  projectAppearanceOf,
  saveProject,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";
import { setProjectDisplayName } from "@/lib/projects/project-display-name";
import { ProjectBadge, projectColorTokens } from "@/components/ui/project-badge";
import {
  ProjectColorPicker,
  ProjectIconPicker,
  type ProjectIconTab,
} from "@/components/ui/project-appearance-picker";
import {
  hasProjectAppearance,
  projectAppearanceFor,
  setProjectAppearance,
  useProjectAppearancesVersion,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";

/** 上传源文件上限（缩到 64×64 之前），超限直接劝退而不是缩完再报 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** 落库头像边长：64 足够在默认 18px 徽章（侧栏放大到 24px）+ 2x 屏下清晰 */
const LOGO_SIZE = 64;

/** 菜单行：13px 文本 / 32px 行高 / 6px 圆角，与系统菜单同一档密度 */
const ROW =
  "h-8 w-full justify-start gap-2.5 rounded-md px-2 text-[13px] font-normal";

/** 「在文件管理器中显示」按平台叫法：macOS = Finder，Windows = 资源管理器 */
function revealLabel(): string {
  if (isMacPlatform()) return "在 Finder 中显示";
  if (isWindowsPlatform()) return "在资源管理器中显示";
  return "在文件管理器中显示";
}

/**
 * 上传图片 → 64×64 PNG dataURL：先按短边居中裁方形（头像不变形），再缩放。
 * createImageBitmap 在 Chromium 里默认按 EXIF 方向解码（手机照片不会躺着）。
 */
async function fileToLogoDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side <= 0) throw new Error("empty image");
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = LOGO_SIZE;
    canvas.height = LOGO_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, LOGO_SIZE, LOGO_SIZE);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close?.();
  }
}

/**
 * 项目设置卡（紧贴项目行的 Popover）。
 *
 * 形态按"系统菜单"而不是"设置表单"来组织：一行项目身份、一行色点、一组
 * 图标选择、三行项目操作。图标组用下划线 tabs 切换吉祥物/内置头像，一次只铺
 * 一组；项目目录挂在「项目目录」行上向右飞出二级菜单，列表长度不影响主卡高度。
 */
export const ProjectSettingsPopover: FC<{
  cwd: string;
  label: string;
  /** 项目实体 id（新模型；旧会话/无项目为空） */
  projectId?: string;
  /** ⋯ 触发按钮：base-ui 会把开合语义合并进这个元素 */
  children: ReactElement;
  onArchive: () => void;
}> = ({ cwd, label, projectId, children, onArchive }) => {
  // 订阅版本号：改完颜色/吉祥物/图片，卡片里的预览与侧栏同步更新
  useProjectAppearancesVersion();
  // localStorage 同步缓存优先；缓存被清/换端时回落项目实体的 appearance_json
  const registry = useProjectRegistry();
  const entity = projectId
    ? registry.find((project) => project.id === projectId)
    : undefined;
  const appearance = projectAppearanceOf(entity) ?? projectAppearanceFor(cwd);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState(false);
  /** 头像页签下颜色没有意义（头像自带配色），整行隐藏 */
  const [iconTab, setIconTab] = useState<ProjectIconTab>(
    appearance?.avatar ? "avatar" : "glyph",
  );
  // 项目虚拟目录：打开弹层时现拉（事实源在 sidecar，别的窗口/端改过也能看到）
  const [dirs, setDirs] = useState<ProjectDirsInfo | null>(null);
  const [dirsBusy, setDirsBusy] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);
  // 名称编辑：打开时用当前 label 作为草稿；保存写 localStorage + 后端项目实体
  const [nameDraft, setNameDraft] = useState(label);
  const [savingName, setSavingName] = useState(false);
  // 弹层重开/label 变了 → 同步草稿（组件复用同 instance，useState 只初始化一次）
  useEffect(() => {
    if (open) setNameDraft(label);
  }, [open, label]);

  const saveName = async () => {
    if (savingName) return;
    const trimmed = nameDraft.trim();
    if (trimmed === label) return;
    setSavingName(true);
    try {
      // 有实体时 DB 是名称事实源：先写后端，成功再更新本地缓存
      if (projectId) {
        await saveProject({
          id: projectId,
          name: trimmed || null,
          nameIsCustom: Boolean(trimmed),
        });
      }
      setProjectDisplayName(cwd, trimmed || null);
    } catch (err) {
      // 后端失败则让 localStorage 回到当前显示名，避免两套名称分叉
      setProjectDisplayName(cwd, label.trim() || null);
      setNameDraft(label);
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        /already exists/i.test(message)
          ? "工作空间名称已存在，请换一个"
          : `重命名失败：${message}`,
      );
    } finally {
      setSavingName(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // 换项目复用同一组件时先清空，避免短暂显示上一个项目的根
    setDirs(null);
    setDirsError(null);
    void fetchProjectDirs(cwd, projectId)
      .then((info) => {
        if (alive) setDirs(info);
      })
      .catch((err) => {
        if (alive) {
          setDirsError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [open, cwd, projectId]);

  const addDir = async () => {
    const path = await pickProjectDir();
    if (!path) return;
    setDirsBusy(true);
    setDirsError(null);
    try {
      setDirs(await addProjectDir(cwd, path, projectId));
      toast.success(`已添加项目目录：${pathBasename(path)}`);
    } catch (err) {
      toast.error(
        `添加失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDirsBusy(false);
    }
  };

  const removeDir = async (path: string) => {
    if (!(await confirmRemoveProjectDir(path))) return;
    setDirsBusy(true);
    setDirsError(null);
    try {
      setDirs(await removeProjectDir(cwd, path, projectId));
      toast.info("已从项目移除该目录");
    } catch (err) {
      toast.error(
        `移除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDirsBusy(false);
    }
  };

  // 外观改动双写：localStorage（即时显示）+ 后端项目实体（持久化）。
  // 颜色拖动会高频触发，用 500ms 防抖合并后端写入；关面板/卸载时 flush
  // 最后一次改动，避免“本地有、后端没有”。
  const appearanceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** undefined = 没有待写草稿；null = 显式清空外观 */
  const pendingAppearance = useRef<ProjectAppearance | null | undefined>(
    undefined,
  );
  /** 草稿所属项目：组件被复用换项目时，flush 必须写回旧项目 */
  const pendingProjectId = useRef<string | undefined>(projectId);

  const flushAppearance = () => {
    if (appearanceSaveTimer.current) {
      clearTimeout(appearanceSaveTimer.current);
      appearanceSaveTimer.current = null;
    }
    const targetId = pendingProjectId.current;
    if (!targetId || pendingAppearance.current === undefined) return;
    const next = pendingAppearance.current;
    pendingAppearance.current = undefined;
    void saveProject({
      id: targetId,
      appearanceJson: next ? JSON.stringify(next) : null,
    }).catch(() => {});
  };

  // 换项目前先把上一项目的草稿落库
  useEffect(() => {
    if (pendingProjectId.current !== projectId) {
      flushAppearance();
      pendingProjectId.current = projectId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 关卡片时重置隐藏文件框 + flush 防抖中的外观
  useEffect(() => {
    if (!open && fileInputRef.current) fileInputRef.current.value = "";
    if (!open) flushAppearance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 组件卸载（切项目/关侧栏）也要把最后一次改动落库
  useEffect(
    () => () => {
      flushAppearance();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const patch = (next: ProjectAppearance | null) => {
    setProjectAppearance(cwd, next);
    if (!projectId) return;
    // 注册表先乐观更新：侧栏/卡片立即反映，不依赖 500ms 后的后端回包
    patchRegistryAppearance(
      projectId,
      next ? JSON.stringify(next) : null,
    );
    pendingProjectId.current = projectId;
    pendingAppearance.current = next;
    if (appearanceSaveTimer.current) clearTimeout(appearanceSaveTimer.current);
    appearanceSaveTimer.current = setTimeout(() => {
      appearanceSaveTimer.current = null;
      flushAppearance();
    }, 500);
  };
  const withoutImage = (): ProjectAppearance => {
    const rest: ProjectAppearance = { ...appearance };
    delete rest.image;
    return rest;
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(
        `图片超过 ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB 上限`,
      );
      return;
    }
    setUploading(true);
    try {
      const image = await fileToLogoDataUrl(file);
      patch({ ...withoutImage(), image });
    } catch {
      toast.error("图片读取失败，换一张试试");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  /** 图标着色：主色按主题明暗做一次混合（见 projectColorTokens），
   *  自定义深色 hex 在暗色主题下也不会糊进背景 */
  const colorTokens = appearance?.color
    ? projectColorTokens(appearance.color)
    : null;
  const iconTint = colorTokens ? { color: colorTokens.ink } : undefined;

  const desktop = isDesktop();
  // 项目目录是本机配置：网关侧拒绝远程写，UI 同步隐藏写入口（只读展示仍可用）
  const canManageDirs = desktop && !isRemoteMode();
  const missingDirs = new Set(dirs?.missing ?? []);
  // 目录还没拉回来时先按"只有主目录"渲染，避免入口短暂显示 0 个
  const roots = dirs?.roots ?? [{ path: cwd, label }];
  // 头像/上传图使用自己的配色，颜色行没有意义
  const showColor =
    iconTab === "glyph" && !appearance?.avatar && !appearance?.image;

  /** 在系统文件管理器中定位项目目录（macOS=Finder / Windows=资源管理器）。
   *  项目目录未必是当前 workspace，因此走 project_reveal 而不是 fs_reveal */
  const revealProject = async () => {
    setOpen(false);
    const err = await projectReveal(cwd);
    if (err) toast.error(fsErrorText(err));
  };

  const copyProjectPath = async () => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(cwd);
      // toast.success("已复制项目路径");
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={children} />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        className="w-80 gap-3 p-3"
        aria-label={`${label} 项目设置`}
      >
        {/* 身份行：40px 预览 + 名称 + 上传。路径不在这里占行，目录二级菜单里有 */}
        <div className="flex items-center gap-3">
          {hasProjectAppearance(appearance) ? (
            <ProjectBadge
              appearance={appearance}
              className="size-10 rounded-xl [&>svg]:size-6"
            />
          ) : (
            <span className="bg-muted grid size-10 shrink-0 place-items-center rounded-xl">
              <FolderIcon
                className="text-muted-foreground size-5"
                style={iconTint}
              />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="truncate text-sm font-medium"
                title={cwd}
              >
                {label}
              </span>
              <div className="ms-auto flex shrink-0 items-center gap-0.5">
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground h-6 px-1.5 text-2xs active:not-aria-[haspopup]:translate-y-0"
                  disabled={uploading}
                  title="PNG / JPG / WebP，≤2MB，自动裁成方形并缩到 64×64"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? (
                    <Loader2Icon className="animate-spin" />
                  ) : (
                    <UploadIcon />
                  )}
                  {uploading ? "处理中" : appearance?.image ? "更换" : "上传"}
                </Button>
                {appearance?.image ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="移除图片"
                    title="移除图片"
                    onClick={() => patch(withoutImage())}
                  >
                    <XIcon />
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void onPickFile(e.target.files?.[0])}
          />
        </div>

        {/* 名称编辑：写 localStorage + 后端项目实体 */}
        <div className="flex items-center gap-2 px-0.5">
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void saveName(); }
              if (e.key === "Escape") setNameDraft(label);
            }}
            onBlur={() => void saveName()}
            placeholder={label}
            maxLength={60}
            className="bg-muted/60 focus-visible:bg-background focus-visible:border-ring h-8 w-full min-w-0 rounded-lg border border-transparent px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground"
            aria-label="项目名称"
          />
          {savingName ? (
            <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />
          ) : null}
        </div>

        {/* 颜色 + 图标：与「新建工作区」对话框共用同一套选择器，
            避免两处图标体系/选色行为分叉 */}
        {showColor ? (
          <ProjectColorPicker appearance={appearance} onChange={patch} />
        ) : null}

        <ProjectIconPicker
          appearance={appearance}
          onChange={patch}
          onTabChange={setIconTab}
          resetKey={open}
        />

        <div className="bg-border/70 mx-1 h-px" />

        {/* 项目目录：主目录 + 附加代码工程根，挂在行右侧的二级菜单里。
            附加根会进入项目内所有对话的系统提示词/技能发现/文件检索与
            workspace-write 写权限 */}
        <div className="flex flex-col gap-0.5">
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors hover:bg-muted"
                >
                  <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                  <span>项目目录</span>
                  <span className="text-muted-foreground ms-auto text-[11px] tabular-nums">
                    {roots.length}
                  </span>
                  {missingDirs.size > 0 ? (
                    <span
                      role="img"
                      aria-label={`${missingDirs.size} 个目录缺失`}
                      title={`${missingDirs.size} 个目录缺失`}
                      className="size-1.5 shrink-0 rounded-full bg-amber-500"
                    />
                  ) : null}
                  <ChevronRightIcon className="text-muted-foreground/70 size-3.5 shrink-0" />
                </button>
              }
            />
            <PopoverContent
              side="right"
              align="start"
              alignOffset={-4}
              sideOffset={14}
              className="w-72 gap-1.5 border-0 p-1.5 shadow-xl ring-1 ring-border/30"
              aria-label={`${label} 项目目录`}
            >
              <div className="flex h-6 items-center justify-between gap-2 ps-2 pe-0.5">
                <span className="text-muted-foreground text-2xs font-medium">
                  项目目录
                </span>
                {canManageDirs ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="添加项目目录"
                    title="添加项目目录"
                    disabled={dirsBusy}
                    onClick={() => void addDir()}
                  >
                    {dirsBusy ? (
                      <Loader2Icon className="animate-spin" />
                    ) : (
                      <PlusIcon />
                    )}
                  </Button>
                ) : null}
              </div>
              <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto overscroll-contain">
                {roots.map((root, index) => {
                  const isMain = index === 0;
                  const isMissing = missingDirs.has(root.path);
                  return (
                    <div
                      key={root.path}
                      className="group/dir hover:bg-muted/70 flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
                    >
                      {isMissing ? (
                        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      ) : (
                        <FolderOpenIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px]">
                            {isMain ? label : root.label}
                          </span>
                          {isMain ? (
                            <span className="text-muted-foreground shrink-0 text-2xs">
                              主目录
                            </span>
                          ) : null}
                        </div>
                        <div
                          className="text-muted-foreground truncate text-[11px] leading-4"
                          title={root.path}
                        >
                          {root.path}
                        </div>
                        {isMissing ? (
                          <div className="text-2xs text-amber-600 dark:text-amber-400">
                            目录不存在（配置保留，已跳过）
                          </div>
                        ) : null}
                      </div>
                      {!isMain && canManageDirs ? (
                        <button
                          type="button"
                          aria-label={`移除 ${root.label}`}
                          title="从项目移除这个目录"
                          disabled={dirsBusy}
                          onClick={() => void removeDir(root.path)}
                          className="text-muted-foreground hover:text-destructive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:opacity-100 group-hover/dir:opacity-100 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity disabled:opacity-0"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <p
                className="text-muted-foreground px-2 pb-0.5 text-2xs"
                title="AGENTS.md、技能与文件检索都会读取这些目录"
              >
                附加目录作为外部上下文参与所有对话
              </p>
              {dirsError ? (
                <p className="text-destructive px-2 pb-0.5 text-2xs">
                  {dirsError}
                </p>
              ) : null}
            </PopoverContent>
          </Popover>

          {/* 文件管理 / 复制：与目录入口同一组菜单行；只在桌面壳出现 */}
          {desktop ? (
            <>
              <Button
                variant="ghost"
                className={ROW}
                onClick={() => void revealProject()}
              >
                <FolderOpenIcon className="text-muted-foreground size-4" />
                {revealLabel()}
              </Button>
              <Button
                variant="ghost"
                className={ROW}
                onClick={() => void copyProjectPath()}
              >
                <CopyIcon className="text-muted-foreground size-4" />
                复制路径
              </Button>
            </>
          ) : null}
        </div>

        <div className="bg-border/70 mx-1 h-px" />
        {/* 归档：破坏性动作单独分隔收在菜单最末，红色文字与普通行区分 */}
        <Button
          variant="ghost"
          className={cn(
            ROW,
            "text-destructive hover:bg-destructive/10 hover:text-destructive",
          )}
          onClick={() => {
            setOpen(false);
            onArchive();
          }}
        >
          <ArchiveIcon className="size-4" />
          归档项目
        </Button>
      </PopoverContent>
    </Popover>
  );
};
