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
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  PlusIcon,
  Trash2Icon,
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
import { ProjectBadge, PROJECT_GLYPH_ICONS } from "@/components/ui/project-badge";
import {
  PROJECT_MASCOT_COLORS,
  PROJECT_MASCOT_GLYPHS,
  PROJECT_PIXEL_MASCOTS,
  hasProjectAppearance,
  projectAppearanceFor,
  setProjectAppearance,
  useProjectAppearancesVersion,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";
import { PixelMascot } from "@/components/ui/pixel-mascot";

/** 上传源文件上限（缩到 64×64 之前），超限直接劝退而不是缩完再报 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** 落库头像边长：64 足够在 18px 徽章 + 2x 屏下清晰，PNG 正常 5–20KB */
const LOGO_SIZE = 64;

/** 色块 / 吉祥物单元共用的方格：统一 28px 圆形 + 主题描边，同一行 8 个——
 *  两组行容量一致，换行后天然对齐成列，不会一列 8 个、一列 10 个地参差 */
const CELL =
  "size-7 shrink-0 rounded-full border transition hover:scale-110 active:scale-90";
/** 选中态用外描边（outline 不占布局，选中不会把整行挤动）；与设置页强调色
 *  选择器同款，两处选中反馈因此长得一样 */
const CELL_ON = "scale-110 outline-1 outline-offset-1 cursor-pointer active:scale-90 outline-primary";
const GLYPH_CELL = cn(CELL, "grid place-items-center hover:bg-accent cursor-pointer");

/** 卡片尾部的操作行：幽灵按钮铺满卡片宽、左对齐（与弹层其它条目同款观感） */
// 与侧栏「…」/右键菜单同一版式：36px 行、px-3、纯文字（不带行内图标）
const ACTION_ROW = "h-9 w-full justify-start rounded-md px-3 text-sm font-normal";

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
 * 项目设置卡（紧贴项目行的 Popover）：图标（上传 / 吉祥物 / 颜色）与项目操作
 * 收在同一个弹层里——与参考项目的"项目设置卡"同款形态，但不是另开模态：
 * 弹层就挂在行右侧的「⋯」上，选颜色/吉祥物时不关闭，侧边栏实时跟着变。
 *
 * 颜色语义：**给图标上色**——吉祥物图标用它涂色（底色取同色 13% 做柔和衬底）；
 * 没选吉祥物时套在默认文件夹图标上。
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

  /** 图标着色：选了主色就套在图标上（与侧栏徽章同义） */
  const iconTint = appearance?.color ? { color: appearance.color } : undefined;

  const desktop = isDesktop();
  // 项目目录是本机配置：网关侧拒绝远程写，UI 同步隐藏写入口（只读展示仍可用）
  const canManageDirs = desktop && !isRemoteMode();
  const missingDirs = new Set(dirs?.missing ?? []);

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
        className="w-80 gap-3"
        aria-label={`${label} 项目设置`}
      >
        {/* 图标 + 上传：预览就是侧栏最终效果（放大一档方便看清） */}
        <div className="flex items-center gap-3">
          <div className="bg-muted grid size-10 shrink-0 place-items-center rounded-xl">
            {hasProjectAppearance(appearance) ? (
              <ProjectBadge
                appearance={appearance}
                className="size-7 rounded-lg [&>svg]:size-5"
              />
            ) : (
              <FolderIcon
                className="text-muted-foreground size-5"
                style={iconTint}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className={"active:not-aria-[haspopup]:translate-y-0"}
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadIcon />
                {uploading ? "处理中…" : appearance?.image ? "换一张" : "上传图片"}
              </Button>
              {appearance?.image ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => patch(withoutImage())}
                >
                  <Trash2Icon />
                  移除
                </Button>
              ) : null}
            </div>
            <span className="text-muted-foreground text-xs leading-4">
              ≤2MB，自动裁方并缩到 64×64
            </span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => void onPickFile(e.target.files?.[0])}
          />
        </div>

        {/* 主色：给图标上色 */}
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs font-medium">
            颜色（给图标上色）
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {/* 默认（主题色）：对角分割表示"没有指定颜色"，与设置页强调色同款，
                不再是块什么都没有的空白块 */}
            <button
              type="button"
              title="默认（主题色）"
              aria-label="默认（主题色）"
              onClick={() => clearField("color")}
              className={cn(CELL, !appearance?.color && CELL_ON)}
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
                onClick={() => patch({ ...appearance, color })}
                className={cn(CELL, appearance?.color === color && CELL_ON)}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        {/* 吉祥物：默认回退文件夹图标（同样跟随主色） */}
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-xs font-medium">
            吉祥物
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              title="默认（文件夹图标）"
              aria-label="默认（文件夹图标）"
              onClick={() => {
                // 两组吉祥物互斥：默认格把两组一起清掉
                const rest: ProjectAppearance = { ...appearance };
                delete rest.glyph;
                delete rest.pixel;
                patch(Object.keys(rest).length > 0 ? rest : null);
              }}
              className={cn(
                GLYPH_CELL,
                !appearance?.glyph && !appearance?.pixel && CELL_ON,
              )}
            >
              <FolderIcon
                className="text-muted-foreground size-4"
                style={iconTint}
              />
            </button>
            {PROJECT_MASCOT_GLYPHS.map((glyph) => {
              const Icon = PROJECT_GLYPH_ICONS[glyph.id];
              return (
                <button
                  key={glyph.id}
                  type="button"
                  title={glyph.label}
                  aria-label={glyph.label}
                  onClick={() => {
                    const rest: ProjectAppearance = { ...appearance };
                    delete rest.pixel;
                    patch({ ...rest, glyph: glyph.id });
                  }}
                  className={cn(
                    GLYPH_CELL,
                    appearance?.glyph === glyph.id && CELL_ON,
                  )}
                >
                  {Icon ? <Icon className="size-4" style={iconTint} /> : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* 像素吉祥物（自绘 8×8 精灵）：与矢量组互斥，选它即清矢量组。
            8 个一格行，和上一组"一行 8 个"的容量一致，换行后天然对齐成列 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs font-medium">
            像素（8×8）
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {PROJECT_PIXEL_MASCOTS.map((mascot) => (
              <button
                key={mascot.id}
                type="button"
                title={mascot.label}
                aria-label={mascot.label}
                onClick={() => {
                  const rest: ProjectAppearance = { ...appearance };
                  delete rest.glyph;
                  patch({ ...rest, pixel: mascot.id });
                }}
                className={cn(
                  GLYPH_CELL,
                  appearance?.pixel === mascot.id && CELL_ON,
                )}
              >
                <span style={iconTint} className="inline-flex">
                  <PixelMascot id={mascot.id} className="size-4" />
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 项目虚拟目录：主目录 + 附加代码工程根。附加根会进入项目内所有对话的
            系统提示词/技能发现/文件检索与 workspace-write 写权限 */}
        <div className="-mx-3 border-t border-border" />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs font-medium">
              项目目录（多个代码工程）
            </span>
            {canManageDirs ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                disabled={dirsBusy}
                onClick={() => void addDir()}
              >
                {dirsBusy ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <PlusIcon className="size-3.5" />
                )}
                添加
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            {(dirs?.roots ?? [{ path: cwd, label }]).map((root, index) => {
              const isMain = index === 0;
              const isMissing = missingDirs.has(root.path);
              return (
                <div
                  key={root.path}
                  className="group/dir flex items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/60"
                >
                  {isMissing ? (
                    <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <FolderOpenIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">
                        {isMain ? label : root.label}
                      </span>
                      {isMain ? (
                        <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                          主目录
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="truncate text-[11px] leading-4 text-muted-foreground"
                      title={root.path}
                    >
                      {root.path}
                    </div>
                    {isMissing ? (
                      <div className="text-[11px] leading-4 text-amber-600 dark:text-amber-400">
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
                      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/dir:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] leading-4 text-muted-foreground">
            附加目录会作为外部上下文提供给该项目所有对话（AGENTS.md、技能、文件检索）。
          </p>
          {dirsError ? (
            <p className="text-[11px] leading-4 text-destructive">{dirsError}</p>
          ) : null}
        </div>

        {/* 项目操作：与设置同卡（参考项目同款——操作就是这张卡的尾巴）。
            位置/复制只在桌面壳出现：都要落到系统文件管理器或剪贴板 */}
        {desktop ? (
          <>
            <div className="-mx-3 border-t border-border" />
            <div className="flex flex-col gap-0.5">
              <Button
                variant="ghost"
                className={ACTION_ROW}
                onClick={() => void revealProject()}
              >
                {revealLabel()}
              </Button>
              <Button
                variant="ghost"
                className={ACTION_ROW}
                onClick={() => void copyProjectPath()}
              >
                复制路径
              </Button>
            </div>
          </>
        ) : null}

        <div className="-mx-3 border-t border-border" />
        {/* 归档：破坏性动作用单独分隔收在卡片最末（与普通条目混排会误点） */}
        <Button
          variant="ghost"
          className={ACTION_ROW}
          onClick={() => {
            setOpen(false);
            onArchive();
          }}
        >
          归档项目
        </Button>
      </PopoverContent>
    </Popover>
  );
};
