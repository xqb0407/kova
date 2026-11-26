/**
 * 富文本（Plate）编辑 Markdown 的纯函数层：
 *
 * - frontmatter 原文拆分/回接：富文本只编辑正文，元数据块按字节保留；
 * - 兼容性判定：把富文本会丢内容/结构的语法挡在门外，宁可退回源码态，
 *   也不允许「打开就悄悄规范化再覆盖」；
 * - 图片相对路径解析：笔记里的 `assets/x.png` 在桌面壳里换成 kova:// 直链；
 * - 斜杠菜单过滤：与 UI 无关的纯匹配逻辑，单测覆盖。
 *
 * 这里不 import React/编辑器实现，渲染层与单测都能直接用。
 */

import { splitFrontmatter } from "./markdown-frontmatter";
import { canUseLocalFileUrl, localFileUrl } from "@/lib/workspace/local-file-url";

/** 超过这个体积不再进富文本：每次输入都要全量序列化，避免卡住主线程 */
export const RICH_MAX_CHARS = 200_000;

/** 文档 → 可交给编辑器的正文 + 需要原样保留的 frontmatter 块 */
export interface EditorMarkdownParts {
  /** 含开头 `---`、闭合 `---` 与各自换行的原文；无 frontmatter 为 "" */
  raw: string;
  /** 去掉 frontmatter 后的正文 */
  body: string;
  hasFrontmatter: boolean;
}

/** 与 markdown-frontmatter 的识别口径一致；额外把原始块整段捕获（含 BOM） */
const RAW_FRONTMATTER_RE =
  /^(\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/;

/**
 * 拆出 frontmatter 原文与正文。
 *
 * 不能用 `fm.body` 反推 raw：带 BOM 时 `splitFrontmatter` 的切片基准是
 * 去 BOM 后的字符串，长度差 1 会把闭合 `---` 的最后一个字符切进正文。
 * 这里用同口径 regex 整段捕获，拿不到再退回长度差。
 */
export function splitEditorMarkdown(text: string): EditorMarkdownParts {
  const fm = splitFrontmatter(text);
  if (!fm) return { raw: "", body: text, hasFrontmatter: false };
  const match = RAW_FRONTMATTER_RE.exec(text);
  if (match) {
    const raw = match[1] ?? "";
    return { raw, body: text.slice(raw.length), hasFrontmatter: true };
  }
  return {
    raw: text.slice(0, text.length - fm.body.length),
    body: fm.body,
    hasFrontmatter: true,
  };
}

/** 正文 + 原样 frontmatter 拼回；raw 以换行结尾时不再补空行 */
export function joinEditorMarkdown(raw: string, body: string): string {
  if (!raw) return body;
  return raw.endsWith("\n") ? `${raw}${body}` : `${raw}\n${body}`;
}

export type RichFallbackReason =
  | "truncated"
  | "size"
  | "frontmatter"
  | "html"
  | "footnote"
  | "reference-link";

export interface RichCompatibility {
  ok: boolean;
  reason?: RichFallbackReason;
}

/**
 * 去掉代码围栏/行内代码/链接目标后再扫「危险语法」——技术笔记里到处是
 * `<div>`、`[^1]` 的代码示例，不能因为这些示例把整篇笔记赶回源码态。
 */
function stripCodeAndDestinations(text: string): string {
  return text
    // 围栏代码块（``` / ~~~，允许更长围栏与语言标注）
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, "")
    // 行内代码
    .replace(/`[^`\n]*`/g, "")
    // 自动链接 <https://…> / <mailto:…>
    .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, "")
    // Markdown 链接/图片目标，避免 URL 里的 < > 被当成 HTML
    .replace(/\]\([^)\n]*\)/g, "]")
    // 裸 URL
    .replace(/https?:\/\/[^\s)>\]]+/gi, "");
}

/** 富文本编辑器当前不承诺还原的结构 → 退回源码，避免静默丢格式 */
export function checkRichMarkdown(
  text: string,
  opts?: { truncated?: boolean },
): RichCompatibility {
  if (opts?.truncated) return { ok: false, reason: "truncated" };
  const parts = splitEditorMarkdown(text);
  // 开头像 frontmatter 但 splitFrontmatter 解析不了（嵌套 YAML 等）：
  // 富文本会把 `---` 当水平线、把键值当正文，保存即毁元数据 → 源码态
  if (
    !parts.hasFrontmatter &&
    /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(text)
  ) {
    return { ok: false, reason: "frontmatter" };
  }
  const body = parts.body;
  if (body.length > RICH_MAX_CHARS) return { ok: false, reason: "size" };

  const scan = stripCodeAndDestinations(body);

  // HTML 注释与裸标签：富文本 schema 只认得白名单标签，其余会被丢掉
  if (/<!--/.test(scan)) return { ok: false, reason: "html" };
  for (const match of scan.matchAll(/<\/?([a-zA-Z][\w-]*)(?:\s[^>]*)?\/?>/g)) {
    if ((match[1] ?? "").toLowerCase() === "br") continue;
    return { ok: false, reason: "html" };
  }

  // 脚注（marked 的 GFM 扩展能解析，但 schema 里没有对应节点）
  if (/\[\^[^\]\s]+\]/.test(scan)) return { ok: false, reason: "footnote" };

  // 引用式链接：定义行或 `[text][id]` 用法
  if (/^\s*\[[^\]\n]+\]:\s*\S+/m.test(scan)) {
    return { ok: false, reason: "reference-link" };
  }
  if (/\[[^\]\n]*\]\[[^\]\n]*\]/.test(scan)) {
    return { ok: false, reason: "reference-link" };
  }

  return { ok: true };
}

/**
 * 笔记内图片路径 → 渲染用 URL。
 *
 * - http(s)/data/blob/kova 等协议原样返回；
 * - 相对路径按「笔记所在目录」解析（`../img/a.png` 允许，越界夹在库根内）；
 * - 桌面壳换成 kova://file/<绝对路径>，Web/dev-preview 退回相对路径。
 */
export function resolveRichImageSrc(
  cwd: string,
  noteRel: string,
  src: string,
): string {
  const raw = src.trim();
  if (!raw) return raw;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return raw;

  const cut = raw.search(/[?#]/);
  const suffix = cut >= 0 ? raw.slice(cut) : "";
  let pathPart = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/\\/g, "/");
  if (!pathPart) return raw;
  // Windows 绝对路径不在这里解析（库内图片应使用相对路径）
  if (/^[a-zA-Z]:\//.test(pathPart)) return raw;
  // Markdown URL 里的空格/括号通常是百分号编码的；先还原成磁盘路径，
  // localFileUrl 落 URL 时会重新编码（否则 %20 会被当成字面文件名）
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    /* 非法编码按原样处理 */
  }

  const noteDir = noteRel.includes("/")
    ? noteRel.slice(0, noteRel.lastIndexOf("/"))
    : "";
  const segments = pathPart.startsWith("/")
    ? []
    : noteDir.split("/").filter(Boolean);

  for (const seg of pathPart.replace(/^\/+/, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }

  const rel = segments.join("/");
  if (!rel) return raw;
  return canUseLocalFileUrl()
    ? `${localFileUrl(cwd, rel)}${suffix}`
    : `${rel}${suffix}`;
}
