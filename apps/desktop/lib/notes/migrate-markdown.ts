"use client";

/**
 * Markdown → 原生笔记一次性迁移（渲染层执行）。
 *
 * 安全约定：
 * - 先逐篇把原始字节备份到 `<库根>/.kova/markdown-backup/<timestamp>/`，
 *   备份失败/超限的条目不转换；
 * - `.knote` 写入并回读校验成功后才删除原 `.md`；
 * - 目标同名文件已存在时跳过，绝不覆盖；
 * - 含裸 HTML 等富文本不兼容语法的笔记跳过并留在 Markdown；
 * - 每一步写迁移 marker，可中断续跑，重复执行跳过已完成项。
 */

import {
  fsDelete,
  fsReadFile,
  fsReadFileBase64,
  fsWriteFile,
  fsWriteFileBase64,
} from "@/lib/workspace/fs";
import {
  knowledgeRefsRepath,
  libraryNoteAliasSet,
  libraryScan,
} from "@/lib/workspace/library-files";
import {
  libraryFileMetaMove,
  libraryFileMetaSet,
} from "@/lib/workspace/library-note-meta";
import { checkRichMarkdown } from "@/lib/markdown/rich-markdown";
import { nativeNoteFromMarkdown } from "./native-markdown";
import { parseNativeNote, serializeNativeNote } from "./native-note";

export const MARKDOWN_MIGRATION_MARKER = ".kova/markdown-migration.json";
const BACKUP_ROOT = ".kova/markdown-backup";
const MARKDOWN_RE = /\.(md|markdown)$/iu;

export interface MigrationSkipped {
  rel: string;
  reason: string;
}

export interface MigrationReport {
  version: 1;
  startedAt: string;
  finishedAt?: string;
  backupDir: string;
  converted: { oldRel: string; newRel: string }[];
  skipped: MigrationSkipped[];
}

export interface MigrationStatus {
  needed: boolean;
  markdownCount: number;
  /** scan 因 500 条/访问量上限截断：迁移也只覆盖可见部分 */
  truncated: boolean;
  marker: MigrationReport | null;
}

function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isMarkdownRel(rel: string): boolean {
  return MARKDOWN_RE.test(rel);
}

function noteBaseName(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.replace(MARKDOWN_RE, "");
}

function targetRelOf(rel: string): string {
  return rel.replace(MARKDOWN_RE, ".knote");
}

async function readMarker(root: string): Promise<MigrationReport | null> {
  const file = await fsReadFile(root, MARKDOWN_MIGRATION_MARKER);
  if (!file || file.binary || file.truncated) return null;
  try {
    const data = JSON.parse(file.content) as Partial<MigrationReport>;
    if (!data || data.version !== 1 || typeof data.backupDir !== "string") {
      return null;
    }
    return {
      version: 1,
      startedAt:
        typeof data.startedAt === "string"
          ? data.startedAt
          : new Date().toISOString(),
      ...(typeof data.finishedAt === "string"
        ? { finishedAt: data.finishedAt }
        : {}),
      backupDir: data.backupDir,
      converted: Array.isArray(data.converted)
        ? data.converted.filter(
            (item): item is { oldRel: string; newRel: string } =>
              !!item &&
              typeof item.oldRel === "string" &&
              typeof item.newRel === "string",
          )
        : [],
      skipped: Array.isArray(data.skipped)
        ? data.skipped.filter(
            (item): item is MigrationSkipped =>
              !!item &&
              typeof item.rel === "string" &&
              typeof item.reason === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

export async function markdownMigrationStatus(
  root: string,
): Promise<MigrationStatus> {
  const [scan, marker] = await Promise.all([
    libraryScan({ query: "" }).catch(() => ({
      entries: [],
      truncated: false,
    })),
    readMarker(root),
  ]);
  const markdownCount = scan.entries.filter((entry) =>
    isMarkdownRel(entry.rel),
  ).length;
  return {
    needed: markdownCount > 0 && !marker?.finishedAt,
    markdownCount,
    truncated: scan.truncated,
    marker,
  };
}

export interface MigrateProgress {
  done: number;
  total: number;
  currentRel?: string;
}

export interface MigrateOptions {
  onProgress?: (progress: MigrateProgress) => void;
}

/**
 * 执行迁移；返回完整报告（即使中途有跳过项）。调用方负责刷新资料库 UI。
 */
export async function migrateMarkdownToNative(
  root: string,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const scan = await libraryScan({ query: "" });
  const markdown = scan.entries
    .filter((entry) => isMarkdownRel(entry.rel))
    .map((entry) => entry.rel);
  const existing = await readMarker(root);
  const startedAt = existing?.startedAt ?? new Date().toISOString();
  const backupDir =
    existing?.backupDir ?? `${BACKUP_ROOT}/${safeTimestamp()}`;
  const convertedByRel = new Map<string, string>(
    (existing?.converted ?? []).map((item) => [item.oldRel, item.newRel]),
  );
  const skippedByRel = new Map<string, string>(
    (existing?.skipped ?? []).map((item) => [item.rel, item.reason]),
  );

  const report = (finished: boolean): MigrationReport => ({
    version: 1,
    startedAt,
    ...(finished ? { finishedAt: new Date().toISOString() } : {}),
    backupDir,
    converted: [...convertedByRel.entries()].map(([oldRel, newRel]) => ({
      oldRel,
      newRel,
    })),
    skipped: [...skippedByRel.entries()].map(([rel, reason]) => ({
      rel,
      reason,
    })),
  });

  const writeMarker = async (finished: boolean) => {
    await fsWriteFile(
      root,
      MARKDOWN_MIGRATION_MARKER,
      `${JSON.stringify(report(finished), null, 2)}\n`,
    );
  };

  // 先把所有候选原文件备份完再动正文：备份失败的文件只记录、不转换
  const backedUp = new Set<string>();
  for (const rel of markdown) {
    try {
      const bytes = await fsReadFileBase64(root, rel);
      if (bytes === "too-large" || !bytes) {
        skippedByRel.set(
          rel,
          bytes === "too-large" ? "backup-too-large" : "backup-read-failed",
        );
        continue;
      }
      const err = await fsWriteFileBase64(
        root,
        `${backupDir}/${rel}`,
        bytes.base64,
      );
      if (err) {
        skippedByRel.set(rel, `backup-write-failed:${err}`);
        continue;
      }
      backedUp.add(rel);
    } catch (error) {
      skippedByRel.set(rel, `backup-failed:${String(error)}`);
    }
  }
  await writeMarker(false);

  const candidates = markdown.filter(
    (rel) => backedUp.has(rel) && !convertedByRel.has(rel),
  );
  const total = candidates.length;
  let done = 0;

  for (const rel of candidates) {
    options.onProgress?.({ done, total, currentRel: rel });
    try {
      const file = await fsReadFile(root, rel);
      if (!file || file.binary || file.truncated) {
        skippedByRel.set(
          rel,
          !file
            ? "read-failed"
            : file.binary
              ? "binary"
              : "truncated",
        );
        continue;
      }
      const compatibility = checkRichMarkdown(file.content, {
        truncated: file.truncated,
      });
      if (!compatibility.ok) {
        skippedByRel.set(
          rel,
          `incompatible:${compatibility.reason ?? "unknown"}`,
        );
        continue;
      }
      const targetRel = targetRelOf(rel);
      // 目标已存在（可能是重启后的半成品/同名笔记）：不覆盖，留给用户处理
      const targetExists = await fsReadFile(root, targetRel);
      if (targetExists) {
        skippedByRel.set(rel, "target-exists");
        continue;
      }

      const note = nativeNoteFromMarkdown({
        title: noteBaseName(rel),
        markdown: file.content,
      });
      const err = await fsWriteFile(
        root,
        targetRel,
        serializeNativeNote(note),
      );
      if (err) {
        skippedByRel.set(rel, `write-failed:${err}`);
        continue;
      }
      // 回读校验：解析失败说明写入链路有问题，保留原 .md
      const written = await fsReadFile(root, targetRel);
      if (
        !written ||
        written.truncated ||
        !parseNativeNote(written.content).ok
      ) {
        skippedByRel.set(rel, "verify-failed");
        await fsDelete(root, targetRel);
        continue;
      }

      convertedByRel.set(rel, targetRel);
      skippedByRel.delete(rel);

      // 原文件只在 .knote 校验通过后才删
      await fsDelete(root, rel);
      // 元数据/引用/历史链接尽量跟随；任一失败都不回滚已验证的转换
      await libraryFileMetaMove(root, rel, targetRel).catch(() => {});
      await libraryFileMetaSet(root, targetRel, {
        title: note.title,
        ...(note.tags.length > 0 ? { tags: note.tags } : {}),
      }).catch(() => {});
      await knowledgeRefsRepath({
        source: "library",
        scopeId: root,
        from: rel,
        to: targetRel,
      }).catch(() => {});
      await libraryNoteAliasSet(root, rel, targetRel).catch(() => {});
      await writeMarker(false);
    } catch (error) {
      skippedByRel.set(rel, `failed:${String(error)}`);
    } finally {
      done += 1;
      options.onProgress?.({ done, total, currentRel: rel });
    }
  }

  await writeMarker(true);
  return report(true);
}

/** 单篇 Markdown → 原生笔记（兼容模式里的「转换为原生笔记」按钮）。
 *  与批量迁移同一套备份/校验/别名流程，失败时不删除原文件。 */
export async function convertMarkdownFileToNative(
  root: string,
  rel: string,
): Promise<{ ok: true; newRel: string } | { ok: false; error: string }> {
  if (!isMarkdownRel(rel)) return { ok: false, error: "not-markdown" };
  const file = await fsReadFile(root, rel);
  if (!file) return { ok: false, error: "read-failed" };
  if (file.binary) return { ok: false, error: "binary" };
  if (file.truncated) return { ok: false, error: "truncated" };
  const compatibility = checkRichMarkdown(file.content, { truncated: false });
  if (!compatibility.ok) {
    return { ok: false, error: `incompatible:${compatibility.reason ?? "unknown"}` };
  }
  const targetRel = targetRelOf(rel);
  if (await fsReadFile(root, targetRel)) {
    return { ok: false, error: "target-exists" };
  }
  // 单篇也先备份原始字节，绝不因为按钮误点丢 Markdown
  const bytes = await fsReadFileBase64(root, rel);
  if (bytes === "too-large" || !bytes) {
    return { ok: false, error: "backup-read-failed" };
  }
  const backupDir = `${BACKUP_ROOT}/manual-${safeTimestamp()}`;
  const backupErr = await fsWriteFileBase64(
    root,
    `${backupDir}/${rel}`,
    bytes.base64,
  );
  if (backupErr) return { ok: false, error: `backup-failed:${backupErr}` };

  const note = nativeNoteFromMarkdown({
    title: noteBaseName(rel),
    markdown: file.content,
  });
  const err = await fsWriteFile(root, targetRel, serializeNativeNote(note));
  if (err) return { ok: false, error: `write-failed:${err}` };
  const written = await fsReadFile(root, targetRel);
  if (!written || written.truncated || !parseNativeNote(written.content).ok) {
    await fsDelete(root, targetRel);
    return { ok: false, error: "verify-failed" };
  }
  await fsDelete(root, rel);
  await libraryFileMetaMove(root, rel, targetRel).catch(() => {});
  await libraryFileMetaSet(root, targetRel, {
    title: note.title,
    ...(note.tags.length > 0 ? { tags: note.tags } : {}),
  }).catch(() => {});
  await knowledgeRefsRepath({
    source: "library",
    scopeId: root,
    from: rel,
    to: targetRel,
  }).catch(() => {});
  await libraryNoteAliasSet(root, rel, targetRel).catch(() => {});
  return { ok: true, newRel: targetRel };
}
