"use client";

import { useRef, useState, type FC, type FormEvent } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  RotateCwIcon,
} from "lucide-react";
import { updatePanelTab, type PanelTab } from "@/lib/panel-tabs";
import { cn } from "@/lib/utils";

/** 无协议输入补 https://;非法输入返回 null */
function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 浏览器标签:地址栏 + iframe。跨域 iframe 无法读取内部历史,
 * 前进/后退用本组件自维护的访问栈;刷新靠换 key 重挂载。
 * 当前 URL 写回 tab store(updatePanelTab),重启恢复后继续显示。
 * 注意:带 X-Frame-Options/CSP frame-ancestors 的站点(如 GitHub)会拒绝被嵌入,
 * 表现为空白——这是浏览器限制,非本应用缺陷。
 */
export const BrowserView: FC<{ tab: PanelTab }> = ({ tab }) => {
  const initial = tab.url ? normalizeUrl(tab.url) : null;
  const [url, setUrl] = useState<string | null>(initial);
  const [input, setInput] = useState(tab.url ?? "");
  const [frameKey, setFrameKey] = useState(0);
  const stack = useRef<string[]>(initial ? [initial] : []);
  const cursor = useRef(initial ? 0 : -1);

  const show = (u: string) => {
    setUrl(u);
    setInput(u);
    updatePanelTab(tab.id, { url: u, title: hostOf(u) });
  };

  const navigate = (raw: string) => {
    const u = normalizeUrl(raw);
    if (!u) return;
    stack.current = [...stack.current.slice(0, cursor.current + 1), u];
    cursor.current = stack.current.length - 1;
    show(u);
  };

  const go = (delta: -1 | 1) => {
    const next = cursor.current + delta;
    if (next < 0 || next >= stack.current.length) return;
    cursor.current = next;
    show(stack.current[next]);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate(input);
  };

  const navBtn =
    "text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent size-7 shrink-0 rounded-md";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <button
          type="button"
          aria-label="Back"
          title="后退"
          disabled={cursor.current <= 0}
          onClick={() => go(-1)}
          className={cn(navBtn)}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="前进"
          disabled={cursor.current >= stack.current.length - 1}
          onClick={() => go(1)}
          className={cn(navBtn)}
        >
          <ArrowRightIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="刷新"
          disabled={!url}
          onClick={() => setFrameKey((k) => k + 1)}
          className={cn(navBtn)}
        >
          <RotateCwIcon className="size-4" />
        </button>
        <form onSubmit={onSubmit} className="min-w-0 flex-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="输入网址后回车"
            spellCheck={false}
            className="border-border/60 bg-muted/30 focus:bg-background focus:ring-ring/40 h-7 w-full rounded-full border px-3 font-mono text-xs outline-none transition-colors focus:ring-2"
          />
        </form>
      </div>
      <div className="bg-white min-h-0 flex-1 dark:bg-black">
        {url ? (
          <iframe
            key={`${url}-${frameKey}`}
            src={url}
            title={hostOf(url)}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="bg-background text-muted-foreground/60 flex h-full flex-col items-center justify-center gap-3 text-center text-sm">
            <GlobeIcon className="size-10" />
            <p className="font-medium text-foreground/80">浏览器</p>
            <p className="text-muted-foreground/50 text-xs">
              粘贴或输入 URL 以打开网页。
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
