"use client";

import {
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactElement,
} from "react";
import dynamic from "next/dynamic";
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
import { ProjectBadge, PROJECT_GLYPH_ICONS, projectColorTokens } from "@/components/ui/project-badge";
import {
  PROJECT_MASCOT_COLORS,
  PROJECT_MASCOT_GLYPHS,
  hasProjectAppearance,
  projectAppearanceFor,
  setProjectAppearance,
  useProjectAppearancesVersion,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";
import {
  BUILTIN_PROJECT_AVATARS,
  projectAvatarSrc,
} from "@/lib/projects/project-avatars";

/** 取色器只在「自定义颜色」展开时才需要：懒加载，别把设置页的
 *  color-picker（1244 行 + motion）带进主聊天 chunk */
const LazyColorField = dynamic(
  () =>
    import("@/components/settings/components/theme/color-field").then(
      (m) => m.ColorField,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted h-8 animate-pulse rounded-md" aria-hidden />
    ),
  },
);

/** 上传源文件上限（缩到 64×64 之前），超限直接劝退而不是缩完再报 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** 落库头像边长：64 足够在默认 18px 徽章（侧栏放大到 24px）+ 2x 屏下清晰 */
const LOGO_SIZE = 64;

type IconTab = "glyph" | "avatar";

/** 图标格：32px 圆角方块 + 升一级的 hover 底。图标本身统一跟项目主色走，
 *  选中只加底色/描边——不再把未选项压灰，"展开"与"收起"是同一套颜色 */
const CELL_BASE =
  "grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const CELL_IDLE = "hover:bg-muted";
const CELL_ON = "bg-foreground/[0.06] ring-1 ring-foreground/15";

/** 色点：18px 圆点，单行放完（默认 + 9 预设 + 自定义）。选中用外描边，不占布局；
 *  环色取前景色，强调色恰好等于色点颜色时也分得开 */
const SWATCH_BASE =
  "size-[18px] shrink-0 rounded-full border border-black/10 transition-transform hover:scale-110 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:border-white/10";
const SWATCH_ON = "outline-2 outline-offset-2 outline-foreground";

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
  /** ⋯ 触发按钮：base-ui 会把开合语义合并进这个元素 */
  children: ReactElement;
  onArchive: () => void;
}> = ({ cwd, label, children, onArchive }) => {
  // 订阅版本号：改完颜色/吉祥物/图片，卡片里的预览与侧栏同步更新
  useProjectAppearancesVersion();
  const appearance = projectAppearanceFor(cwd);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState(false);
  // 默认看哪一组：当前用的是内置头像就停在头像页，否则看吉祥物页
  const [iconTab, setIconTab] = useState<IconTab>(
    appearance?.avatar ? "avatar" : "glyph",
  );
  // 项目虚拟目录：打开弹层时现拉（事实源在 sidecar，别的窗口/端改过也能看到）
  const [dirs, setDirs] = useState<ProjectDirsInfo | null>(null);
  const [dirsBusy, setDirsBusy] = useState(false);
  const [dirsError, setDirsError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    // 换项目复用同一组件时先清空，避免短暂显示上一个项目的根
    setDirs(null);
    setDirsError(null);
    void fetchProjectDirs(cwd)
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
  }, [open, cwd]);

  // 打开卡片时把分段对齐到当前图标：组件被换项目复用时也不会停在上一家的页签
  useEffect(() => {
    if (!open) return;
    if (appearance?.avatar) setIconTab("avatar");
    else if (appearance?.glyph) setIconTab("glyph");
  }, [open, appearance?.glyph, appearance?.avatar]);

  const addDir = async () => {
    const path = await pickProjectDir();
    if (!path) return;
    setDirsBusy(true);
    setDirsError(null);
    try {
      setDirs(await addProjectDir(cwd, path));
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
      setDirs(await removeProjectDir(cwd, path));
      toast.info("已从项目移除该目录");
    } catch (err) {
      toast.error(
        `移除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDirsBusy(false);
    }
  };

  // 关卡片时重置隐藏文件框：同一张图连着传两次也要能触发 change
  useEffect(() => {
    if (!open && fileInputRef.current) fileInputRef.current.value = "";
  }, [open]);

  const patch = (next: ProjectAppearance | null) => {
    setProjectAppearance(cwd, next);
  };
  const withoutImage = (): ProjectAppearance => {
    const rest: ProjectAppearance = { ...appearance };
    delete rest.image;
    return rest;
  };
  /** 清掉某个字段；清完为空则整条移除（回退文件夹图标） */
  const clearField = (field: keyof ProjectAppearance) => {
    const rest: ProjectAppearance = { ...appearance };
    delete rest[field];
    patch(Object.keys(rest).length > 0 ? rest : null);
  };

  /** 选择内置图标即替换当前身份：同时清掉头像组与上传图片，点了立刻可见 */
  const pickGlyph = (id: string) => {
    const rest: ProjectAppearance = { ...appearance };
    delete rest.avatar;
    delete rest.image;
    patch({ ...rest, glyph: id });
  };
  const pickAvatar = (id: string) => {
    const rest: ProjectAppearance = { ...appearance };
    delete rest.glyph;
    delete rest.image;
    patch({ ...rest, avatar: id });
  };
  /** 两组身份互斥：恢复默认可同时清掉两组（保留颜色/图片） */
  const resetBuiltinIdentity = () => {
    const rest: ProjectAppearance = { ...appearance };
    delete rest.glyph;
    delete rest.avatar;
    patch(Object.keys(rest).length > 0 ? rest : null);
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
  // 上传图片显示时「恢复默认」没有意义（清掉 glyph/avatar 也看不见），
  // 只在真正有内置身份、且图片没盖住时才提供
  const hasBuiltinIdentity = Boolean(
    (appearance?.glyph || appearance?.avatar) && !appearance?.image,
  );
  const colorLocked = Boolean(appearance?.image || appearance?.avatar);
  // 当前用的是自定义 hex（不在预设盘里）→ 彩虹色点显示选中环
  const customColor = Boolean(
    appearance?.color && !PROJECT_MASCOT_COLORS.includes(appearance.color),
  );

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

        {/* 颜色：一行 18px 色点，色点自身即是语义，不再加"颜色"标签。
            上传图片与内置头像使用自己的配色，此时整组压暗锁住，避免"点了没反应" */}
        <div
          className="px-0.5"
          title={
            colorLocked
              ? "上传图片与内置头像使用自己的配色，颜色只作用于吉祥物"
              : undefined
          }
        >
          <div
            role="group"
            aria-label="图标颜色"
            aria-disabled={colorLocked}
            className={cn(
              "flex flex-wrap items-center gap-2",
              colorLocked && "pointer-events-none opacity-40",
            )}
          >
            {/* 默认（主题色）：对角分割表示"没有指定颜色"，与设置页强调色同款 */}
            <button
              type="button"
              title="默认（跟随主题）"
              aria-label="默认（跟随主题）"
              aria-pressed={!appearance?.color}
              disabled={colorLocked}
              onClick={() => clearField("color")}
              className={cn(SWATCH_BASE, !appearance?.color && SWATCH_ON)}
              style={{
                background:
                  "linear-gradient(135deg, var(--color-foreground) 50%, var(--color-muted-foreground) 50%)",
              }}
            />
            {PROJECT_MASCOT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                aria-label={color}
                aria-pressed={appearance?.color === color}
                disabled={colorLocked}
                onClick={() => patch({ ...appearance, color })}
                className={cn(
                  SWATCH_BASE,
                  appearance?.color === color && SWATCH_ON,
                )}
                style={{ backgroundColor: color }}
              />
            ))}
            {/* 自定义颜色：与主题设置的强调色选择器同款——彩虹入口 + 取色面板 */}
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    title="自定义颜色"
                    aria-label="自定义颜色"
                    aria-pressed={customColor}
                    disabled={colorLocked}
                    className={cn(SWATCH_BASE, customColor && SWATCH_ON)}
                    style={{
                      // 与主题设置的强调色选择器一致：有自定义色就显示它，
                      // 没有才显示彩虹入口——收起/展开看到的是同一个颜色
                      background:
                        customColor && appearance?.color
                          ? appearance.color
                          : "conic-gradient(from 210deg, #f87171, #fbbf24, #4ade80, #38bdf8, #a78bfa, #f472b6, #f87171)",
                    }}
                  />
                }
              />
              <PopoverContent align="end" className="min-w-64 p-3">
                <div className="text-sm font-medium">自定义颜色</div>
                <p className="text-muted-foreground mt-1 text-xs">
                  任意 hex 颜色，图标线条会按深浅主题自动适配。
                </p>
                <LazyColorField
                  value={appearance?.color ?? "#3b82f6"}
                  overridden={customColor}
                  onChange={(hex) => patch({ ...appearance, color: hex })}
                  onReset={() => clearField("color")}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* 图标：下划线 tabs 切换吉祥物/内置头像（比胶囊分段器更轻，和菜单同一
            语言）；12 / 12 个选项，统一 6 列两整行 */}
        <div className="flex flex-col gap-2 px-0.5">
          <div className="border-border/60 flex items-center gap-4 border-b">
            {(["glyph", "avatar"] as const).map((tab) => {
              const active = iconTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setIconTab(tab)}
                  className={cn(
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring relative flex h-7 items-center text-xs font-medium transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab === "glyph" ? "吉祥物" : "头像"}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-x-0 -bottom-px h-[1.5px] rounded-full transition-colors",
                      active ? "bg-foreground" : "bg-transparent",
                    )}
                  />
                </button>
              );
            })}
            <button
              type="button"
              onClick={resetBuiltinIdentity}
              className={cn(
                "text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ms-auto shrink-0 rounded px-1 pb-0.5 text-2xs transition-colors",
                !hasBuiltinIdentity && "invisible",
              )}
            >
              恢复默认
            </button>
          </div>
          <div
            role="group"
            aria-label={iconTab === "glyph" ? "内置吉祥物" : "内置头像"}
            className={cn(
              "grid grid-cols-6 justify-items-center",
              iconTab === "glyph" ? "gap-1" : "gap-2",
            )}
          >
            {iconTab === "glyph"
              ? PROJECT_MASCOT_GLYPHS.map((glyph) => {
                  const Icon = PROJECT_GLYPH_ICONS[glyph.id];
                  const active = appearance?.glyph === glyph.id;
                  return (
                    <button
                      key={glyph.id}
                      type="button"
                      title={glyph.label}
                      aria-label={glyph.label}
                      aria-pressed={active}
                      onClick={() => pickGlyph(glyph.id)}
                      className={cn(CELL_BASE, active ? CELL_ON : CELL_IDLE)}
                    >
                      {Icon ? (
                        <Icon className="size-[18px]" style={iconTint} />
                      ) : null}
                    </button>
                  );
                })
              : BUILTIN_PROJECT_AVATARS.map((avatar) => {
                  const active = appearance?.avatar === avatar.id;
                  const src = projectAvatarSrc(avatar.id);
                  return (
                    <button
                      key={avatar.id}
                      type="button"
                      title={avatar.label}
                      aria-label={avatar.label}
                      aria-pressed={active}
                      onClick={() => pickAvatar(avatar.id)}
                      className={cn(
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring size-10 shrink-0 overflow-hidden rounded-lg transition-transform hover:scale-105 active:scale-95",
                        active && "outline-2 outline-offset-2 outline-foreground",
                      )}
                    >
                      {src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={src}
                          alt=""
                          draggable={false}
                          className="size-full object-cover"
                        />
                      ) : null}
                    </button>
                  );
                })}
          </div>
        </div>

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
