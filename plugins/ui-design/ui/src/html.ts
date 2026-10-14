/**
 * 设计档 → 自包含交互式 HTML 原型（纯字符串生成，单文件零依赖）。
 *
 * **运行时与面板预览同源**：这里不实现任何交互逻辑，只做三件事——
 *   ① 用 buildRuntimePayload 装配载荷（与预览同一个函数）；
 *   ② 把 `prototypeRuntime.toString()` 的源码内联进 <script>；
 *   ③ 把载荷 JSON 塞进 <script type="application/json">。
 * 于是"预览所见 = 导出所得"是结构保证，而不是靠两处代码手动对齐。
 *
 * 产物是单文件：所有画板的 SVG 与位图（dataURL）都内嵌，双击即开、可离线分享。
 */
import { allFrames, type DesignDoc } from "./doc";
import { buildRuntimePayload } from "./prototype-payload";
import { prototypeRuntimeSource, RUNTIME_CSS, type RuntimePayload } from "./prototype-runtime";
import type { MeasureFn } from "./leafer/scene";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type PrototypeHtmlOptions = {
  measure: MeasureFn;
  /** 只导某页；缺省 = 全部页面 */
  pageId?: string;
  title?: string;
  /**
   * src→href 资产表（必填项语义：缺省空表 = 位图画占位）。浏览器自包含导出用
   * `resolveImages` 得到 dataURL 表；导出工程包（index.html 与 assets/ 同目录）
   * 传 `assets/<rel>` 相对路径表 → 位图变**外链静态文件**。见 ui/src/bundle.ts。
   */
  images?: Map<string, string | null>;
};

/**
 * 生成原型 HTML（同步纯函数，浏览器与 MCP 共用）；无任何顶层画板返回 null。
 * 页内没有可渲染画板时返回 null（调用方据此报"没有可用画板"）。
 */
export function renderPrototypeHtml(doc: DesignDoc, opts: PrototypeHtmlOptions): string | null {
  const frames = allFrames(doc).filter((f) => !opts.pageId || f.pageId === opts.pageId);
  if (frames.length === 0) return null;
  const payload = buildRuntimePayload(doc, {
    measure: opts.measure,
    images: opts.images,
    frameIds: frames.map((f) => f.frame.id),
  });
  if (payload.screens.length === 0) return null;
  const title = esc(opts.title ?? doc.meta.name);
  // JSON 内联进 <script type="application/json">：转义 `<` 防 `</script>` 提前收尾
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 原型</title>
<style>
  html,body{margin:0;height:100%;background:#18181b;overflow:hidden}
  #app{position:fixed;inset:0}
${RUNTIME_CSS}
</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="payload">${json}</script>
<script>
(function(){
  var raw=document.getElementById('payload').textContent;
  var payload;try{payload=JSON.parse(raw)}catch(e){document.getElementById('app').innerHTML='<div style="color:#e4e4e7;padding:24px">原型数据损坏</div>';return}
  var factory=${prototypeRuntimeSource()};
  factory(document.getElementById('app'),payload,{});
})();
</script>
</body>
</html>`;
}

/** 异步别名（保留给 await 调用方，如 html.test / 浏览器封装）；内部走同步核 renderPrototypeHtml */
export async function docToPrototypeHtml(doc: DesignDoc, opts: PrototypeHtmlOptions): Promise<string | null> {
  return renderPrototypeHtml(doc, opts);
}

export type { RuntimePayload };
