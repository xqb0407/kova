"use client";

import { useRef, useState, type FC } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { JsonCodeEditor } from "@/components/code/cm-json-editor";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import {
  patchUiPrefs,
  resetAppearance,
  syncWallpaperImage,
  useUiPrefs,
} from "@/lib/settings/ui-prefs";
import {
  parseThemeFile,
  serializeThemeFile,
  themeFileToPatch,
  themeFileName,
} from "@/lib/theme/serialize";
import {
  clearWallpaperImages,
  clearWallpaperSource,
  getWallpaperImage,
  saveWallpaperImage,
} from "@/lib/theme/wallpaper";
import { CopyIcon, DownloadIcon, RotateCcwIcon } from "lucide-react";

/** 剪贴板里塞太大的图片会明显卡顿；超过这个长度就只复制配色 */
const MAX_CLIPBOARD_IMAGE = 1_200_000;

/**
 * 主题 JSON 的导入 / 复制 / 重置。
 * 导入只接受白名单字段（见 lib/theme/serialize），壁纸图随 JSON 一起带。
 */
export const ThemeIo: FC = () => {
  const t = useT();
  const prefs = useUiPrefs();
  const [importOpen, setImportOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyText, setCopyText] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const copyAreaRef = useRef<HTMLTextAreaElement>(null);

  const copy = async () => {
    const image = getWallpaperImage();
    const include = !!image && image.length <= MAX_CLIPBOARD_IMAGE;
    const text = serializeThemeFile(prefs, image, {
      includeWallpaper: include,
    });
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast.success(
        include
          ? t("settings.appearance.themeIo.copyDoneToast")
          : t("settings.appearance.themeIo.copyDoneNoImageToast"),
      );
    } catch {
      setCopyText(text);
      setCopyOpen(true);
    }
  };

  const applyImport = () => {
    const parsed = parseThemeFile(raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const { patch, wallpaper } = themeFileToPatch(parsed.file);
    if (wallpaper.type === "remove") {
      clearWallpaperImages();
      syncWallpaperImage();
      patch.wallpaper = null;
    } else if (wallpaper.type === "replace") {
      if (wallpaper.image) {
        if (!saveWallpaperImage(wallpaper.image)) {
          setError(t("settings.appearance.wallpaperSaveError"));
          return;
        }
        // 导入的只是裁剪后的展示图；清掉旧原图，让「调整构图」回落到这张图，
        // 而不是继续用上一个主题留下的另一张壁纸
        clearWallpaperSource();
      }
      syncWallpaperImage();
      patch.wallpaper = wallpaper.config;
    }
    patchUiPrefs(patch);
    setImportOpen(false);
    setRaw("");
    setError(null);
    toast.success(
      t("settings.appearance.themeIo.importDoneToast", {
        name: themeFileName(parsed.file),
      }),
    );
  };

  const readFile = async (file: File) => {
    try {
      const text = await file.text();
      setRaw(text);
      setError(null);
    } catch {
      setError(t("settings.appearance.themeIo.readFailed"));
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground gap-1.5"
          onClick={() => setResetOpen(true)}
        >
          <RotateCcwIcon className="size-3.5" />
          {t("settings.appearance.themeIo.resetAppearance")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            setError(null);
            // 回填当前主题作为编辑起点：用户直接在现状 JSON 上改再导回。
            // 不带壁纸图——dataURL 动辄几百 KB，编辑器里全是噪音；
            // 想连图分享走「导出主题」。已有内容（比如之前贴了一半）不打扰。
            setRaw((current) =>
              current.trim()
                ? current
                : serializeThemeFile(prefs, null, { includeWallpaper: false }),
            );
            setImportOpen(true);
          }}
        >
          <DownloadIcon className="size-3.5" />
          {t("settings.appearance.themeIo.importBtn")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void copy()}
        >
          <CopyIcon className="size-3.5" />
          {t("settings.appearance.themeIo.copyBtn")}
        </Button>
      </div>

      {/* 导入：粘贴 JSON 或选文件；尺寸对齐设计主题对话框的规范
          （sm:max-w-2xl + 限高滚动），回填的长 JSON 也放得下 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("settings.appearance.themeIo.importTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.appearance.themeIo.importDesc")}
            </DialogDescription>
          </DialogHeader>
          {/* JSON 代码编辑器：高亮 + 语法错误波浪线；语义校验交给导入解析。
              codemirror.css 把 .cm-editor 钉成 100%，height prop 不生效，
              得像 MCP 设置一样用固定高度容器 + h-full 包住：内容长时编辑器
              内部滚动，回填的完整主题 JSON 不会把对话框撑满整屏 */}
          <div className="bg-muted/60 h-[min(44vh,400px)] w-full overflow-hidden rounded-lg border">
            <JsonCodeEditor
              className="h-full w-full"
              height="100%"
              value={raw}
              onChange={(value) => {
                setRaw(value);
                setError(null);
              }}
              placeholder={'{\n  "$schema": "https://raw.githubusercontent.com/xqb0407/kova/main/apps/desktop/public/schemas/kova-theme-1.json",\n  "format": "kova-theme", "version": 1, ...\n}'}
            />
          </div>
          {error && <p className="text-destructive text-[13px] leading-5">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              {t("settings.appearance.themeIo.chooseFile")}
            </Button>
            <span className="text-muted-foreground text-[13px] leading-5">
              {t("settings.appearance.themeIo.formatHint")}
            </span>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              {t("common.action.cancel")}
            </Button>
            <Button disabled={!raw.trim()} onClick={applyImport}>
              {t("settings.appearance.themeIo.importApply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 复制失败兜底：非安全上下文没有 clipboard API */}
      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("settings.appearance.themeIo.copyTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.appearance.themeIo.copyDesc")}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            ref={copyAreaRef}
            value={copyText}
            readOnly
            className="max-h-64 min-h-40 font-mono text-[13px] leading-5"
            onFocus={(event) => event.currentTarget.select()}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                copyAreaRef.current?.focus();
                copyAreaRef.current?.select();
                document.execCommand("copy");
                toast.success(t("settings.appearance.themeIo.copiedToast"));
              }}
            >
              {t("settings.appearance.themeIo.copyAgain")}
            </Button>
            <Button variant="ghost" onClick={() => setCopyOpen(false)}>
              {t("common.action.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置确认 */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.appearance.themeIo.resetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.appearance.themeIo.resetDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setResetOpen(false)}>
              {t("common.action.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setResetOpen(false);
                resetAppearance();
                toast.success(t("settings.appearance.themeIo.resetDone"));
              }}
            >
              {t("settings.appearance.reset")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void readFile(file);
        }}
      />
    </>
  );
};
