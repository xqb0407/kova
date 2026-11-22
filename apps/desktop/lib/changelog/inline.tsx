"use client";

/**
 * 更新日志的行内 Markdown：只覆盖 CHANGELOG 实际会用的三种写法——
 * **粗体**、`行内代码`、[链接](https://…)。
 *
 * 不走 marked + DOMPurify：这里的内容只来自仓库内的 CHANGELOG.md，且每次
 * 只在设置页 / 更新弹窗里渲染几十条，没必要为它把两个重依赖拉进设置页
 * chunk。输出直接是 React 节点，没有 HTML 注入面。
 */
import type { ReactNode } from "react";
import { openExternal } from "@/lib/external-link";

export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "code"; value: string }
  | { kind: "link"; value: string; href: string };

/** 顺序有意义：粗体先于行内代码，链接最后兜底 */
const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/gu;

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, index) });
    }
    const raw = match[0];
    if (raw.startsWith("**")) {
      tokens.push({ kind: "strong", value: raw.slice(2, -2) });
    } else if (raw.startsWith("`")) {
      tokens.push({ kind: "code", value: raw.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/u.exec(raw);
      if (link) {
        tokens.push({ kind: "link", value: link[1]!, href: link[2]! });
      } else {
        tokens.push({ kind: "text", value: raw });
      }
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }
  return tokens;
}

/** 把 token 内的换行渲染成 <br>（续行/嵌套条目会带 \n） */
function renderText(value: string, key: string): ReactNode {
  if (!value.includes("\n")) return value;
  const lines = value.split("\n");
  return lines.map((line, index) => (
    <span key={`${key}-${index}`}>
      {index > 0 ? <br /> : null}
      {line}
    </span>
  ));
}

export function InlineMarkdown({ text }: { text: string }): ReactNode {
  return (
    <>
      {tokenizeInline(text).map((token, index) => {
        const key = `inline-${index}`;
        switch (token.kind) {
          case "strong":
            return (
              <strong key={key} className="text-foreground font-medium">
                {renderText(token.value, key)}
              </strong>
            );
          case "code":
            return (
              <code
                key={key}
                className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.85em]"
              >
                {token.value}
              </code>
            );
          case "link":
            return (
              <a
                key={key}
                href={token.href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  openExternal(token.href);
                }}
                className="text-primary decoration-primary/40 hover:decoration-primary underline underline-offset-2"
              >
                {token.value}
              </a>
            );
          default:
            return <span key={key}>{renderText(token.value, key)}</span>;
        }
      })}
    </>
  );
}
