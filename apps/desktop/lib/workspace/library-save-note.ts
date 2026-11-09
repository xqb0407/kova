"use client";

import { toast } from "@/components/ui/toast";
import { isDesktop } from "@/lib/desktop-env";
import { librarySaveNote, type LibrarySaveNoteResult } from "./library-files";
import { invalidateLibraryIndex } from "./library-index";
import { normalizeNoteTags } from "./library-note-meta";
import { requestOpenLibraryFile } from "./knowledge-link";

/**
 * 「存为笔记」：把对话回答/划词选区写成资料库里的 Markdown。
 *
 * 落点按来源项目分文件夹：`项目/<项目目录名>/`；没有 cwd 的会话落 `收件箱/`。
 * 文件正文带 YAML frontmatter（标题、标签、来源会话/目录、创建日期），让这条
 * 笔记离开应用也说得清自己从哪来；library_file_meta 仍同步一份，@ 选择器
 * 立刻能按标题/标签搜到。
 */

const MAX_TITLE = 80;
const MAX_BODY_BYTES = 1024 * 1024;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

/** 去掉常见 Markdown 修饰（图片/链接/强调/行内代码），标题只留文字 */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 标题：首个 Markdown 标题，否则首行正文，否则回退值 */
export function noteTitleFromText(
  text: string,
  fallback = "未命名笔记",
): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    const title = heading?.[1] ? stripMarkdown(heading[1]) : "";
    if (title) return clip(title, MAX_TITLE);
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("```")) continue;
    // 分隔线/空 frontmatter 标记不作为标题
    if (/^[-*_]{3,}$/u.test(trimmed)) continue;
    const title = stripMarkdown(trimmed);
    if (title) return clip(title, MAX_TITLE);
  }
  return fallback;
}

/** 来源项目 → 笔记子目录；无 cwd / 取不到目录名时落收件箱 */
export function projectFolderFor(cwd: string | null | undefined): string {
  const base = cwd
    ? (cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "")
    : "";
  const safe = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return safe ? `项目/${safe}` : "收件箱";
}

function yamlString(value: string): string {
  // JSON 字符串就是合法的 YAML 双引号标量：引号/换行/反斜杠都被转义
  return JSON.stringify(value);
}

function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface NoteMarkdownInput {
  title: string;
  tags?: readonly string[];
  sourceSessionId?: string | null;
  sourceCwd?: string | null;
  createdAt?: Date;
}

/** 笔记正文：YAML frontmatter + 原文（正文原样保留，不改写 Markdown） */
export function buildNoteMarkdown(
  input: NoteMarkdownInput,
  body: string,
): string {
  const title = clip(input.title, 200) || "未命名笔记";
  const tags = normalizeNoteTags(input.tags ?? []);
  const lines = ["---", `title: ${yamlString(title)}`];
  if (tags.length > 0) lines.push(`tags: ${JSON.stringify(tags)}`);
  if (input.sourceSessionId) {
    lines.push(`source_session: ${yamlString(input.sourceSessionId)}`);
  }
  if (input.sourceCwd) {
    lines.push(`source_cwd: ${yamlString(input.sourceCwd)}`);
  }
  lines.push(`created: ${localDate(input.createdAt ?? new Date())}`, "---");
  return `${lines.join("\n")}\n\n${body.replace(/\r\n?/g, "\n").trim()}\n`;
}

const ERROR_TEXT: Record<string, string> = {
  "note-too-large": "内容太大（上限 1MB）",
  "bad-path": "目标路径不合法",
  "cwd-not-allowed": "目标路径不合法",
  "library-unavailable": "资料库位置不可用（请检查设置 → 通用 → 资料库位置）",
};

function errorText(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String((err as { message?: unknown })?.message ?? err);
  return ERROR_TEXT[raw] ?? raw;
}

/**
 * 保存一段文字为笔记。成功给出可撤销的落点提示（「打开」直达资料库），
 * 失败返回 null 并 toast 具体原因——调用方不需要再处理异常。
 */
export async function saveNoteFromText(input: {
  text: string;
  cwd?: string | null;
  /** 虚拟项目主目录（会话在附加根时也归到同一个项目文件夹） */
  projectCwd?: string | null;
  sessionId?: string | null;
  title?: string;
  tags?: readonly string[];
}): Promise<LibrarySaveNoteResult | null> {
  const body = input.text.replace(/\r\n?/g, "\n").trim();
  if (!body) {
    toast.error("没有可保存的内容");
    return null;
  }
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    toast.error(ERROR_TEXT["note-too-large"]);
    return null;
  }
  if (!isDesktop()) {
    toast.error("仅桌面端可以保存笔记");
    return null;
  }
  const title = input.title?.trim() || noteTitleFromText(body);
  const content = buildNoteMarkdown(
    {
      title,
      tags: input.tags,
      sourceSessionId: input.sessionId,
      sourceCwd: input.cwd,
    },
    body,
  );
  try {
    const saved = await librarySaveNote({
      dir: projectFolderFor(input.projectCwd ?? input.cwd),
      title,
      tags: [...(input.tags ?? [])],
      content,
    });
    // @ 选择器的最近条目缓存立即失效；资料库页由 watcher/挂载扫描自行刷新
    invalidateLibraryIndex();
    toast.add({
      title: "已存为笔记",
      description: saved.rel,
      status: "success",
      action: {
        label: "打开",
        onClick: () => requestOpenLibraryFile(saved.rel),
      },
    });
    return saved;
  } catch (err) {
    toast.error(`保存失败：${errorText(err)}`);
    return null;
  }
}
