import type { Metadata } from "next";
// 内置字体（外观设置-字体选择可切换）：Geist（默认西文，字体栈首位）
// / Inter / Roboto / Open Sans / 思源黑体 / 思源宋体 / 霞鹜文楷 / JetBrains Mono。
// 各包均为 woff2 按 unicode-range 分片，
// 仅实际用到的字形分片会被下载（西文引入 400/500/700；CJK 字体只引入
// 400/700 两个字重控制体积——500 由浏览器以最近字重替代）
import "@fontsource-variable/geist";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/500.css";
import "@fontsource/open-sans/700.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/700.css";
import "@fontsource/noto-serif-sc/400.css";
import "@fontsource/noto-serif-sc/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/globals.css";
import { Toaster } from "@/components/ui/toast";
import { PerfHud } from "@/components/debug/perf-hud";

export const metadata: Metadata = {
  title: "Kova Harness Agent",
  description: "Kova Harness Agent",
};

/**
 * 外观偏好预绘制脚本：在首帧前把 localStorage 里的 ui.prefs 落到 html 根元素
 * （.dark 类 / data-accent / 根字号 / data-chat-width / data-font），避免闪烁。
 * 字段与选择器须与 lib/ui-prefs.ts 的 applyPrefs 保持一致；
 * 后续响应式更新与系统主题监听由该模块接管。
 */
const UI_PREFS_BOOTSTRAP = `(function(){try{var p=JSON.parse(localStorage.getItem("ui.prefs")||"{}"),d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)");d.classList.toggle("dark",p.theme==="dark"||(p.theme!=="light"&&m.matches));if(p.accent&&p.accent!=="default")d.setAttribute("data-accent",p.accent);if(p.fontSize==="sm")d.style.fontSize="15px";else if(p.fontSize==="lg")d.style.fontSize="17px";if(p.chatWidth==="narrow"||p.chatWidth==="wide")d.setAttribute("data-chat-width",p.chatWidth);if(p.fontFamily&&p.fontFamily!=="default")d.setAttribute("data-font",p.fontFamily);}catch(e){}})();`;

/**
 * crypto.randomUUID 是 Secure Context 专属 API：远程模式经 http://LAN-IP 访问时
 * （非 localhost/HTTPS）该方法整个不存在，面板标签、pi 请求 id 等一律抛
 * "crypto.randomUUID is not a function"。这里用 getRandomValues（不受安全上下文
 * 限制）按 RFC 4122 v4 补齐，随语言无关地覆盖自家代码与第三方库。
 * head 内联脚本在所有客户端模块之前执行，早于任何调用点。
 */
const UUID_POLYFILL = `(function(){try{if(typeof crypto==="undefined"||typeof crypto.getRandomValues!=="function")return;if(typeof crypto.randomUUID==="function")return;crypto.randomUUID=function(){var b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var s="";for(var i=0;i<16;i++)s+=(b[i]+256).toString(16).slice(1);return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);};}catch(e){}})();`;

/**
 * webview 管道噪声首道闸：Electron <webview> 的 src 加载被后续导航顶掉时，
 * 元素内部的 GUEST_VIEW_MANAGER_CALL invoke 以 ERR_ABORTED (-3) 拒绝且无人
 * 接住 → 渲染进程 unhandledrejection。Next dev 深色浮层的全局监听在模块求值
 * 期（client/app-globals → app-dev-overlay-setup）就已注册，且**不检查
 * defaultPrevented**——installFrontendLogging（useEffect 期才装）里的
 * preventDefault() 拦不住它，浮层照弹。要挡住只有「先注册 +
 * stopImmediatePropagation()」一条路，而 head 内联脚本保证先于 Next 的所有
 * chunk 执行。命中签名：阻断浮层与控制台裸错，折叠成 console.warn（日志管道
 * 装好后照旧以 warn 落 web.log）。签名口径与 lib/frontend-logging.ts 的
 * isWebviewAbortNoise 一致，两处改动须同步。
 */
const WEBVIEW_ABORT_GUARD = `(function(){try{window.addEventListener("unhandledrejection",function(e){var r=e&&e.reason,t=String((r&&r.message)||r||"");if(t.indexOf("GUEST_VIEW_MANAGER_CALL")===-1)return;if(t.indexOf("ERR_ABORTED")===-1&&t.indexOf("(-3)")===-1)return;e.preventDefault();e.stopImmediatePropagation();console.warn("[webview] 导航被顶掉（已折叠）: "+t);});}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" data-boot-splash="" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: UUID_POLYFILL }} />
        <script dangerouslySetInnerHTML={{ __html: UI_PREFS_BOOTSTRAP }} />
        <script dangerouslySetInnerHTML={{ __html: WEBVIEW_ABORT_GUARD }} />
      </head>
      <body>
        {/* PerfHud：性能采样/上报的挂载点，平时渲染 null（屏上那行已去掉，
            上报默认关——见 components/debug/perf-store.ts 的 PERF_LOG） */}
        {children} <Toaster /> <PerfHud />
      </body>
    </html>
  );
}
