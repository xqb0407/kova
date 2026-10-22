"use client";

import { invoke } from "@/desktop-bridge/core";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 资料库文件元数据（标题 / 标签索引）的渲染层封装。
 *
 * 只存标题与标签、不存正文——文件本身是唯一事实源。用途：
 * - 「引用到对话」的 @ 选择器按标题/标签搜索；
 * - 查看器的标签编辑行（笔记的 #tag）。
 *
 * `missing` 由主进程在 list/get 时逐行 stat 得出：外部删除（Finder/同步盘）
 * 只标记不删行，文件恢复后标签自动回来；应用内永久删除才显式 delete。
 */

export interface LibraryFileMeta {
  rel: string;
  title: string;
  tags: string[];
  /** 主进程 stat 判定：文件当前不存在 */
  missing: boolean;
  updatedAt: number;
}

export interface LibraryFileMetaList {
  rootMissing: boolean;
  entries: LibraryFileMeta[];
}

export interface LibraryFileMetaSingle {
  title: string;
  tags: string[];
  missing: boolean;
  updatedAt: number;
}

export function libraryFileMetaList(
  root: string,
): Promise<LibraryFileMetaList> {
  return invoke<LibraryFileMetaList>("library_file_meta_list", { root });
}

/** 单条查询；无记录返回 null（tag 编辑行据此区分「没打过标签」与「文件没了」） */
export function libraryFileMetaGet(
  root: string,
  rel: string,
): Promise<LibraryFileMetaSingle | null> {
  return invoke<LibraryFileMetaSingle | null>("library_file_meta_get", {
    root,
    rel,
  });
}

/** 局部更新：title / tags 只在显式传入（非 undefined）时覆盖 */
export function libraryFileMetaSet(
  root: string,
  rel: string,
  patch: { title?: string; tags?: string[] },
): Promise<null> {
  return invoke<null>("library_file_meta_set", {
    root,
    rel,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
  });
}

/** 应用内永久删除后清理元数据；目录连带其子树（rel/ 前缀） */
export function libraryFileMetaDelete(
  root: string,
  rels: string[],
  isDir = false,
): Promise<null> {
  return invoke<null>("library_file_meta_delete", { root, rels, isDir });
}

/** 重命名/移动后把元数据行迁到新 rel（标签跟着文件走；目录按前缀迁移子树） */
export function libraryFileMetaMove(
  root: string,
  from: string,
  to: string,
  isDir = false,
): Promise<null> {
  return invoke<null>("library_file_meta_move", { root, from, to, isDir });
}

/** 引用存在性校验（草稿守卫用）：返回缺失的 id 列表 */
export function libraryRefsCheck(
  refs: { id: string; rel: string; absPath: string }[],
): Promise<{ missing: string[] }> {
  return invoke<{ missing: string[] }>("library_refs_check", { refs });
}

/** 网页端统一降级：所有读取返回空态 */
export function libraryFileMetaListSafe(
  root: string | null,
): Promise<LibraryFileMetaList> {
  if (!isDesktop() || !root) {
    return Promise.resolve({ rootMissing: false, entries: [] });
  }
  return libraryFileMetaList(root).catch(() => ({
    rootMissing: false,
    entries: [],
  }));
}

/* ------------------------------ 标签归一化 ------------------------------ */

/** 单条标签长度 / 单文件标签数上限 */
export const MAX_NOTE_TAG_LENGTH = 48;
export const MAX_NOTE_TAGS = 20;

/** 规范化标签：去 #（含其后空格）、空格转 -、折叠/去首尾 -、小写、截断、去重、限数。
 *  `# 123` 曾因「先剥 # 再把空格转 -」产出 `-123`，与 `123` 视觉上几乎一样却
 *  是两个标签——这里把首尾连字符也清掉，两条会归并成同一个。 */
export function normalizeNoteTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const input of tags) {
    const tag = input
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, MAX_NOTE_TAG_LENGTH)
      .replace(/-+$/g, "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length === MAX_NOTE_TAGS) break;
  }
  return normalized;
}

/* ------------------------------ 笔记标题 ------------------------------ */

const MAX_TITLE = 200;

/** 去掉常见 Markdown 修饰（图片/链接/强调），用于标题派生 */
function unwrapMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** 笔记标题：第一个 Markdown 标题 → 首行正文 → 兜底名（文件名）。
 *  打开笔记/编辑标签时惰性写入元数据，不要求全库预扫。 */
export function deriveNoteTitle(text: string, fallbackName: string): string {
  const heading = text.match(/^\s{0,3}#{1,6}\s+(.+)$/m);
  if (heading) {
    const title = unwrapMarkdown(heading[1]).slice(0, MAX_TITLE);
    if (title) return title;
  }
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;
    const title = unwrapMarkdown(trimmed).slice(0, MAX_TITLE);
    if (title) return title;
  }
  return fallbackName.replace(/\.(md|markdown)$/iu, "").trim() || "Untitled";
}
