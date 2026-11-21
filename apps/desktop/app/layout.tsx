import type { Metadata } from "next";
// 首屏字体只保留 Geist（默认西文 + 系统中文回退）。Inter / Roboto /
// Open Sans / 思源黑体 / 思源宋体 / JetBrains Mono 由
// scripts/build-fonts.mjs 复制到 public/fonts，FontCssLoader 在选中对应
// 字体时才注入 <link>——避免 300KB font-face CSS 压首屏。
import "@fontsource-variable/geist";
import "./styles/globals.css";
import { Toaster } from "@/components/ui/toast";
import { PerfHud } from "@/components/debug/perf-hud";
import { ThemeRuntime } from "@/components/runtime/theme-runtime";
import { FontCssLoader } from "@/components/runtime/font-css-loader";
import { MarkdownWarmup } from "@/components/runtime/markdown-warmup";
import { MotionProvider } from "@/components/runtime/motion-provider";
import { BOOT_CACHE_VERSION } from "@/lib/theme/palette";

export const metadata: Metadata = {
  title: "Kova Harness Agent",
  description: "Kova Harness Agent",
};

/**
 * 外观偏好预绘制脚本：在首帧前把 localStorage 里的 ui.prefs 与其派生缓存
 * （ui.theme.cache）落到 html 根元素，避免闪烁。缓存由 lib/settings/ui-prefs.ts
 * 在每次偏好变更时写入；派生算法只存在于 lib/theme/palette.ts，这里只做套用。
 * 字段/键名须与 ui-prefs 的 writeBootCache 保持一致；口径变更（如对话宽度从百分比
 * 改为 rem 上限）时递增 BOOT_CACHE_VERSION，旧缓存的对应字段直接跳过、由客户端重算。
 * 壁纸图优先取缓存里的主题内置 URL（wallpaper.img），否则回读 localStorage 的用户图
 * （dataURL 不进缓存，体积原因）。
 */
const UI_PREFS_BOOTSTRAP = `(function(){try{var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)"),p=JSON.parse(localStorage.getItem("ui.prefs")||"{}"),dark=p.theme==="dark"||(p.theme!=="light"&&m.matches);d.classList.toggle("dark",dark);d.style.colorScheme=dark?"dark":"light";var loc=p.locale;if(loc!=="zh"&&loc!=="en"){loc=/^zh/i.test((navigator.languages&&navigator.languages[0])||navigator.language||"")?"zh":"en";}d.lang=loc==="zh"?"zh-CN":"en";var c=JSON.parse(localStorage.getItem("ui.theme.cache")||"null");if(c){var t=dark?c.dark:c.light;if(t){for(var k in t)d.style.setProperty(k,t[k]);}if(c.fontSize)d.style.fontSize=c.fontSize;if(c.v===${BOOT_CACHE_VERSION}){if(c.fontWeight&&d.dataset.os==="win")d.style.fontWeight=c.fontWeight;if(c.chatFontSize)d.style.setProperty("--chat-font-size",c.chatFontSize);if(c.chatLineHeight)d.style.setProperty("--chat-line-height",c.chatLineHeight);if(c.chatWidth)d.style.setProperty("--chat-width",c.chatWidth);}var w=c.wallpaper;if(w&&(w.mode==="both"||w.mode===(dark?"dark":"light"))){var src=w.img;if(!src){var li=localStorage.getItem("ui.wallpaper.image");if(li&&/^data:image\\/(?:png|jpe?g|webp);base64,/i.test(li))src=li;}if(src){d.setAttribute("data-wallpaper","");d.style.setProperty("--wallpaper-image",'url("'+src+'")');for(var v in w.vars)d.style.setProperty(v,w.vars[v]);}}}}catch(e){}})();`;

/**
 * crypto.randomUUID 是 Secure Context 专属 API：远程模式经 http://LAN-IP 访问时
 * （非 localhost/HTTPS）该方法整个不存在，面板标签、pi 请求 id 等一律抛
 * "crypto.randomUUID is not a function"。这里用 getRandomValues（不受安全上下文
 * 限制）按 RFC 4122 v4 补齐，随语言无关地覆盖自家代码与第三方库。
 * head 内联脚本在所有客户端模块之前执行，早于任何调用点。
 */
const UUID_POLYFILL = `(function(){try{if(typeof crypto==="undefined"||typeof crypto.getRandomValues!=="function")return;if(typeof crypto.randomUUID==="function")return;crypto.randomUUID=function(){var b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var s="";for(var i=0;i<16;i++)s+=(b[i]+256).toString(16).slice(1);return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);};}catch(e){}})();`;

/**
 * 平台标记：html[data-os] 供 CSS 做平台级覆盖（Windows 关闭
 * optimizeLegibility、思源字重补偿、首帧字重缓存门控等）。UA 判断与
 * lib/desktop-env.ts 的 isWindowsPlatform 口径一致；只写标记，不参与
 * 任何业务判断。
 */
const PLATFORM_TAG = `(function(){try{var u=navigator.userAgent,d=document.documentElement.dataset;if(/Windows NT/i.test(u))d.os="win";else if(/Macintosh|Mac OS X/i.test(u))d.os="mac";else if(/Linux/i.test(u))d.os="linux";}catch(e){}})();`;

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
        <script dangerouslySetInnerHTML={{ __html: PLATFORM_TAG }} />
        <script dangerouslySetInnerHTML={{ __html: UUID_POLYFILL }} />
        <script dangerouslySetInnerHTML={{ __html: UI_PREFS_BOOTSTRAP }} />
        <script dangerouslySetInnerHTML={{ __html: WEBVIEW_ABORT_GUARD }} />
      </head>
      <body>
        {/* 水合后重放一次主题 token（见组件注释） */}
        <ThemeRuntime />
        {/* 非默认字体 CSS 仅在选中时注入；首屏只加载 Geist */}
        <FontCssLoader />
        {/* 应用壳落定后空闲预取 Markdown 重插件/Shiki，避免首次切会话时集中付费 */}
        <MarkdownWarmup />
        {/* PerfHud：性能采样/上报的挂载点，平时渲染 null（屏上那行已去掉，
            上报默认关——见 components/debug/perf-store.ts 的 PERF_LOG） */}
        <MotionProvider>{children}</MotionProvider> <Toaster position="top-center"  /> <PerfHud />
      </body>
    </html>
  );
}
