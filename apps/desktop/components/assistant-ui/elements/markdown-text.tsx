"use client";

import {
  type ComponentProps,
  useDeferredValue,
  Fragment,
  type FC,
  memo,
  useMemo,
} from "react";
import { cn } from "@/lib/utils";
import {
  splitFrontmatter,
  type FrontmatterValue,
} from "@/lib/markdown/markdown-frontmatter";
import { useMessagePartText, useSmooth } from "@assistant-ui/react";
import {
  DEFAULT_SHIKI_THEME,
  tailBoundedRemend,
} from "@assistant-ui/react-streamdown";
import {
  Streamdown,
  type CustomRenderer,
  type PluginConfig,
} from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import { openExternal } from "@/lib/external-link";
import { SiteIcon } from "@/components/custom-ui/site-icon";
import { SvgCodeBlock } from "@/components/assistant-ui/elements/svg-code-block";
import { MermaidCodeBlock } from "@/components/assistant-ui/elements/mermaid-code-block";
import "@/app/styles/markdown.css";

/**
 * renderers 是 streamdown 原生的按围栏语言注册自定义渲染的机制。
 * 注意：@assistant-ui/react-streamdown 的 StreamdownTextPrimitive 在归一化
 * plugins 时只认 code/math/cjk/mermaid 四个键、会丢弃 renderers（0.3.13 为
 * 最新版仍如此），所以消息流分支改用下方 StreamdownPart 直连原生 Streamdown。
 */
const sharedPlugins: PluginConfig = {
  code,
  math,
  mermaid,
  cjk,
  renderers: [
    { language: "svg", component: SvgCodeBlock },
    { language: "mermaid", component: MermaidCodeBlock },
  ] satisfies CustomRenderer[],
};

const sharedComponents = {
  // 正文外链：短站点图标 + 链接文字，悬浮 title 显示完整 href，
  // 点击走系统浏览器（桌面 webview 里裸 <a> 无人接管 target=_blank，点了没反应）。
  // 非 http(s)（页内锚点/mailto/相对路径）维持原样。
  a: ({ children, href, ...props }) => {
    if (!href || !/^https?:\/\//i.test(href))
      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    return (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          // 让 ⌘/ctrl/中键等修饰点击落回浏览器原生行为
          if (
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          )
            return;
          e.preventDefault();
          openExternal(href);
        }}
        className="text-primary decoration-primary/40 underline decoration-1 underline-offset-2 hover:decoration-primary"
        {...props}
      >
        <SiteIcon url={href} className="mr-1 inline-block align-[-0.2em]" />
        {children}
      </a>
    );
  },
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto my-3 border border-muted rounded-md">
      <table
        className="w-full text-[0.9375rem] [&>thead]:bg-muted [&>thead>tr>th]:bg-muted"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th
      className="text-left font-medium px-3 py-2 bg-muted"
      {...props}
    >
      {children}
    </th>
  ),
  tr: ({ children, ...props }) => (
    <tr
      className="border-border/30"
      {...props}
    >
      {children}
    </tr>
  ),
  td: ({ children, ...props }) => (
    <td
      className="px-3 py-2  text-an-foreground"
      {...props}
    >
      {children}
    </td>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="  pl-3 italic mb-2 text-sm border-l-2 border-an-border-color text-foreground/70"
      {...props}
    >
      {children}
    </blockquote>
  ),
} satisfies ComponentProps<typeof Streamdown>["components"];

/**
 * 文档开头的 YAML frontmatter 卡片：直接把整篇交给 markdown 渲染时，
 * 元数据块会被 CommonMark 当成 setext 标题撑成巨型字号，这里拆出来
 * 以键值对展示（数组渲染成小徽章），正文再走下方 Streamdown。
 */
const FrontmatterCard: FC<{ entries: [string, FrontmatterValue][] }> = ({
  entries,
}) => (
  <div className="mb-4 overflow-hidden rounded-md border border-border/80 text-xs">
    <div className="px-3 py-1.5 font-medium text-muted-foreground">
      元信息
    </div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5 leading-relaxed">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="break-all font-mono text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words whitespace-pre-wrap">
            {Array.isArray(value) ? (
              value.map((item, i) => (
                <span
                  key={i}
                  className="bg-muted mr-1 inline-block rounded px-1.5 py-px"
                >
                  {item}
                </span>
              ))
            ) : value ? (
              value
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  </div>
);

/**
 * 消息流分支：等价于 StreamdownTextPrimitive 的默认路径
 * （消息 part 上下文 → smooth → defer → 尾部 remend），
 * 只是把 plugins 原样透传，让 renderers 生效（见上方注释）。
 */
const StreamdownPart = () => {
  const messagePart = useMessagePartText();
  const { text, status } = useSmooth(messagePart, false);
  // 对齐 primitive 的 defer：解析降到低优先级，token 到达不阻塞输入/滚动
  const deferredText = useDeferredValue(text);
  // primitive 在流式分支用 tail remend 补全尾部语法，并关掉 Streamdown 自带的
  // parseIncompleteMarkdown，这里保持一致
  const repairedText = useMemo(
    () => tailBoundedRemend(deferredText),
    [deferredText],
  );
  return (
    <div data-status={status.type}>
      <Streamdown
        mode="streaming"
        isAnimating={status.type === "running"}
        parseIncompleteMarkdown={false}
        plugins={sharedPlugins}
        shikiTheme={DEFAULT_SHIKI_THEME}
        components={sharedComponents}
        className="aui-md text-[0.9375rem] leading-[1.5]"
      >
        {repairedText}
      </Streamdown>
    </div>
  );
};

const MarkdownTextImpl = ({ text }: { text?: string }) => {
  // frontmatter 只在整篇现成文本里拆（流式分支取的是消息 part 上下文，没有整篇 text）
  const fm = useMemo(() => (text ? splitFrontmatter(text) : null), [text]);
  return (
    <div
      className={cn(
        "aui-markdown",
        "overflow-hidden wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
      )}
    >
      {text === undefined ? (
        <StreamdownPart />
      ) : (
        // 现成的完整文本（非消息流，如压缩摘要）：不走 part 上下文，直接渲染
        <>
          {fm ? <FrontmatterCard entries={fm.entries} /> : null}
          <Streamdown
            plugins={sharedPlugins}
            className="aui-md text-[0.9375rem] leading-[1.5]"
            components={sharedComponents}
            parseIncompleteMarkdown={false}
          >
            {fm ? fm.body : text}
          </Streamdown>
        </>
      )}
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
