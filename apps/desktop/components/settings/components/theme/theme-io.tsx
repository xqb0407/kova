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
import { toast } from "@/components/ui/toast";
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
          ? "主题已复制到剪贴板"
          : "主题已复制（壁纸图片过大，未包含图片）",
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
          setError("壁纸保存失败：本地存储空间不足");
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
    toast.success(`已导入主题：${themeFileName(parsed.file)}`);
  };

  const readFile = async (file: File) => {
    try {
      const text = await file.text();
      setRaw(text);
      setError(null);
    } catch {
      setError("读取文件失败");
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
          重置外观
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            setError(null);
            setImportOpen(true);
          }}
        >
          <DownloadIcon className="size-3.5" />
          导入
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void copy()}
        >
          <CopyIcon className="size-3.5" />
          复制主题
        </Button>
      </div>

      {/* 导入：粘贴 JSON 或选文件 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>导入主题</DialogTitle>
            <DialogDescription>
              粘贴主题 JSON，或选择之前导出的 .json 文件。导入会覆盖当前配色、
              字体、对话宽度与壁纸设置。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              setError(null);
            }}
            placeholder='{ "format": "kova-theme", "version": 1, ... }'
            className="min-h-48 font-mono text-[13px] leading-5"
            spellCheck={false}
          />
          {error && <p className="text-destructive text-[13px] leading-5">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              选择文件…
            </Button>
            <span className="text-muted-foreground text-[13px] leading-5">
              只接受 kova-theme v1
            </span>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button onClick={applyImport} disabled={!raw.trim()}>
              导入并应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 复制失败兜底：非安全上下文没有 clipboard API */}
      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>复制主题</DialogTitle>
            <DialogDescription>
              当前环境无法直接写入剪贴板，请手动复制下面的 JSON。
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
                toast.success("已复制");
              }}
            >
              再次复制
            </Button>
            <Button variant="ghost" onClick={() => setCopyOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置确认 */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>重置外观？</AlertDialogTitle>
            <AlertDialogDescription>
              会恢复默认主题、字体、对话宽度与对比度，并移除当前壁纸。
              代码高亮与提示音设置不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setResetOpen(false)}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                resetAppearance();
                toast.success("外观已恢复默认");
              }}
            >
              重置
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
