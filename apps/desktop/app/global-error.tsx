"use client";

import { useEffect, useState } from "react";

/**
 * 根 layout 崩溃时的最后一道兜底——再上一层的 error.tsx 自己挂了才会走到这。
 *
 * 这个文件刻意不 import 任何仓库模块（error.tsx 崩溃时它必须是干净的），
 * 因此不能用 Tailwind、不能引 globals.css：它替换的是整个 document，
 * 官方也明确说这里拿不到全局样式。样式全部内联，明暗跟着系统走
 * （根 layout 里那套 .dark 预绘制脚本在这条路径上不执行）。
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error("[崩溃] 全局", error);
    // 动态 import：万一 frontend-logging 自己有问题，不能连带把错误页也带走
    void import("@/lib/frontend-logging")
      .then((m) => m.reportFrontendError(`[崩溃] 全局\n${error.name}: ${error.message}`))
      .catch(() => {});
  }, [error]);

  const copy = () => {
    navigator.clipboard
      ?.writeText(`${error.name}: ${error.message}\n${error.stack ?? ""}`)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <html lang="zh-CN">
      <head>
        <title>应用崩溃</title>
        <style>{STYLE}</style>
      </head>
      <body>
        <main className="wrap">
          <h1>应用出了点问题</h1>
          <p>窗口没能正常画出来。可以先重试，不行就重新加载；详细信息在日志目录里。</p>
          <pre>{`${error.name}: ${error.message}`}</pre>
          <div className="row">
            <button className="primary" onClick={retry}>
              重试
            </button>
            <button onClick={() => location.reload()}>重新加载窗口</button>
            <button onClick={copy}>{copied ? "已复制" : "复制错误详情"}</button>
          </div>
        </main>
      </body>
    </html>
  );
}

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    background: #fff; color: #18181b;
  }
  .wrap {
    min-height: 100dvh; box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; padding: 32px; text-align: center;
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  p { font-size: 13px; line-height: 1.6; margin: 0; opacity: .65; max-width: 22rem; }
  pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; line-height: 1.6; margin: 4px 0 0; max-width: 32rem;
    padding: 8px 12px; border-radius: 8px; text-align: left;
    background: rgba(0,0,0,.05); overflow-x: auto; white-space: pre-wrap;
    word-break: break-all;
  }
  .row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 4px; }
  button {
    height: 30px; padding: 0 12px; border-radius: 8px; cursor: pointer;
    font-size: 13px; font-family: inherit;
    border: 1px solid rgba(0,0,0,.12); background: rgba(0,0,0,.04); color: inherit;
  }
  button:hover { background: rgba(0,0,0,.08); }
  button.primary { background: #18181b; color: #fff; border-color: #18181b; }
  button.primary:hover { background: #3f3f46; }
  @media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #fafafa; }
    pre { background: rgba(255,255,255,.07); }
    button { border-color: rgba(255,255,255,.14); background: rgba(255,255,255,.07); }
    button:hover { background: rgba(255,255,255,.13); }
    button.primary { background: #fafafa; color: #09090b; border-color: #fafafa; }
    button.primary:hover { background: #d4d4d8; }
  }
`;
