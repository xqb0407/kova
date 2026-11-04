"use client";

/**
 * SKILL.md 详情预览：两个技能源共用同一套渲染与 frontmatter 剥离逻辑。
 * Streamdown 是重依赖，点开详情后才异步加载。
 */

import { useEffect, useState, type FC } from "react";

/** 展示用去掉 frontmatter（安装仍用原文，frontmatter 由 sidecar 解析） */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export const SkillDocPreview: FC<{ raw: string }> = ({ raw }) => {
  const [view, setView] = useState<
    | { status: "loading" }
    | { status: "ready"; MarkdownText: FC<{ text: string }> }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void import("@/components/assistant-ui/elements/markdown-text")
      .then((m) => {
        if (!cancelled) setView({ status: "ready", MarkdownText: m.MarkdownText });
      })
      .catch(() => {
        if (!cancelled) setView({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const content = stripFrontmatter(raw);
  return (
    <div className="min-h-0 flex-1 rounded-2xl border p-5">
      {view.status === "loading" && (
        <p className="text-muted-foreground text-sm">正文加载中…</p>
      )}
      {view.status === "error" && (
        <pre className="font-mono text-xs whitespace-pre-wrap">{content}</pre>
      )}
      {view.status === "ready" && <view.MarkdownText text={content} />}
    </div>
  );
};
