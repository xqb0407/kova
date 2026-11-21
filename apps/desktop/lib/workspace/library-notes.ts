"use client";

import { fsErrorText, fsTouch } from "./fs";
import { toast } from "@/components/ui/toast";
import { t } from "@/lib/i18n";

/**
 * 新建笔记：在资料库 dir 下建一条 Markdown（「新笔记.md」，重名自动加序号），
 * 返回新笔记的相对路径（失败 toast 并返回 null）。
 * 笔记就是普通 .md 文件——树里能整理、Finder 里能看到、将来 AI 也能直接读。
 */
export async function createLibraryNote(
  root: string,
  dir: string,
): Promise<string | null> {
  for (let i = 1; i < 200; i++) {
    const name = i === 1 ? "新笔记.md" : `新笔记 ${i}.md`;
    const rel = dir ? `${dir}/${name}` : name;
    const err = await fsTouch(root, rel);
    if (!err) return rel;
    if (err !== "already-exists") {
      toast.error(fsErrorText(err));
      return null;
    }
  }
  toast.error(t("library.common.tooManyNotes"));
  return null;
}