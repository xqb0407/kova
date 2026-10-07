"use client";

/**
 * 插件组件正文视图（插件详情二级弹窗的内容区）。
 *
 * 单独成文件只为一件事：MarkdownText 背后的 Streamdown/shiki/mermaid 是重依赖，
 * 本模块由调用方 next/dynamic 异步分块加载（与 markdown-edit-dialog、
 * memory-history-dialog 同口径），点开"查看内容"才拉取，不进市场页首屏包。
 *
 * 两类组件的正文性质不同，呈现方式也不同：
 * - 技能：SKILL.md 是 Markdown，默认走渲染视图（frontmatter 由 MarkdownText
 *   自己拆成卡片）；同时留"原文"页签——改插件的人要看的是作者实际写了什么，
 *   渲染视图会把标题、列表、代码块的原始标记吃掉。
 * - MCP 条目 / 子智能体：正文是 JSON / YAML，不是散文。按 Markdown 渲染会把
 *   `{`、`- ` 当成语法吃掉结构，所以恒走等宽原文视图。
 */
import { useState, type FC } from "react";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type ComponentDocViewProps = {
  /** 是否 Markdown 正文（只有技能是） */
  markdown: boolean;
  content: string;
};

const RawView: FC<{ content: string }> = ({ content }) => (
  <pre className="bg-muted/50 mt-2 rounded-xl p-4 text-xs whitespace-pre-wrap">
    {content}
  </pre>
);

const ComponentDocView: FC<ComponentDocViewProps> = ({ markdown, content }) => {
  const [tab, setTab] = useState("rendered");

  if (!markdown) return <RawView content={content} />;

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="mt-2 min-w-0">
      <TabsList className="h-8 rounded-full p-[3px]">
        <TabsTrigger value="rendered" className="rounded-full px-3 py-0 text-xs">
          渲染
        </TabsTrigger>
        <TabsTrigger value="raw" className="rounded-full px-3 py-0 text-xs">
          原文
        </TabsTrigger>
      </TabsList>
      <TabsContent value="rendered" className="mt-3">
        <MarkdownText text={content} />
      </TabsContent>
      <TabsContent value="raw" className="mt-3">
        <RawView content={content} />
      </TabsContent>
    </Tabs>
  );
};

export default ComponentDocView;