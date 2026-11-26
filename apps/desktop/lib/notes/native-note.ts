"use client";

/**
 * 原生笔记文件（`.knote`）的格式与校验。
 *
 * 一篇笔记一个 JSON 文件，Plate 的 Value 直接落盘；Markdown 只作为
 * 兼容导出/AI 检索用的缓存字段，不再参与编辑器状态往返。
 */

import type { Descendant } from "platejs";

export const NATIVE_NOTE_EXT = ".knote";
export const NATIVE_NOTE_FORMAT = "kova-note";
export const NATIVE_NOTE_VERSION = 1;

export interface NativeNoteFile {
  format: typeof NATIVE_NOTE_FORMAT;
  version: number;
  id: string;
  title: string;
  icon?: string;
  cover?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  blocks: Descendant[];
  /** 当前 blocks 的 Markdown 渲染，供 AI/导出/纯文本工具读取 */
  markdown: string;
  /** 从 Markdown 导入时保留的未知 YAML 原文 */
  frontmatter?: string;
}

export type NativeNoteParseResult =
  | { ok: true; note: NativeNoteFile; migrated: boolean }
  | {
      ok: false;
      reason: "invalid-json" | "invalid-shape" | "unsupported-version";
      error: string;
    };

export function isNativeNoteRel(rel: string): boolean {
  return /\.knote$/iu.test(rel);
}

/** 标题 → 文件名（不含扩展名）；避免路径分隔符和 Windows 保留字符 */
export function nativeNoteBaseName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return safe || "未命名";
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function isDescendantArray(value: unknown): value is Descendant[] {
  return (
    Array.isArray(value) &&
    value.every(
      (node) =>
        !!node &&
        typeof node === "object" &&
        "text" in node === false &&
        Array.isArray((node as { children?: unknown }).children),
    )
  );
}

export interface CreateNativeNoteOptions {
  title: string;
  icon?: string;
  cover?: string;
  tags?: string[];
  blocks?: Descendant[];
  markdown?: string;
  frontmatter?: string;
  id?: string;
  createdAt?: string;
}

export function emptyNativeBlocks(): Descendant[] {
  return [{ type: "p", children: [{ text: "" }] }];
}

export function createNativeNote(
  options: CreateNativeNoteOptions,
): NativeNoteFile {
  const now = new Date().toISOString();
  return {
    format: NATIVE_NOTE_FORMAT,
    version: NATIVE_NOTE_VERSION,
    id: options.id ?? crypto.randomUUID(),
    title: options.title.trim() || "未命名",
    ...(options.icon ? { icon: options.icon } : {}),
    ...(options.cover ? { cover: options.cover } : {}),
    tags: normalizeTags(options.tags),
    createdAt: options.createdAt ?? now,
    updatedAt: now,
    blocks:
      Array.isArray(options.blocks) && options.blocks.length > 0
        ? options.blocks
        : emptyNativeBlocks(),
    markdown: options.markdown ?? "",
    ...(options.frontmatter ? { frontmatter: options.frontmatter } : {}),
  };
}

/** 只读解析；未知版本/损坏数据不猜测，交给调用方决定是否回退 Markdown */
export function parseNativeNote(raw: string): NativeNoteParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid-json",
      error: String(error),
    };
  }
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      reason: "invalid-shape",
      error: "note is not an object",
    };
  }
  const note = data as Partial<NativeNoteFile>;
  if (note.format !== NATIVE_NOTE_FORMAT) {
    return {
      ok: false,
      reason: "invalid-shape",
      error: "unknown note format",
    };
  }
  if (typeof note.version !== "number" || !Number.isFinite(note.version)) {
    return {
      ok: false,
      reason: "invalid-shape",
      error: "missing version",
    };
  }
  if (note.version > NATIVE_NOTE_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      error: `note version ${note.version} is newer than ${NATIVE_NOTE_VERSION}`,
    };
  }
  if (typeof note.id !== "string" || !note.id) {
    return { ok: false, reason: "invalid-shape", error: "missing id" };
  }
  if (typeof note.title !== "string") {
    return { ok: false, reason: "invalid-shape", error: "missing title" };
  }
  if (!isDescendantArray(note.blocks)) {
    return { ok: false, reason: "invalid-shape", error: "invalid blocks" };
  }

  const now = new Date().toISOString();
  const migrated = note.version < NATIVE_NOTE_VERSION;
  return {
    ok: true,
    migrated,
    note: {
      format: NATIVE_NOTE_FORMAT,
      version: NATIVE_NOTE_VERSION,
      id: note.id,
      title: note.title || "未命名",
      ...(typeof note.icon === "string" && note.icon ? { icon: note.icon } : {}),
      ...(typeof note.cover === "string" && note.cover
        ? { cover: note.cover }
        : {}),
      tags: normalizeTags(note.tags),
      createdAt:
        typeof note.createdAt === "string" ? note.createdAt : now,
      updatedAt:
        typeof note.updatedAt === "string" ? note.updatedAt : now,
      blocks: note.blocks,
      markdown: typeof note.markdown === "string" ? note.markdown : "",
      ...(typeof note.frontmatter === "string" && note.frontmatter
        ? { frontmatter: note.frontmatter }
        : {}),
    },
  };
}

export function serializeNativeNote(note: NativeNoteFile): string {
  return `${JSON.stringify(note, null, 2)}\n`;
}

/** 读取或写入前统一更新 updatedAt；不修改入参 */
export function withNativeNotePatch(
  note: NativeNoteFile,
  patch: Partial<
    Pick<
      NativeNoteFile,
      "title" | "icon" | "cover" | "tags" | "blocks" | "markdown" | "frontmatter"
    >
  >,
): NativeNoteFile {
  return {
    ...note,
    ...patch,
    tags: patch.tags ? normalizeTags(patch.tags) : note.tags,
    updatedAt: new Date().toISOString(),
  };
}
