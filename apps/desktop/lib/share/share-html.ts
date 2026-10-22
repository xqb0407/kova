"use client";

/**
 * 分享页生成器：把 ShareDoc 渲染成一个完全自包含的 HTML 文档（内联 CSS、
 * data URL 图片、零脚本、零外部请求）。同一份产物同时用于：
 * - 「保存网页」：直接写盘，浏览器打开即读；
 * - 「生成图片」：主进程隐藏窗口加载后截图，所见即所得。
 *
 * 主题对齐应用本体：渲染层把当前生效的设计令牌（globals.css 的
 * --background/--muted/--primary…）收集进来原样注入，气泡、代码卡、正文
 * 排版也按消息区的样式镜像，导出物和 App 里看到的一致。
 *
 * 安全：Markdown 允许内联 HTML，因此渲染结果必须先过 DOMPurify 再拼进文档。
 * 测试环境没有 DOM，sanitizer 可注入（见 share-html.test.ts）。
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import type { ShareBlock, ShareDoc } from "./share-doc";

export type ShareColorScheme = "light" | "dark";

export type ShareHtmlOptions = {
  /** 应用当前主题的设计令牌（collectShareTheme 的产物）；缺省用浅色默认值 */
  tokens?: Record<string, string>;
  colorScheme?: ShareColorScheme;
};

export type Sanitize = (html: string) => string;

const defaultSanitize: Sanitize = (html) =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // 分享页允许锚点跳转，但不要保留事件处理器/脚本类属性
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
  });

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeAttr = escapeHtml;

/** 会随分享页带走的应用设计令牌（globals.css :root 同名变量） */
const THEME_VARS = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--popover",
  "--border",
  "--input",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent",
  "--accent-foreground",
  "--ring",
  "--radius",
  "--code-surface",
  "--app-font-sans",
] as const;

/** 无 DOM 环境（测试/SSR）的兜底：globals.css 浅色默认值 */
const DEFAULT_TOKENS: Record<string, string> = {
  "--background": "oklch(1 0 0)",
  "--foreground": "oklch(0.145 0 0)",
  "--muted": "oklch(0.97 0 0)",
  "--muted-foreground": "oklch(0.556 0 0)",
  "--card": "oklch(1 0 0)",
  "--popover": "oklch(1 0 0)",
  "--border": "oklch(0.922 0 0)",
  "--input": "oklch(0.922 0 0)",
  "--primary": "oklch(0.205 0 0)",
  "--primary-foreground": "oklch(0.985 0 0)",
  "--secondary": "oklch(0.97 0 0)",
  "--secondary-foreground": "oklch(0.205 0 0)",
  "--accent": "oklch(0.97 0 0)",
  "--accent-foreground": "oklch(0.205 0 0)",
  "--ring": "oklch(0.708 0 0)",
  "--radius": "0.625rem",
  "--code-surface":
    "color-mix(in oklab, var(--foreground) 4%, var(--background))",
  "--app-font-sans":
    '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
};

/** 从当前应用根节点读取生效主题（对话框挂载时调用，随开随取） */
export function collectShareTheme(): {
  tokens: Record<string, string>;
  colorScheme: ShareColorScheme;
} {
  if (typeof window === "undefined") {
    return { tokens: { ...DEFAULT_TOKENS }, colorScheme: "light" };
  }
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return {
    tokens,
    colorScheme: document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  };
}

/** 独立实例：renderer 扩展不能挂全局 marked（streamdown 用的就是同一个包） */
const shareMarked = new Marked();
shareMarked.use({
  renderer: {
    // 代码块渲染成 App 同款「muted 卡片 + 语言标签 + 代码体」
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      return `<div class="code-card">${
        language ? `<div class="code-lang">${escapeHtml(language)}</div>` : ""
      }<pre><code>${escapeHtml(text ?? "")}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(
  markdown: string,
  sanitize: Sanitize = defaultSanitize,
  breaks = false,
): string {
  const raw = shareMarked.parse(markdown, {
    gfm: true,
    // 用户消息按聊天习惯把单个换行当换行；助手正文保持标准 Markdown
    breaks,
    async: false,
  }) as string;
  return sanitize(raw);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatShareTime(timestamp: number): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const renderTool = (block: Extract<ShareBlock, { kind: "tool" }>): string =>
  `<div class="tool${block.failed ? " tool-failed" : ""}"><span class="tool-dot"></span><span class="tool-name">${escapeHtml(block.name)}</span><span class="tool-state">${block.failed ? "失败" : "完成"}</span></div>`;

const renderImage = (block: Extract<ShareBlock, { kind: "image" }>): string =>
  `<img src="${escapeAttr(block.src)}" alt="${escapeAttr(block.alt ?? "图片")}" loading="eager" />`;

const renderBlocks = (
  blocks: readonly ShareBlock[],
  sanitize: Sanitize,
  breaks: boolean,
): string => {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === "tool") {
      const tools: string[] = [];
      while (i < blocks.length && blocks[i].kind === "tool") {
        tools.push(renderTool(blocks[i] as Extract<ShareBlock, { kind: "tool" }>));
        i += 1;
      }
      out.push(`<div class="tools">${tools.join("")}</div>`);
      continue;
    }
    if (block.kind === "image") {
      const images: string[] = [];
      while (i < blocks.length && blocks[i].kind === "image") {
        images.push(
          renderImage(blocks[i] as Extract<ShareBlock, { kind: "image" }>),
        );
        i += 1;
      }
      out.push(`<div class="imgs">${images.join("")}</div>`);
      continue;
    }
    if (block.kind === "reasoning") {
      out.push(
        `<div class="reasoning"><div class="reasoning-label">思考过程</div><div class="md">${renderMarkdown(block.markdown, sanitize)}</div></div>`,
      );
      i += 1;
      continue;
    }
    out.push(`<div class="md">${renderMarkdown(block.markdown, sanitize, breaks)}</div>`);
    i += 1;
  }
  return out.join("");
};

/** 用户消息引用块（App 同款：气泡内小字斜体 + 引号图标） */
const QUOTE_ICON = `<svg class="quote-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`;

const renderMessage = (message: ShareDoc["messages"][number], sanitize: Sanitize): string => {
  if (message.role === "user") {
    const quote = message.quote
      ? `<div class="quote">${QUOTE_ICON}<span>${escapeHtml(message.quote)}</span></div>`
      : "";
    return `<section class="msg msg-user"><div class="bubble">${quote}${renderBlocks(message.blocks, sanitize, true)}</div></section>`;
  }
  const badge = message.incomplete
    ? `<span class="badge">回复未完成</span>`
    : "";
  return `<section class="msg msg-assistant"><div class="role">扣瓦${badge}</div><div class="body">${renderBlocks(message.blocks, sanitize, false)}</div></section>`;
};

const CSS = `
:root{ color-scheme:light; }
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; }
body{
  background:var(--background); color:var(--foreground);
  font-family:var(--app-font-sans);
  font-size:15px; line-height:1.7;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.doc{ width:780px; max-width:calc(100% - 40px); margin:0 auto; padding:36px 0 44px; }
.doc-head{ display:flex; align-items:baseline; justify-content:space-between; gap:16px; padding-bottom:14px; border-bottom:0.5px solid var(--border); }
.doc-title{ margin:0; font-size:16px; font-weight:600; letter-spacing:-.01em; min-width:0; word-break:break-word; }
.doc-meta{ flex:none; font-size:12px; color:var(--muted-foreground); }
.messages{ margin-top:26px; display:flex; flex-direction:column; gap:22px; }
.msg{ min-width:0; }
/* 用户消息：App 同款右对齐 muted 气泡（右下角收小 = 指向发送者的「尖」） */
.msg-user{ display:flex; flex-direction:column; align-items:flex-end; }
.msg-user .bubble{
  max-width:85%; padding:8px 16px;
  background:var(--muted); color:var(--foreground);
  border-radius:calc(var(--radius) * 1.4);
  border-bottom-right-radius:calc(var(--radius) * 0.6);
  word-break:break-word;
}
.quote{
  display:flex; align-items:flex-start; gap:6px;
  margin:0 0 6px;
  color:var(--muted-foreground); font-size:13px; font-style:italic;
}
.quote-icon{ width:13px; height:13px; flex:none; margin-top:4px; opacity:.7; }
.quote span{ min-width:0; word-break:break-word; white-space:pre-wrap; }
/* 助手消息：App 同款全宽正文 + 小字署名 */
.msg-assistant .role{ display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:11px; font-weight:500; letter-spacing:.02em; color:var(--muted-foreground); }
.badge{ padding:1px 8px; border-radius:999px; background:var(--muted); font-weight:400; letter-spacing:0; }
.msg-assistant .body{ min-width:0; }
.reasoning{
  margin:12px 0; padding:10px 14px;
  background:var(--muted); border-radius:calc(var(--radius) * 1.2);
}
.reasoning-label{ margin-bottom:4px; font-size:11px; font-weight:500; color:var(--muted-foreground); }
.reasoning .md{ color:var(--muted-foreground); font-size:13.5px; }
.tools{ display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
.tool{ display:inline-flex; align-items:center; gap:7px; padding:4px 10px; border-radius:999px; background:var(--muted); font-size:12px; color:var(--muted-foreground); }
.tool-dot{ width:6px; height:6px; border-radius:50%; background:var(--foreground); opacity:.55; flex:none; }
.tool-failed .tool-dot{ background:var(--destructive, #e5484d); opacity:1; }
.tool-failed .tool-state{ color:var(--destructive, #e5484d); }
.tool-name{ color:var(--foreground); font-weight:500; }
.imgs{ display:flex; flex-direction:column; gap:10px; margin:10px 0; }
.imgs img{ display:block; max-width:100%; height:auto; border-radius:calc(var(--radius) * 1.2); }
.md{ min-width:0; word-break:break-word; }
.md>:first-child{ margin-top:0; }
.md>:last-child{ margin-bottom:0; }
.md p{ margin:0 0 10px; }
.md h1,.md h2,.md h3,.md h4{ margin:20px 0 10px; line-height:1.35; font-weight:600; letter-spacing:-.01em; }
.md h1{ font-size:20px; } .md h2{ font-size:17px; } .md h3{ font-size:15.5px; } .md h4{ font-size:15px; }
.md ul,.md ol{ margin:0 0 10px; padding-left:1.5em; list-style-position:outside; }
.md li{ margin:3px 0; }
.md li>p{ margin:0; }
.md blockquote{ margin:0 0 10px; padding:2px 0 2px 14px; border-left:3px solid var(--border); color:var(--muted-foreground); }
.md a{ color:inherit; text-decoration:underline; text-decoration-color:color-mix(in oklab, var(--foreground) 35%, transparent); text-underline-offset:3px; word-break:break-all; }
.md hr{ margin:18px 0; border:0; border-top:1px solid var(--border); }
.md strong{ font-weight:600; }
.md code{ font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace; font-size:.875em; padding:2px 5px; border-radius:5px; background:var(--code-surface); }
/* 代码卡：App 同款（muted 外卡 + 语言标签 + background 代码体） */
.code-card{ margin:12px 0; border-radius:calc(var(--radius) * 1.2); background:var(--muted); overflow:hidden; }
.code-lang{ height:34px; display:flex; align-items:center; padding:0 14px; font-size:12px; color:var(--muted-foreground); }
.code-card pre{ margin:0; padding:10px 14px; background:var(--background); overflow:hidden; }
.code-card pre code{ display:block; padding:0; background:none; color:var(--foreground); font-size:12.5px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }
.md table{ width:100%; margin:12px 0; border-collapse:collapse; font-size:14px; }
.md th,.md td{ padding:7px 10px; border:1px solid var(--border); text-align:left; vertical-align:top; }
.md thead{ background:var(--muted); }
.md img{ max-width:100%; height:auto; border-radius:calc(var(--radius) * 1.2); }
.md kbd{ padding:1px 5px; border:1px solid var(--border); border-bottom-width:2px; border-radius:4px; font-size:.85em; font-family:ui-monospace,Menlo,monospace; }
.doc-foot{ display:flex; justify-content:space-between; gap:16px; margin-top:36px; padding-top:14px; border-top:0.5px solid var(--border); font-size:12px; color:var(--muted-foreground); }
.empty{ margin:32px 0; color:var(--muted-foreground); font-size:14px; }
@media (max-width:640px){
  .doc{ padding:24px 0 32px; }
  .msg-user .bubble{ max-width:100%; }
}
@media print{
  .doc{ width:auto; max-width:none; padding:0; }
  .msg{ break-inside:avoid; }
}
`;

export function buildShareHtml(
  doc: ShareDoc,
  options: ShareHtmlOptions = {},
  sanitize: Sanitize = defaultSanitize,
): string {
  const colorScheme: ShareColorScheme = options.colorScheme ?? "light";
  const tokens = { ...DEFAULT_TOKENS, ...(options.tokens ?? {}) };
  const styleVars = Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  const title = doc.title.trim() || "未命名对话";
  const createdAt = formatShareTime(doc.createdAt);
  const messages = doc.messages
    .map((message) => renderMessage(message, sanitize))
    .join("");
  const body =
    messages ||
    `<p class="empty">没有可分享的消息。</p>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="Kova" />
<title>${escapeHtml(title)}</title>
<style>
:root{ color-scheme:${colorScheme}; ${styleVars} }
${CSS}
</style>
</head>
<body>
<main class="doc">
  <header class="doc-head">
    <h1 class="doc-title">${escapeHtml(title)}</h1>
    <span class="doc-meta">${escapeHtml(createdAt)} · ${doc.messages.length} 条消息</span>
  </header>
  <div class="messages">${body}</div>
  <footer class="doc-foot"><span>由 扣瓦 生成</span><span>${escapeHtml(createdAt)}</span></footer>
</main>
</body>
</html>`;
}
