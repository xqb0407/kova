"use client";

import { fsErrorText, fsTouch, fsWriteFile } from "./fs";
import {
  createNativeNote,
  serializeNativeNote,
} from "@/lib/notes/native-note";
import { toast } from "@/components/ui/toast";
import { t } from "@/lib/i18n";

/**
 * 新建笔记：在资料库 dir 下建一个原生 `.knote`（「新笔记.knote」，重名自动
 * 加序号），返回相对路径（失败 toast 并返回 null）。
 * 先用 fs_touch 的 O_EXCL 抢占文件名，再写入 envelope；树/Finder 都能看到。
 */
export async function createLibraryNote(
  root: string,
  dir: string,
): Promise<string | null> {
  for (let i = 1; i < 200; i++) {
    const base = i === 1 ? "新笔记" : `新笔记 ${i}`;
    const rel = dir ? `${dir}/${base}.knote` : `${base}.knote`;
    const err = await fsTouch(root, rel);
    if (!err) {
      const note = createNativeNote({ title: base });
      const writeErr = await fsWriteFile(root, rel, serializeNativeNote(note));
      if (writeErr) {
        toast.error(fsErrorText(writeErr));
        return null;
      }
      return rel;
    }
    if (err !== "already-exists") {
      toast.error(fsErrorText(err));
      return null;
    }
  }
  toast.error(t("library.common.tooManyNotes"));
  return null;
}