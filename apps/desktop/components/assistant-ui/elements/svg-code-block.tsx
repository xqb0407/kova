"use client";

import { memo, useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { Braces, Eye } from "lucide-react";
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from "streamdown";
import { Segmented } from "@/components/custom-ui/segmented";

/**
 * ```svg 围栏的自定义渲染（经 streamdown 的 plugins.renderers 注册）：
 * ChatGPT artifact 风格——无边框头部条的圆角卡片，右上角悬浮
 * 「预览 / 源码」分段器（复用 custom-ui/segmented）+ 复制；
 * 预览走 DOMPurify 消毒后内联渲染。
 */

type SvgViewMode = "preview" | "source";

/**
 * 仅当整段内容就是一个独立的 <svg> 根元素时返回其源码，否则 null。
 * 容忍前导的 <?xml?> 声明与注释；混排内容（svg 前后还有别的）不预览。
 */
function extractStandaloneSvg(code: string): string | null {
  let text = code.trim();
  for (;;) {
    const decl = /^<\?xml[\s\S]*?\?>/.exec(text);
    if (decl) {
      text = text.slice(decl[0].length).trimStart();
      continue;
    }
    const comment = /^<!--[\s\S]*?-->/.exec(text);
    if (comment) {
      text = text.slice(comment[0].length).trimStart();
      continue;
    }
    break;
  }
  if (!text.startsWith("<svg") || !text.endsWith("</svg>")) return null;
  return text;
}

/**
 * 消毒只在浏览器里做：SSR/水合首帧先渲染空容器，effect 里再注入，避免
 * dangerouslySetInnerHTML 两端内容不一致触发水合告警。
 */
function useSanitizedSvg(source: string | null): string {
  const [html, setHtml] = useState("");
  useEffect(() => {
    if (!source) {
      setHtml("");
      return;
    }
    setHtml(
      DOMPurify.sanitize(source, {
        USE_PROFILES: { svg: true, svgFilters: true },
      }),
    );
  }, [source]);
  return html;
}

const SvgCodeBlockImpl = ({ code, isIncomplete, language }: CustomRendererProps) => {
  const svgSource = useMemo(() => extractStandaloneSvg(code), [code]);
  const previewHtml = useSanitizedSvg(svgSource);
  const [mode, setMode] = useState<SvgViewMode>("preview");

  // 围栏还在流式生成、或内容不是独立 svg：走默认代码块（Shiki 高亮），与现状一致
  if (isIncomplete || !svgSource) {
    return <CodeBlock code={code} language={language} isIncomplete={isIncomplete} />;
  }

  return (
    <div
      className="relative my-4 overflow-hidden rounded-xl border border-border/70 bg-card"
      data-streamdown="artifact-block"
    >
      {/* 右上角悬浮控制：分段切换 + 复制（ChatGPT artifact 同款布局） */}
      <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            {
              value: "preview",
              label: "预览",
              icon: <Eye size={12} strokeWidth={2.2} aria-hidden />,
            },
            {
              value: "source",
              label: "源码",
              icon: <Braces size={12} strokeWidth={2.2} aria-hidden />,
            },
          ]}
          className=" bg-background border "
        />
        <CodeBlockCopyButton
          code={code}
          className="rounded-full bg-background p-2 border hover:bg-foreground/[0.1]"
        />
      </div>
      {mode === "preview" ? (
        <div
          className="flex min-h-[120px] items-center justify-center p-6 [&>svg]:h-auto [&>svg]:max-h-[70vh] [&>svg]:w-auto [&>svg]:max-w-full"
          // 内容已经过 DOMPurify 消毒（剥除 script/事件处理器等）
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      ) : (
        // 源码态复用 streamdown 的 CodeBlock 走 Shiki 高亮（不传 children，
        // 其自带 header/actions 由 markdown.css 在 artifact-block 作用域内隐去）。
        // shiki 没有 "svg" 语法（svg 围栏此前一直是纯文本），按 XML 高亮。
        <CodeBlock code={code} language="xml" />
      )}
    </div>
  );
};

export const SvgCodeBlock = memo(SvgCodeBlockImpl);
