"use client";

import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  forgetLibraryNoteBody,
  forgetLibraryNoteTags,
  LIBRARY_DIRECTIVE_TYPE,
  LIBRARY_NOTE_CACHE_MAX_BYTES,
  parseLibraryDirectiveId,
  rememberLibraryNoteBody,
  rememberLibraryNoteTags,
  type ParsedLibraryReference,
} from "@/lib/composer/library-reference";
import { getLibraryRootInfo } from "@/lib/workspace/library-root";
import { fsReadFile } from "@/lib/workspace/fs";
import {
  deriveNoteTitle,
  libraryFileMetaGet,
} from "@/lib/workspace/library-note-meta";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 发送前预取资料库引用的上下文：
 * - 正文：被引用的 `.md`（≤64KB）读进缓存，发送展开时按 8KB/24KB 预算内联；
 * - 标签：从 library_file_meta 重读，随隐藏块交给模型（模型据此知道分类）。
 *
 * 关键：**每次发送都重读**（不再「命中缓存就跳过」）——笔记编辑后必须拿到
 * 最新正文/标签；读失败、超限、或本次不内联的条目要把旧缓存清掉，避免下一次
 * 误用过期内容。正文读取单条消息最多 8 篇，标签最多 16 条。
 */

/** 正文读取上限（超出部分退回路径引用） */
const MAX_BODY_READS = 8;
/** 标签查询上限（覆盖多引用场景；更多引用本身已超出正常使用） */
const MAX_TAG_LOOKUPS = 16;

const isNoteRel = (rel: string): boolean => /\.md$/iu.test(rel);

type CollectedRef = { ref: ParsedLibraryReference; isNote: boolean };

function collectRefs(
  parts: readonly { type: string; text?: string }[],
): Map<string, CollectedRef> {
  const seen = new Map<string, CollectedRef>();
  for (const part of parts) {
    if (part.type !== "text" || !part.text?.includes(":library[")) continue;
    for (const segment of unstable_defaultDirectiveFormatter.parse(part.text)) {
      if (segment.kind === "text") continue;
      if (segment.type !== LIBRARY_DIRECTIVE_TYPE) continue;
      const ref =
        parseLibraryDirectiveId(segment.id) ??
        parseLibraryDirectiveId(segment.label);
      if (!ref) continue;
      if (!seen.has(ref.absPath)) {
        seen.set(ref.absPath, { ref, isNote: isNoteRel(ref.rel) });
      }
    }
  }
  return seen;
}

/** 发送前调用（ThreadController 的发送汇聚点）：刷新正文与标签缓存 */
export async function prefetchLibraryNoteBodies(
  parts: readonly { type: string; text?: string }[],
): Promise<void> {
  const root = getLibraryRootInfo()?.root ?? null;
  if (!isDesktop() || !root) return;
  const all = collectRefs(parts);
  if (all.size === 0) return;

  const entries = [...all.entries()];
  const tagEntries = entries.slice(0, MAX_TAG_LOOKUPS);
  const bodyEntries = entries
    .filter(([, value]) => value.isNote)
    .slice(0, MAX_BODY_READS);
  const tagSet = new Set(tagEntries.map(([absPath]) => absPath));
  const bodySet = new Set(bodyEntries.map(([absPath]) => absPath));

  // 本次不刷新的条目：清掉旧缓存，避免内联过期正文/旧标签
  for (const [absPath, value] of entries) {
    if (!value.isNote || !bodySet.has(absPath)) {
      forgetLibraryNoteBody(absPath);
    }
    if (!tagSet.has(absPath)) forgetLibraryNoteTags(absPath);
  }

  await Promise.all([
    ...tagEntries.map(async ([absPath, { ref }]) => {
      try {
        const meta = await libraryFileMetaGet(root, ref.rel);
        if (meta && !meta.missing && meta.tags.length > 0) {
          rememberLibraryNoteTags(absPath, meta.tags);
        } else {
          forgetLibraryNoteTags(absPath);
        }
      } catch {
        forgetLibraryNoteTags(absPath);
      }
    }),
    ...bodyEntries.map(async ([absPath, { ref }]) => {
      const file = await fsReadFile(root, ref.rel);
      if (!file || file.binary || file.truncated) {
        forgetLibraryNoteBody(absPath);
        return;
      }
      const body = file.content;
      // 缓存允许到 64KB（选区切片需要原文）；真正内联时再按单篇/总预算裁剪
      if (new TextEncoder().encode(body).length > LIBRARY_NOTE_CACHE_MAX_BYTES) {
        forgetLibraryNoteBody(absPath);
        return;
      }
      rememberLibraryNoteBody(absPath, deriveNoteTitle(body, ref.rel), body);
    }),
  ]);
}
