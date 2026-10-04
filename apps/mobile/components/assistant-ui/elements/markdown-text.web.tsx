"use client";

import type { TextMessagePartProps } from "@assistant-ui/react-native";
import {
  DEFAULT_SHIKI_THEME,
  tailBoundedRemend,
} from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown, type PluginConfig } from "streamdown";

import {
  splitFrontmatter,
  type FrontmatterValue,
} from "@/lib/markdown/markdown-frontmatter";

/**
 * web 端 markdown 渲染：与主工程 `apps/desktop/components/assistant-ui/elements/
 * markdown-text.tsx` 同一套 streamdown 管线（插件、shiki 主题、组件覆写、
 * 流式修补全部对齐），这样同一条回复在桌面端和手机网页上是同一个样子。
 *
 * 为什么单独一个 `.web.tsx` 而不是直接改原文件：streamdown 底下是
 * react-markdown + shiki + mermaid，全都是 DOM 实现，在 React Native 上
 * 没有对应物。原生端走 `markdown-text.tsx` 的 react-native-marked 渲染器
 * —— 两端渲染器不同，但流式节流、代码块复制、任务列表这些行为保持一致。
 *
 * 与主工程的差异（都是桌面端专属、在这边没有对应物的部分）：
 * - 外链不再拦截走 `openExternal`（那是 Tauri 的系统浏览器）。网页上直接
 *   target=_blank 就是浏览器新标签，拦截反而多余。
 * - 不带 SiteIcon（桌面端按域名拉 favicon）、不带 ```svg 的预览/源码分段器
 *   （依赖 lucide-react 与桌面端 Segmented 组件）；svg 围栏仍按代码块渲染。
 *
 * 样式不在这里 import CSS：`import "streamdown/styles.css"` 过不了 Metro，
 * 那份样式与主工程的 markdown.css 一起并进了 `global.css`，并用 `@source`
 * 把 streamdown 各包的 dist 登记成 Tailwind 扫描源（streamdown 的默认组件
 * 整套都是 Tailwind 类名，没有这一步等于没上样式）。
 */

const plugins: PluginConfig = { code, math, mermaid, cjk };

/** 主题变量名与主工程一致：这里靠 global.css 的 @theme 令牌取色 */
const components = {
  // 正文外链：主工程在桌面端把点击拦给系统浏览器并挂站点图标；网页上交给
  // 浏览器新标签即可，rel 补上 opener 隔离
  a: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary decoration-primary/40 underline decoration-1 underline-offset-2 hover:decoration-primary"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }: React.ComponentProps<"table">) => (
    <div className="my-3 overflow-x-auto rounded-md border border-border">
      <table
        className="w-full text-[0.9375rem] [&>thead]:bg-muted [&>thead>tr>th]:bg-muted"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.ComponentProps<"th">) => (
    <th className="bg-muted px-3 py-2 text-left font-medium" {...props}>
      {children}
    </th>
  ),
  tr: ({ children, ...props }: React.ComponentProps<"tr">) => (
    <tr className="border-border/30" {...props}>
      {children}
    </tr>
  ),
  td: ({ children, ...props }: React.ComponentProps<"td">) => (
    <td className="text-foreground px-3 py-2" {...props}>
      {children}
    </td>
  ),
  blockquote: ({ children, ...props }: React.ComponentProps<"blockquote">) => (
    <blockquote
      className="border-border text-foreground/70 mb-2 border-l-2 pl-3 text-sm italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
};

/**
 * 文档开头的 YAML frontmatter 卡片：直接把整篇交给 markdown 渲染时，
 * 元数据块会被 CommonMark 当成 setext 标题撑成巨型字号，这里拆出来
 * 以键值对展示（数组渲染成小徽章），正文再走 Streamdown。
 */
const FrontmatterCard = ({ entries }: { entries: [string, FrontmatterValue][] }) => (
  <div className="mb-4 overflow-hidden rounded-md border border-border/80 text-xs">
    <div className="text-muted-foreground px-3 py-1.5 font-medium">元信息</div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 py-2.5 leading-relaxed">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground break-all font-mono">{key}</dt>
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

const STREAM_INTERVAL_MS = 50;

/** 与原生端 markdown-text.tsx 同一套节流：流式期间每个 token 都重排整棵
 *  markdown 树，不批一下就跟不上打字速度 */
const useThrottledValue = <T,>(value: T, intervalMs: number): T => {
  const [throttled, setThrottled] = useState(value);
  const lastEmitRef = useRef(0);

  useEffect(() => {
    const delay = Math.max(0, intervalMs - (Date.now() - lastEmitRef.current));
    const timer = setTimeout(() => {
      lastEmitRef.current = Date.now();
      setThrottled(value);
    }, delay);
    return () => clearTimeout(timer);
  }, [value, intervalMs]);

  return throttled;
};

type MarkdownTextProps = TextMessagePartProps & {
  variant?: "muted";
};

const MarkdownTextImpl = ({ text, status, variant }: MarkdownTextProps) => {
  const running = status.type === "running";
  const throttled = useThrottledValue(text, STREAM_INTERVAL_MS);
  // 对齐主工程的流式修补：只 remend 末尾那个块（remend 是行内语法闭合，
  // 切进块结构内部救不回来，窗口化才不会把已经稳定的开头反复重排）
  const deferred = useMemo(() => tailBoundedRemend(throttled), [throttled]);
  // frontmatter 只在写完之后拆：流到一半的 `---` 会被当成水平线，
  // 拆出来的「元信息」卡片会在正文前面反复闪现
  const frontmatter = useMemo(
    () => (running ? null : splitFrontmatter(text)),
    [running, text],
  );

  return (
    <div
      className={[
        "aui-markdown overflow-hidden wrap-break-word",
        // 思考块走 muted：正文偏灰，跟正式回复区分开
        variant === "muted" ? "text-muted-foreground" : null,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {frontmatter ? (
        <FrontmatterCard entries={frontmatter.entries} />
      ) : null}
      <Streamdown
        // mode="streaming" + isAnimating：流式分支沿用官方形态——smooth 逐字
        // 打字机不开（它切出来的字符前缀必然落在语法构造内部，裸显 markdown），
        // 只保留词级入场动画与块光标
        mode="streaming"
        isAnimating={running}
        animated={{ animation: "blurIn" }}
        caret="block"
        plugins={plugins}
        shikiTheme={DEFAULT_SHIKI_THEME}
        // 手机屏宽金贵：行号占一列 gutter，代码本来就横滚，再挤一格更难读。
        // （streamdown 默认 lineNumbers=true）
        lineNumbers={false}
        components={components}
        className="aui-md text-[0.9375rem] leading-[1.5]"
      >
        {frontmatter ? frontmatter.body : deferred}
      </Streamdown>
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
