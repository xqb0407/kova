"use client";

import {
  type ComponentProps,
  useDeferredValue,
  useEffect,
  Fragment,
  type FC,
  memo,
  useMemo,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  splitFrontmatter,
  type FrontmatterValue,
} from "@/lib/markdown/markdown-frontmatter";
import { useAuiState } from "@assistant-ui/react";
import {
  DEFAULT_SHIKI_THEME,
  tailBoundedRemend,
} from "@assistant-ui/react-streamdown";
import {
  Streamdown,
  type CustomRenderer,
  type PluginConfig,
} from "streamdown";
import type { CodeHighlighterPlugin } from "@streamdown/code";
import { openExternal } from "@/lib/external-link";
import { SiteIcon } from "@/components/custom-ui/site-icon";
// animated 词级入场动画的 keyframes（streamdown 包根自带的纯 CSS，不走 Tailwind）
import "streamdown/styles.css";
import "@/app/styles/markdown.css";

/**
 * renderers 是 streamdown 原生的按围栏语言注册自定义渲染的机制。
 * 注意：@assistant-ui/react-streamdown 的 StreamdownTextPrimitive 在归一化
 * plugins 时只认 code/math/cjk/mermaid 四个键、会丢弃 renderers（0.3.13 为
 * 最新版仍如此），所以消息流分支改用下方 StreamdownPart 直连原生 Streamdown。
 */
type LazyPlugins = {
  shared: PluginConfig;
  streaming: PluginConfig;
};

let pluginsPromise: Promise<LazyPlugins> | null = null;

/**
 * 重插件按需加载：Shiki/Mermaid/KaTeX/CJK 插件与 svg/mermaid 代码块 renderer
 * 只在第一条 Markdown 真正上屏后才拉取。首帧消息文字走 Streamdown 核心
 * （代码块先以纯文本呈现），插件 chunk 到达后原地升级为高亮/图表。
 *
 * 流式期间不高亮（原策略保留）：isIncomplete 时 highlight 返回 null，避免
 * 每个 token 整块重建 span；缓存键只由代码文本决定，流式中每 chunk 都是
 * cache miss。完成态仍一次性上色。
 */
function loadPlugins(): Promise<LazyPlugins> {
  if (pluginsPromise) return pluginsPromise;
  pluginsPromise = Promise.all([
    import("@streamdown/code"),
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
    import("@streamdown/cjk"),
    import("./svg-code-block"),
    import("./mermaid-code-block"),
  ]).then(
    ([codeMod, mathMod, mermaidMod, cjkMod, svgMod, mermaidBlockMod]) => {
      const code = codeMod.code;
      const codeNotWhileStreaming: CodeHighlighterPlugin = {
        ...code,
        highlight: (options, callback) => {
          if ((options as { isIncomplete?: boolean }).isIncomplete) return null;
          return code.highlight(options, callback);
        },
      };
      const codeNeverWhileStreaming: CodeHighlighterPlugin = {
        ...code,
        highlight: () => null,
      };
      const shared: PluginConfig = {
        code: codeNotWhileStreaming,
        math: mathMod.math,
        mermaid: mermaidMod.mermaid,
        cjk: cjkMod.cjk,
        renderers: [
          { language: "svg", component: svgMod.SvgCodeBlock },
          { language: "mermaid", component: mermaidBlockMod.MermaidCodeBlock },
        ] satisfies CustomRenderer[],
      };
      return {
        shared,
        streaming: { ...shared, code: codeNeverWhileStreaming },
      };
    },
  );
  return pluginsPromise;
}

function useMarkdownPlugins(): LazyPlugins | null {
  const [plugins, setPlugins] = useState<LazyPlugins | null>(null);
  useEffect(() => {
    let alive = true;
    loadPlugins()
      .then((next) => {
        if (alive) setPlugins(next);
      })
      .catch(() => {
        /* 插件加载失败：保持纯文本代码块，不影响正文 */
      });
    return () => {
      alive = false;
    };
  }, []);
  return plugins;
}

const sharedComponents = {
  // 正文外链：短站点图标 + 链接文字，悬浮 title 显示完整 href，
  // 点击走系统浏览器（桌面 webview 里裸 <a> 无人接管 target=_blank，点了没反应）。
  // 非 http(s)（页内锚点/mailto/相对路径）维持原样。
  a: ({ children, href, ...props }) => {
    // data: 链接绝不交由顶层导航：超大 data URL 会把整个窗口替换成
    // Chromium 的「Data payload too large」错误页，只能重载恢复
    if (href && /^\s*data:/i.test(href)) {
      return (
        <span title="内联数据链接（已阻止导航）" {...props}>
          {children}
        </span>
      );
    }
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
const FrontmatterCard: FC<{ entries: [string, FrontmatterValue][] }> = ({ entries }) => (
 <div className="mb-4 overflow-hidden rounded-lg border border-border/70 text-xs bg-muted/60">
      <div className="px-3 py-2 font-medium text-muted-foreground ">
        元信息
      </div>
      <div className="flex flex-wrap gap-2 px-3 py-3 border border-border/60 rounded-md border-l-0 border-r-0 border-b-0 bg-background">
        {entries.map(([_key, value]) => (
          <Fragment key={_key}>
            {Array.isArray(value)
              ? value.map((item, i) => (
                  <span
                    key={i}
                    className="bg-muted font-medium inline-block rounded px-1.5 py-0.5 "
                  >
                    {item}
                  </span>
                ))
              : value && (
                  <span className="inline-block rounded px-1.5 py-0.5">
                    {value}
                  </span>
                )}
          </Fragment>
        ))}
      </div>
    </div>
);

// useMessagePartText 已废弃（v0.12 迁移）：改用 useAuiState 选择并 narrow `s.part`。
// selector 跑在 useSyncExternalStore 的 getSnapshot 里，绝不能 throw（线程切换时的
// 瞬时 part 不匹配会掀掉整个 React 根）；类型不匹配时回退到这个冻结的空 text part
// 哨兵，保证快照稳定 —— 与废弃 hook 内部实现一致。
const EMPTY_TEXT_PART = Object.freeze({
  type: "text",
  text: "",
  status: Object.freeze({ type: "complete" }),
});

/**
 * 消息流分支：等价于 StreamdownTextPrimitive 的默认路径
 * （消息 part 上下文 → defer → 尾部 remend；Streamdown 内置
 *  `parseIncompleteMarkdown` 显式关闭，避免同段文本每 token 修复两遍），
 * 只是把 plugins 原样透传，让 renderers 生效（见上方注释）。
 *
 * 流式分支刻意不开 `useSmooth`（逐字打字机）：它的渲染快照永远是
 * `slice(0, n)` 的字符级前缀，揭示位置必然切进语法构造内部——`## ` 切在
 * `#` 和 `# ` 之间、表格切在分隔行到达前、块边界切在两个 `\n` 中间（新块
 * 和上一段黏成一个段落块，标记原样显出）。尾部修补救不了这种切断：
 * `tailBoundedRemend` 与 Streamdown 内置 `parseIncompleteMarkdown` 底层同
 * 为 remend，只闭合行内语法（粗体/行内码/链接/公式），不补块级结构；
 * 且 smooth 的揭示滞后于源文本，半成品前缀会在屏上驻留，流式全程裸
 * markdown。官方形态即默认 smooth=false + `animated` 入场动画（caret 本项目不挂，见下）；
 * 要逐字打字机又不裸显，需自建结构边界回退揭示，勿改回原状。
 */
/**
 * 逐字动画的长度闸门：动画节点数随正文线性涨（char 分词时每个字符一个
 * span，word 分词中文也会切出巨型 token），且每帧都要重新过 rehype 管线。
 * 短回答开着提升观感；正文一长就整段关掉（fadeIn 是纯装饰，关掉不改变
 * 内容，只回到普通 markdown 渲染）。20k 大约是「一屏读不完」的量级。
 */
const ANIMATION_MAX_CHARS = 20_000;

/** 流式动画配置：必须是模块级常量。Streamdown 的外层 memo 用引用比较
 *  `animated`，每次渲染新建对象会让整棵 Streamdown 重新执行、分块 memo
 *  的收益全部落空（每个 token 都会走两趟：紧急渲染 + deferred 渲染）。 */
const STREAM_ANIMATION: Exclude<
  ComponentProps<typeof Streamdown>["animated"],
  boolean | undefined
> = {
  animation: "fadeIn",
  duration: 150,
  stagger: 20,
  sep: "word",
  maxBacklogMs: 450,
};

const StreamdownPart = ({ plugins }: { plugins: LazyPlugins | null }) => {
  const part = useAuiState((s) =>
    s.part.type === "text" || s.part.type === "reasoning"
      ? s.part
      : EMPTY_TEXT_PART,
  );
  const { text, status } = part;
  const running = status.type === "running";
  // 对齐 primitive 的 defer：解析降到低优先级，token 到达不阻塞输入/滚动
  const deferredText = useDeferredValue(text);
  // 与 primitive 默认管线一致：tail remend 补行内尾部语法。这里已经把
  // 修复做完了，所以下面必须把 Streamdown 的 parseIncompleteMarkdown 关掉
  // ——上游 StreamdownText 在启用 tailBoundedRemend 时同样把该项解析为
  // false（`resolvedParseIncomplete`）。否则同一段文本每 token 会被 remend
  // 全量扫描两遍，流式正文越长重复开销越大。
  const repairedText = useMemo(
    () => tailBoundedRemend(deferredText),
    [deferredText],
  );
  // 完成态一律 static：Streamdown 的 streaming 模式带 remend/block state
  // 更新循环，历史消息挂在上面只会白付成本（对齐 react-pi 上游的
  // resolveMessageStreamdownMode 语义）。动画同理：只在「还在跑且文本
  // 足够短」时开，word 分词（char 的动画节点数 = 新增字符数，实测最坏帧
  // 是 word 的 4 倍，见 git 历史 d9f24e1 的回退记录）。
  const animate = running && deferredText.length <= ANIMATION_MAX_CHARS;
  return (
    <div data-status={status.type}>
      <Streamdown
        mode={running ? "streaming" : "static"}
        // 修复已由上方 tailBoundedRemend 完成，别再让 streamdown 全量跑一遍
        parseIncompleteMarkdown={false}
        isAnimating={animate}
        // 逐词入场动画（仅短文本流式时，见上方 animate 的闸门）。sep 用
        // word 不用 char：char 的动画节点数 = 新增字符数，中文长句每帧都
        // 在重建几百个 span，实测最坏帧是 word 的 4 倍（git 历史 d9f24e1
        // 的回退记录）；word 分支按 \s 切词，中文长句会切成巨型 token——
        // 观感差异远小于性能差。maxBacklogMs 的语义（dist `take`）：
        // step = max(4, (now+maxBacklogMs-cursor)/(n-1))，n = 本批新增词数
        // —— 大批量落地时它把 stagger 压到形同失效。
        animated={animate ? STREAM_ANIMATION : false}
        // 光标（caret）刻意不传：streamdown 的实现是「caret 为真 且 isAnimating 时」
        // 才写 `--streamdown-caret` 变量、并在末块上加 `after:content-[var(--streamdown-caret)]`；
        // 只要这个 prop 缺省，变量与类名都不会挂上，光标自然不存在 —— 不需要额外 CSS 兜。
        plugins={running ? plugins?.streaming : plugins?.shared}
        shikiTheme={DEFAULT_SHIKI_THEME}
        components={sharedComponents}
        className="aui-md text-[0.9375rem] leading-[1.5]"
      >
        {repairedText}
      </Streamdown>
    </div>
  );
};

const MarkdownTextImpl = ({ text, className }: { text?: string; className?: string }) => {
  const plugins = useMarkdownPlugins();
  // frontmatter 只在整篇现成文本里拆（流式分支取的是消息 part 上下文，没有整篇 text）
  const fm = useMemo(() => (text ? splitFrontmatter(text) : null), [text]);
  return (
    <div
      className={cn(
        "aui-markdown",
        "overflow-hidden wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
        className,
      )}
    >
      {text === undefined ? (
        <StreamdownPart plugins={plugins} />
      ) : (
        // 现成的完整文本（非消息流，如压缩摘要）：不走 part 上下文，直接渲染
        <>
          {fm ? <FrontmatterCard entries={fm.entries} /> : null}
          <Streamdown
            plugins={plugins?.shared}
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
