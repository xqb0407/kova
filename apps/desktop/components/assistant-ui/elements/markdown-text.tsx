"use client";

import { type ComponentProps, memo } from "react";
import { cn } from "@/lib/utils";
import {
  StreamdownTextPrimitive,
  useStreamdownPreProps,
} from "@assistant-ui/react-streamdown";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import { openExternal } from "@/lib/external-link";
import { SiteIcon } from "@/components/custom-ui/site-icon";
import "@/app/styles/markdown.css";

const sharedPlugins = { code, math, mermaid, cjk };

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
    <div className="overflow-x-auto my-3 border rounded-md">
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
      className="text-left font-medium px-3 py-2 bg-[#f0f0f0]"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      className="px-3 py-2 border-t text-an-foreground"
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

const MarkdownTextImpl = ({ text }: { text?: string }) => {
  return (
    <div
      className={cn(
        "aui-markdown",
        "overflow-hidden wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
      )}
    >
      {text === undefined ? (
        <StreamdownTextPrimitive
          plugins={sharedPlugins}
          className="aui-md text-[0.9375rem] leading-[1.5]"
          components={sharedComponents}
          // 流式解析降到低优先级：token 到达不再阻塞输入/滚动，负载高时跳过中间帧
          defer
        />
      ) : (
        // 现成的完整文本（非消息流，如压缩摘要）：不走 part 上下文，直接渲染
        <Streamdown
          plugins={sharedPlugins}
          className="aui-md text-[0.9375rem] leading-[1.5]"
          components={sharedComponents}
          parseIncompleteMarkdown={false}
        >
          {text}
        </Streamdown>
      )}
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
