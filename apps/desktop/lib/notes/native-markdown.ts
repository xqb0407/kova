"use client";

/**
 * Markdown → 原生笔记 envelope。
 *
 * 只在「存为笔记 / 导入 Markdown / 迁移」时使用：用与编辑器同一套插件
 * 反序列化，保证 blocks 能被 Plate 直接打开。Markdown 原文写进缓存字段，
 * frontmatter 原样保留，未知字段不丢。
 */

import { createPlateEditor, type PlateEditor } from "platejs/react";
import { deserializeMd, serializeMd } from "@platejs/markdown";
import { KEYS, type Descendant, type TElement } from "platejs";
import { PLATE_PLUGINS } from "@/components/files/plate-editor/plugins";
import { splitEditorMarkdown } from "@/lib/markdown/rich-markdown";
import {
  createNativeNote,
  type NativeNoteFile,
} from "./native-note";

export interface NativeNoteFromMarkdownOptions {
  title: string;
  markdown: string;
  tags?: readonly string[];
  icon?: string;
  cover?: string;
}

/**
 * 高级块 → Markdown 兼容渲染：callout 降级为引用、toggle 展开为
 * 标题段落 + 正文、分栏按列顺序铺平。Markdown 只是 AI/导出缓存，
 * native blocks 才是事实源，所以这里优先保证「内容不丢」而不是还原。
 */
function degradeNodes(nodes: Descendant[]): Descendant[] {
  const out: Descendant[] = [];
  for (const node of nodes) {
    if (!("children" in node) || !Array.isArray(node.children)) {
      out.push(node);
      continue;
    }
    const element = node as TElement;
    const children = degradeNodes(element.children);
    switch (element.type) {
      case KEYS.callout:
        out.push({ ...element, type: KEYS.blockquote, children });
        break;
      case KEYS.toggle: {
        const title =
          typeof (element as unknown as { title?: unknown }).title === "string"
            ? (element as unknown as { title: string }).title
            : "";
        if (title) {
          out.push({
            type: KEYS.p,
            children: [{ text: title, [KEYS.bold]: true }],
          });
        }
        out.push(...children);
        break;
      }
      case KEYS.columnGroup:
      case KEYS.column:
        // 分栏没有 Markdown 对应结构：按阅读顺序平铺
        out.push(...children);
        break;
      default:
        out.push({ ...element, children });
    }
  }
  return out;
}

/** 原生值 → Markdown 缓存（高级块降级）；调用方负责容错 */
export function markdownFromNativeValue(
  editor: PlateEditor,
  value: Descendant[],
): string {
  const markdown = serializeMd(editor, {
    value: degradeNodes(value),
    preserveEmptyParagraphs: false,
  }).replace(/^\n+/, "");
  const trimmed = markdown.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}

/** 从导入的 YAML frontmatter 里提取 tags（flow/block/逗号三种常见写法） */
function tagsFromFrontmatter(raw: string): string[] {
  if (!raw) return [];
  const flow = /^tags:\s*\[(.*?)\]\s*$/mu.exec(raw);
  if (flow?.[1]) {
    return flow[1]
      .split(",")
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const inline = /^tags:\s*(.+)$/mu.exec(raw);
  if (inline?.[1]) {
    const value = inline[1].trim();
    if (value.startsWith("[")) {
      try {
        const parsed = JSON.parse(value.replace(/'/g, '"'));
        if (Array.isArray(parsed)) {
          return parsed.filter((tag): tag is string => typeof tag === "string");
        }
      } catch {
        /* 继续按逗号切 */
      }
    }
    if (!value.startsWith("-")) {
      return value
        .split(",")
        .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  const block = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/mu.exec(raw);
  if (block?.[1]) {
    return block[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .map((tag) => tag.replace(/^["']|["']$/g, ""))
      .filter((tag) => tag && tag !== "---" && !tag.startsWith("--"));
  }
  return [];
}

export function nativeNoteFromMarkdown(
  options: NativeNoteFromMarkdownOptions,
): NativeNoteFile {
  const { raw, body } = splitEditorMarkdown(options.markdown);
  const editor = createPlateEditor({ plugins: PLATE_PLUGINS });
  const blocks = deserializeMd(editor, body);
  const tags =
    options.tags && options.tags.length > 0
      ? [...options.tags]
      : tagsFromFrontmatter(raw);
  return createNativeNote({
    title: options.title,
    tags,
    icon: options.icon,
    cover: options.cover,
    blocks: blocks.length > 0 ? blocks : undefined,
    // 缓存正文用去掉 frontmatter 的版本；AI 内联不需要 YAML
    markdown: body.replace(/^\n+/, "").replace(/\s+$/u, ""),
    frontmatter: raw || undefined,
  });
}
