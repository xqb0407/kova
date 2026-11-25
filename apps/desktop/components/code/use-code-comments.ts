"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  getCodeCommentsVersion,
  listCodeComments,
  subscribeCodeComments,
  type CodeCommentEntry,
} from "@/lib/composer/code-comment-store";

/** 当前文件下尚未发送的评论（跟随 store 版本响应式更新） */
export function useCodeComments(
  path: string | undefined,
): readonly CodeCommentEntry[] {
  const version = useSyncExternalStore(
    subscribeCodeComments,
    getCodeCommentsVersion,
    getCodeCommentsVersion,
  );
  return useMemo(() => listCodeComments(path), [path, version]);
}
