"use client";

/**
 * 富文本编辑器里的图片落库：
 *
 * - 选图 → libraryImport 拷进「笔记目录/assets/」，Markdown 里写相对路径；
 * - 粘贴/拖入 → File.arrayBuffer() 读字节，fsWriteFileBase64 落盘；
 * - 两条路都返回相对笔记目录的 src（`assets/x.png`），笔记移动/整个库
 *   搬走都能继续解析。
 *
 * 只在桌面壳可用（资料库本身依赖 fs_*）；Web/dev-preview 用 data URL。
 */

import { open as openDialog } from "@/desktop-bridge/plugin-dialog";
import { toast } from "@/components/ui/toast";
import { t } from "@/lib/i18n";
import { fsRename, fsWriteFileBase64 } from "@/lib/workspace/fs";
import { libraryImport } from "@/lib/workspace/library-files";

/** 图片选择器扩展名（与 fs 读取支持的图片类型对齐） */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
];

/** 单张图片上限：超过不落库，避免把资料库撑爆 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface InsertedImage {
  /** 相对笔记目录的路径（写进 Markdown） */
  src: string;
  alt: string;
}

/** 笔记所在目录的 assets 子目录（库根相对） */
export function assetsDirFor(noteRel: string): string {
  const slash = noteRel.lastIndexOf("/");
  const dir = slash >= 0 ? noteRel.slice(0, slash) : "";
  return dir ? `${dir}/assets` : "assets";
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

function imageExt(file: File): string {
  const fromName = extOf(file.name);
  if (IMAGE_EXTENSIONS.includes(fromName)) return fromName;
  return MIME_EXT[file.type] ?? "png";
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.includes(extOf(file.name));
}

/** alt 会原样进 Markdown 的 `![...]`：去掉方括号/换行，避免破坏语法 */
function safeAltText(name: string): string {
  return name.replace(/[[\]\r\n]+/g, " ").trim() || "image";
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 从系统对话框选一张图并导入当前笔记的 assets/ */
export async function pickImageForNote(
  cwd: string,
  noteRel: string,
): Promise<InsertedImage | null> {
  let picked: string | string[] | null = null;
  try {
    picked = await openDialog({
      multiple: false,
      title: t("library.editor.image.pickTitle"),
      filters: [{ name: t("library.editor.image.filterName"), extensions: IMAGE_EXTENSIONS }],
    });
  } catch {
    return null;
  }
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return null;

  const dir = assetsDirFor(noteRel);
  try {
    const result = await libraryImport(dir, [path]);
    const imported = result.imported[0];
    if (!imported) {
      toast.error(
        t("library.editor.image.uploadFailed", {
          error:
            result.failed[0]?.error ?? t("library.actions.unknownError"),
        }),
      );
      return null;
    }
    // 原文件名可能带空格/括号/中文：Markdown 的 `](...)` 会被截断，
    // 统一改成不含保留字符的安全名；alt 保留原名便于识别
    const ext = extOf(imported) || extOf(path) || "png";
    const safeName = `image-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}.${ext}`;
    const renameErr = await fsRename(cwd, `${dir}/${imported}`, safeName);
    const name = renameErr ? imported : safeName;
    return { src: `assets/${name}`, alt: safeAltText(imported) };
  } catch (err) {
    toast.error(
      t("library.editor.image.uploadFailed", { error: String(err) }),
    );
    return null;
  }
}

/**
 * 粘贴/拖入的图片写进 assets/；返回成功落库的图片（失败的已 toast）。
 * 同一批用时间戳 + 序号命名，避免覆盖同名截图。
 */
export async function uploadImageFiles(
  cwd: string,
  noteRel: string,
  files: readonly File[],
): Promise<InsertedImage[]> {
  const images = files.filter(isImageFile);
  if (images.length === 0) return [];
  const dir = assetsDirFor(noteRel);
  const stamp = Date.now();
  const out: InsertedImage[] = [];

  for (let i = 0; i < images.length; i += 1) {
    const file = images[i]!;
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error(t("library.editor.image.tooLarge", { name: file.name }));
      continue;
    }
    const ext = imageExt(file);
    const name = `pasted-${stamp}-${i + 1}.${ext}`;
    try {
      const base64 = toBase64(await file.arrayBuffer());
      const err = await fsWriteFileBase64(cwd, `${dir}/${name}`, base64);
      if (err) {
        toast.error(
          t("library.editor.image.uploadFailed", { error: err }),
        );
        continue;
      }
      out.push({
        src: `assets/${name}`,
        alt: safeAltText(
          file.name && !/^image\./i.test(file.name) ? file.name : name,
        ),
      });
    } catch (err) {
      toast.error(
        t("library.editor.image.uploadFailed", { error: String(err) }),
      );
    }
  }
  return out;
}
