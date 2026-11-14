"use client";

/**
 * SKILL.md 详情预览：三个技能源共用同一套渲染与 frontmatter 剥离逻辑。
 * Streamdown 是重依赖，点开详情后才异步加载。
 */

import { useEffect, useState, type FC } from "react";
import { useT } from "@/lib/i18n";

/** 展示用去掉 frontmatter（安装仍用原文，frontmatter 由 sidecar 解析） */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/**
 * 文档正文以一级标题开头且与技能名相同（SKILL.md 常见的 `# name` 开头）时
 * 整段去掉：弹窗头部已经展示了名称，正文再顶一个大标题既重复又占首屏。
 * 不匹配的 H1 保留——那是文档自己的标题，有信息量。
 */
export function stripLeadingDocTitle(md: string, title?: string | null): string {
  if (!title) return md;
  const match = md.match(/^#\s+(\S[^\n]*?)\s*(?:\n|$)/);
  if (!match) return md;
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, "");
  return normalize(match[1]) === normalize(title)
    ? md.slice(match[0].length).trimStart()
    : md;
}

export const SkillDocPreview: FC<{ raw: string; title?: string | null }> = ({
  raw,
  title,
}) => {
  const t = useT();
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

  const content = stripLeadingDocTitle(stripFrontmatter(raw), title);
  return (
    // shrink-0 不能少：卡片在滚动容器里是 flex 子项，默认可收缩——文档比
    // 可视区高时卡片会被压到一屏高，正文从边框下面漏出去（边框只包住上半截，
    // 下半截裸奔，看起来像没套壳的 demo）。shrink-0 后卡片恒等内容高，
    // 滚动交给外层滚动容器
    <div className="aui-md-panel shrink-0 rounded-2xl border">
      {view.status === "loading" && (
        <p className="text-muted-foreground p-5 text-sm">
          {t("marketplace.doc.loading")}
        </p>
      )}
      {view.status === "error" && (
        <pre className="p-5 font-mono text-xs whitespace-pre-wrap">{content}</pre>
      )}
      {view.status === "ready" && (
        <div className="mx-auto w-full max-w-3xl p-5">
          <view.MarkdownText text={content} />
        </div>
      )}
    </div>
  );
};
