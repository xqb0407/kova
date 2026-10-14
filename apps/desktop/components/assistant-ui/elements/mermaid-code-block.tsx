"use client";

import { memo, useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { Braces, Eye, ZoomIn, ZoomOut } from "lucide-react";
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from "streamdown";
import { mermaid as mermaidPlugin } from "@streamdown/mermaid";
import { Segmented } from "@/components/custom-ui/segmented";
import { cn } from "@/lib/utils";

/**
 * ```mermaid 围栏的自定义渲染（经 streamdown 的 plugins.renderers 注册，
 * 优先于内置 mermaid 插件分发）：与 svg 块同款的 ChatGPT artifact 卡片，
 * 右上角悬浮「缩小/放大 + 预览/源码 + 复制」。
 *
 * 渲染复用 @streamdown/mermaid 的单例实例（getMermaid，默认
 * theme:default / securityLevel:strict），产物再过一遍 DOMPurify 双保险；
 * 源码态走 streamdown CodeBlock（shiki 自带 mermaid 语法）。
 */

type MermaidViewMode = "preview" | "source";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.25;

/** mermaid.render 要求全局唯一 id，模块级自增即可 */
let renderSeq = 0;

function ZoomButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-full border bg-background p-2 transition-colors",
        "hover:bg-foreground/[0.1]",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-background",
      )}
    >
      {children}
    </button>
  );
}

const MermaidCodeBlockImpl = ({ code, isIncomplete, language }: CustomRendererProps) => {
  const [mode, setMode] = useState<MermaidViewMode>("preview");
  const [zoom, setZoom] = useState(1);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // 围栏还在流式生成：先按普通代码块展示，避免半截语法反复触发渲染/报错
  const streaming = isIncomplete;

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    setSvgHtml(null);
    setFailed(false);
    const instance = mermaidPlugin.getMermaid();
    instance
      .render(`zcode-mermaid-${++renderSeq}`, code)
      .then(({ svg }) => {
        if (cancelled) return;
        // mermaid 的节点标签是 foreignObject 里的 div/span/p。DOMPurify
        // 默认对此有三道封锁，缺一图就"有图没字"：
        // 1. svg profile 不含 foreignObject 标签 → ADD_TAGS 放行；
        // 2. 标签内容要 html profile 放行 div/span/p；
        // 3. 3.4.x 把 foreignobject 从 HTML 集成点表里剔除（mXSS 加固），
        //    SVG 父级下的 HTML 元素会被命名空间校验杀掉 → 显式放行。
        // 首层消毒已由 mermaid securityLevel:strict 完成，script/事件
        // 处理器/危险协议在 DOMPurify 默认规则下依旧全部拦截。
        setSvgHtml(
          DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true, html: true },
            ADD_TAGS: ["foreignObject"],
            HTML_INTEGRATION_POINTS: { foreignobject: true },
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, streaming]);

  // 语法错误：退回源码展示（streamdown 内置块同样不渲染残缺图）
  if (failed) {
    return <CodeBlock code={code} language={language} />;
  }

  return (
    <div
      className="relative my-4 overflow-hidden rounded-xl border border-border/70 bg-card"
      data-streamdown="artifact-block"
    >
      {/* 右上角悬浮控制：缩放 + 分段切换 + 复制（与 svg 块同款布局） */}
      <div className="absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5">
        <ZoomButton
          title="缩小"
          disabled={mode !== "preview" || zoom <= ZOOM_MIN}
          onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP))}
        >
          <ZoomOut size={14} strokeWidth={2.2} aria-hidden />
        </ZoomButton>
        <ZoomButton
          title="放大"
          disabled={mode !== "preview" || zoom >= ZOOM_MAX}
          onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP))}
        >
          <ZoomIn size={14} strokeWidth={2.2} aria-hidden />
        </ZoomButton>
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
          className="bg-background border"
        />
        <CodeBlockCopyButton
          code={code}
          className="rounded-full bg-background p-2 border hover:bg-foreground/[0.1]"
        />
      </div>
      {mode === "preview" ? (
        <div className="max-h-[70vh] overflow-auto p-6">
          {svgHtml ? (
            <div
              className="mx-auto w-fit origin-top [&>svg]:max-w-full"
              style={{ transform: `scale(${zoom})` }}
              // mermaid 产物已经 securityLevel:strict + DOMPurify 双重消毒
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          ) : (
            <div className="mx-auto h-32 w-full max-w-[240px] animate-pulse rounded-md bg-muted" />
          )}
        </div>
      ) : (
        // 源码态：streamdown CodeBlock 走 Shiki（artifact-block 作用域 CSS 会剥掉
        // 它自带的 header/卡片壳，见 markdown.css [data-streamdown="artifact-block"]）
        <CodeBlock code={code} language={language} />
      )}
    </div>
  );
};

export const MermaidCodeBlock = memo(MermaidCodeBlockImpl);
