"use client";

import { useEffect, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
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
import { chatSurfaceAspect } from "@/lib/theme/chat-surface";
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

/**
 * 壁纸区：上传 → 裁剪构图 → 存本地；随后可调模糊/遮罩/透明度/生效模式。
 * 图片放 localStorage（见 lib/theme/wallpaper），这里只负责交互与写 prefs。
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
  const aspect = chatSurfaceAspect();
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
          <div
            className="bg-muted border-border/60 relative grid h-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-dashed"
            style={{ width: Math.round(80 * aspect) }}
          >
            {image ? (
              <img
                src={image}
                alt="当前壁纸"
                className="size-full object-cover "
              />
            ) : (
              <ImageIcon className="text-muted-foreground size-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {image ? "已设置聊天壁纸" : "添加一张聊天壁纸"}
            </div>
            <div className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              作为聊天窗口的背景；按聊天窗口比例裁切构图。
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
