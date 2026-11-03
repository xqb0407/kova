"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  isDarkMode,
  patchUiPrefs,
  syncWallpaperImage,
  useUiPrefs,
  type WallpaperConfig,
  type WallpaperMode,
} from "@/lib/settings/ui-prefs";
import {
  clearWallpaperImages,
  dataUrlToBitmap,
  fileToBitmap,
  getWallpaperSource,
  saveWallpaperImage,
  saveWallpaperSource,
  useWallpaperImage,
} from "@/lib/theme/wallpaper";
import { ImageIcon } from "lucide-react";
import { windowSurfaceAspect } from "@/lib/theme/window-surface";
import { wallpaperVeil } from "@/lib/theme/palette";
import { cn } from "@/lib/utils";
import { SliderField } from "./slider-field";
import {
  WallpaperCropDialog,
  type WallpaperCropResult,
} from "./wallpaper-crop-dialog";

const DEFAULT_WALLPAPER: WallpaperConfig = {
  enabled: true,
  opacity: 100,
  blur: 0,
  dim: 20,
  mode: "both",
};

const MODE_OPTIONS: { value: WallpaperMode; label: string }[] = [
  { value: "both", label: "两模式" },
  { value: "light", label: "仅浅色" },
  { value: "dark", label: "仅深色" },
];

/** 预览块宽度；高度按窗口比例算，再夹在一个可用区间里 */
const PREVIEW_WIDTH = 224;
const PREVIEW_MIN_HEIGHT = 112;
const PREVIEW_MAX_HEIGHT = 168;

type WallpaperPreviewProps = {
  image: string | null;
  config: WallpaperConfig;
  isDark: boolean;
  aspect: number;
};

/**
 * 壁纸效果预览：按真实叠层（窗格底色 → 底图 → 遮罩 → 薄纱）缩进一块小窗，
 * 左边示意侧栏、右边示意会话区，方便看文字压在壁纸上的可读性。
 *
 * 模糊按「预览宽度 / 窗口宽度」等比缩放——40px 的真实模糊直接套在 224px 的
 * 预览里会糊成一团，不再代表实际观感。
 */
function WallpaperPreview({
  image,
  config,
  isDark,
  aspect,
}: WallpaperPreviewProps) {
  const modeActive =
    config.mode === "both" || config.mode === (isDark ? "dark" : "light");
  const active = !!image && config.enabled && modeActive;
  const height = Math.min(
    PREVIEW_MAX_HEIGHT,
    Math.max(PREVIEW_MIN_HEIGHT, Math.round(PREVIEW_WIDTH / aspect)),
  );
  const viewportWidth =
    typeof window === "undefined" ? 1440 : window.innerWidth;
  const previewBlur =
    config.blur * (PREVIEW_WIDTH / Math.max(1, viewportWidth));
  const veil = wallpaperVeil(config.opacity);
  const inactiveLabel = !image
    ? null
    : !config.enabled
      ? "已关闭"
      : !modeActive
        ? "当前模式不生效"
        : null;

  return (
    <div
      role="img"
      aria-label="壁纸效果预览"
      className={cn(
        "bg-background border-border/60 relative shrink-0 overflow-hidden rounded-lg border shadow-sm",
        !image && "border-dashed",
      )}
      style={{ width: PREVIEW_WIDTH, height }}
    >
      {/* 壁纸关闭/低强度时透出的窗格底色：侧栏比会话卡略沉一档 */}
      <div className="absolute inset-0 flex">
        <div className="bg-muted/55 w-[24%]" />
        <div className="bg-background flex-1" />
      </div>
      {active && image ? (
        <>
          <img
            src={image}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute inset-0 size-full scale-105 object-cover"
            style={{
              opacity: config.opacity / 100,
              filter: `blur(${previewBlur.toFixed(1)}px)`,
            }}
          />
          {/* 与 globals.css 的 ::after 同序：薄纱在下，压暗层在上 */}
          <div
            className="absolute inset-0"
            style={{
              background: `color-mix(in oklab, var(--background) ${veil}, transparent)`,
            }}
          />
          <div
            className="absolute inset-0"
            style={{ background: `rgb(0 0 0 / ${config.dim / 100})` }}
          />
        </>
      ) : null}
      {image ? (
        <WallpaperPreviewMock />
      ) : (
        <div className="text-muted-foreground absolute inset-0 grid place-items-center">
          <ImageIcon className="size-5" />
        </div>
      )}
      {inactiveLabel ? (
        <span className="bg-background/80 text-muted-foreground border-border/60 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap backdrop-blur-sm">
          {inactiveLabel}
        </span>
      ) : image ? (
        <span className="bg-background/55 text-muted-foreground absolute top-1.5 right-1.5 rounded px-1.5 py-0.5 text-2xs font-medium backdrop-blur-sm">
          预览
        </span>
      ) : null}
    </div>
  );
}

/** 预览里的示意界面：左侧栏 + 会话区，只画线条和气泡，不承载真实内容 */
function WallpaperPreviewMock() {
  return (
    <div aria-hidden className="absolute inset-0 flex">
      <div className="border-foreground/10 flex w-[24%] flex-col gap-1 border-r p-1.5">
        <div className="bg-foreground/40 mb-0.5 size-1.5 rounded-full" />
        <div className="bg-foreground/30 h-1 w-3/4 rounded-full" />
        <div className="bg-foreground/20 h-1 w-2/3 rounded-full" />
        <div className="bg-foreground/20 h-1 w-4/5 rounded-full" />
        <div className="bg-foreground/20 h-1 w-3/5 rounded-full" />
        <div className="bg-foreground/20 h-1 w-2/3 rounded-full" />
        <div className="mt-auto flex flex-col gap-1">
          <div className="bg-foreground/20 h-1 w-1/2 rounded-full" />
          <div className="bg-foreground/20 h-1 w-1/3 rounded-full" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 会话顶栏：和真实 Header 一样用一道很淡的 border-b 与正文分开 */}
        <div className="border-foreground/10 flex h-5 shrink-0 items-center border-b px-2">
          <div className="bg-foreground/40 h-1.5 w-2/5 rounded-full" />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-2">
          <div className="bg-foreground/15 mt-0.5 ml-auto h-3.5 w-1/2 rounded-md" />
          <div className="bg-foreground/25 h-1 w-4/5 rounded-full" />
          <div className="bg-foreground/25 h-1 w-3/5 rounded-full" />
          <div className="bg-foreground/10 h-5 w-full rounded-md" />
          <div className="bg-foreground/25 h-1 w-3/4 rounded-full" />
          <div className="border-foreground/10 bg-background/50 mt-auto h-4 w-full rounded-md border" />
        </div>
      </div>
    </div>
  );
}

/**
 * 壁纸区：上传 → 按窗口比例裁剪构图 → 存本地；随后可调模糊/遮罩/透明度/
 * 生效模式。图片放 localStorage（见 lib/theme/wallpaper），这里只负责交互
 * 与写 prefs。
 */
export const WallpaperSection: FC = () => {
  const prefs = useUiPrefs();
  const config = prefs.wallpaper ?? DEFAULT_WALLPAPER;
  const storedImage = useWallpaperImage();
  // 服务端渲染时没有 localStorage；挂载后再显示图片，保证首帧 DOM 与服务端一致。
  // 否则壁纸缩略图会在水合时造成 img ↔ 占位图不一致，React 会整树重建。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const image = mounted ? storedImage : null;
  const aspect = windowSurfaceAspect();
  const isDark = isDarkMode(prefs);
  const [crop, setCrop] = useState<{ bitmap: ImageBitmap; url: string } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const closeCrop = () => {
    setCrop((current) => {
      if (current?.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
      current?.bitmap.close?.();
      return null;
    });
  };

  const patchWallpaper = (patch: Partial<WallpaperConfig>) => {
    patchUiPrefs({ wallpaper: { ...config, ...patch } });
  };

  const setWallpaperPrefs = (next: WallpaperConfig) => {
    patchUiPrefs({ wallpaper: next });
  };

  const onPickFile = async (file: File) => {
    try {
      const bitmap = await fileToBitmap(file);
      setCrop({ bitmap, url: URL.createObjectURL(file) });
    } catch {
      toast.error("无法读取这张图片，请换一张重试");
    }
  };

  const onEditCrop = async () => {
    const source = getWallpaperSource() ?? image;
    if (!source) return;
    try {
      const bitmap = await dataUrlToBitmap(source);
      setCrop({ bitmap, url: source });
    } catch {
      toast.error("壁纸原图不可用，请重新选择图片");
    }
  };

  const onCropApply = ({ display, source }: WallpaperCropResult) => {
    if (!saveWallpaperImage(display)) {
      toast.error("壁纸保存失败：本地存储空间不足");
      closeCrop();
      return;
    }
    // 原图只用于再次构图，存不下不算失败
    saveWallpaperSource(source);
    syncWallpaperImage();
    setWallpaperPrefs({ ...config, enabled: true });
    closeCrop();
    toast.success("壁纸已更新");
  };

  const remove = () => {
    clearWallpaperImages();
    syncWallpaperImage();
    patchUiPrefs({ wallpaper: null });
    toast.success("壁纸已移除");
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">壁纸</h2>
      <div className="bg-muted/50 rounded-2xl p-3">
        <div className="flex items-center gap-4">
          <WallpaperPreview
            image={image}
            config={config}
            isDark={isDark}
            aspect={aspect}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {image ? "已设置窗口壁纸" : "添加一张窗口壁纸"}
            </div>
            <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              作为整个应用窗口的背景（会话区与侧栏共用）；按窗口比例裁切构图。
              壁纸只保存在本机，各客户端可分别设置。
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              {image ? "更换壁纸" : "添加壁纸"}
            </Button>
            {image && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void onEditCrop()}
              >
                调整构图
              </Button>
            )}
            {image && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={remove}
              >
                移除
              </Button>
            )}
          </div>
        </div>

        {image && (
          <div className="border-border/60 mt-3 flex flex-col gap-0.5 border-t pt-2">
            <SettingRow label="启用壁纸" desc="关闭后保留图片与参数，随时再开">
              <Switch
                checked={config.enabled}
                onCheckedChange={(checked) =>
                  patchWallpaper({ enabled: checked })
                }
              />
            </SettingRow>
            <SettingRow label="模糊" desc="让壁纸退到内容后面，取值 0–40px">
              <SliderField
                min={0}
                max={40}
                value={config.blur}
                onChange={(blur) => patchWallpaper({ blur })}
                minLabel="清晰"
                maxLabel="柔和"
                formatValue={(value) => `${value}px`}
              />
            </SettingRow>
            <SettingRow label="遮罩" desc="压暗壁纸，提升文字可读性">
              <SliderField
                min={0}
                max={80}
                value={config.dim}
                onChange={(dim) => patchWallpaper({ dim })}
                minLabel="无"
                maxLabel="浓"
                formatValue={(value) => `${value}%`}
              />
            </SettingRow>
            <SettingRow label="强度" desc="壁纸本身的显示强度">
              <SliderField
                min={20}
                max={100}
                value={config.opacity}
                onChange={(opacity) => patchWallpaper({ opacity })}
                minLabel="淡"
                maxLabel="实"
                formatValue={(value) => `${value}%`}
              />
            </SettingRow>
            <SettingRow label="生效模式" desc="只在一个明暗模式下显示壁纸">
              <Segmented
                value={config.mode}
                options={MODE_OPTIONS}
                onChange={(mode) => patchWallpaper({ mode })}
              />
            </SettingRow>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onPickFile(file);
        }}
      />

      <WallpaperCropDialog
        open={!!crop}
        url={crop?.url ?? null}
        bitmap={crop?.bitmap ?? null}
        onOpenChange={(open) => {
          if (!open) closeCrop();
        }}
        onApply={onCropApply}
      />
    </section>
  );
};
