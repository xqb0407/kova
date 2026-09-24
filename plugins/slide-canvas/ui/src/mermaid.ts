/**
 * mermaid 渲染服务（flowchart/sequence/pie/state… 全类型）。
 * 单文件 iframe 里必须静态引入 mermaid；渲染结果按 (theme, code) 缓存。
 * securityLevel=strict：产物只含受约束 SVG，可安全 dangerouslySetInnerHTML。
 */
import mermaid from "mermaid";

export type MermaidResult = { svg: string; error?: undefined } | { svg?: undefined; error: string };

const cache = new Map<string, MermaidResult>();
let seq = 0;

export type MermaidThemeName = "default" | "dark" | "neutral";

/** follow/未设 = 跟随宿主主题（dataset.theme 由桥维护） */
export function currentMermaidTheme(elTheme?: string): MermaidThemeName {
  if (elTheme === "default" || elTheme === "dark" || elTheme === "neutral") return elTheme;
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

export async function renderMermaid(code: string, theme: MermaidThemeName): Promise<MermaidResult> {
  const key = `${theme}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: "strict",
    // 默认 false 会把 mermaid 自带的"炸弹 + Syntax error"错误图注入文档，
    // 被 Leafer 轨当成图渲染（面板里出现巨大错误图而不是我们的提示文案）。
    // 打开后失败只抛错，由调用方统一渲染友好提示。
    suppressErrorRendering: true,
    // 关掉 HTML 标签（foreignObject）改用纯 SVG <text>：WKWebView（Tauri 外壳）
    // 用 <img> 加载含 foreignObject 的 SVG 会直接失败 —— 表现就是画布轨
    // "mermaid 光栅化失败"（DOM 轨反而正常，很难查）。v12 里这是根级开关，
    // 子图级的 flowchart.htmlLabels 已废弃。
    htmlLabels: false,
    fontFamily: "-apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
  });
  const id = `scmm-${Date.now().toString(36)}-${seq++}`;
  let out: MermaidResult;
  try {
    const rendered = await mermaid.render(id, code);
    out = { svg: normalize(rendered.svg) };
  } catch (err) {
    out = { error: err instanceof Error ? err.message : String(err) };
  }
  document.getElementById(`d_${id}`)?.remove();
  cache.set(key, out);
  return out;
}

/**
 * Mermaid 报错 → 面板可读文案：抽出出错行号并附上那一行源码。
 * mermaid 的原文是 "Parse error on line 40:\n...^\nExpecting ..."，只取首行会丢掉
 * 最有用的"哪一行"，这里把源码行也带出来（找不到行号就退回首行）。
 */
export function mermaidErrorText(code: string, message: string): string {
  const first = message.split("\n")[0]?.trim() || "渲染失败";
  const n = /line\s+(\d+)/i.exec(message)?.[1];
  if (n) {
    const src = code.split("\n")[Number(n) - 1]?.trim();
    if (src) return `第 ${n} 行：${src.length > 80 ? src.slice(0, 80) + "…" : src}`;
    return `第 ${n} 行（源码已改动？）`;
  }
  return first;
}

/**
 * 只改根 <svg> 标签上的尺寸/适配属性：先摘掉已有的（含 preserveAspectRatio，
 * 重复属性会让 SVG 变成非法 XML、<img> 直接 onerror），再按需写回。
 * 注意不要用全局正则去 strip width/height —— 那会连 <rect>/<image> 等
 * 嵌套节点的属性一起剥掉（mermaid 新输出大量用 rect 画节点）。
 */
export function retagSvg(svg: string, opts: { width?: number; height?: number; preserveAspectRatio?: string }): string {
  const end = svg.indexOf(">");
  if (end < 0) return svg;
  const head = svg
    .slice(0, end)
    .replace(/\s(width|height|preserveAspectRatio)="[^"]*"/g, "")
    .replace(/\sstyle="max-width:[^"]*;?"/g, "");
  const attrs = [
    opts.width !== undefined ? `width="${opts.width}"` : "",
    opts.height !== undefined ? `height="${opts.height}"` : "",
    opts.preserveAspectRatio ? `preserveAspectRatio="${opts.preserveAspectRatio}"` : "",
  ].filter(Boolean);
  return head + (attrs.length ? " " + attrs.join(" ") : "") + svg.slice(end);
}

/** 去掉 max-width 内联约束 + 声明等比适配，交给外层 CSS 拉满元素盒 */
function normalize(svg: string): string {
  return svg
    .replace(/style="max-width:[^"]*;?"/g, "")
    .replace(/\swidth="[^"]*"/g, "")
    .replace(/\sheight="[^"]*"/g, "")
    .replace("<svg ", '<svg preserveAspectRatio="xMidYMid meet" ');
}

/**
 * 用户/agent 提供的 SVG 源码 → `<img>` 可加载的 data-url。
 * 经 <img> 加载的 SVG 脚本不执行（规范行为），天然沙箱化——切勿改回
 * dangerouslySetInnerHTML 内联：内联 SVG 里的 <script> 会真实运行。
 * retagSvg 只动根标签：摘掉自带宽高（交给元素盒约束）+ 声明等比适配。
 * 限制：WKWebView 下含 foreignObject 的 SVG 在 <img> 里加载失败（mermaid 同坑），
 * 由渲染层 onerror 兜底提示。
 */
export function svgCodeUrl(code: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(retagSvg(code, { preserveAspectRatio: "xMidYMid meet" }))}`;
}

/**
 * 检测 SVG 源码是否含声明式动画（SMIL 三件套 / CSS keyframes / 内联 animation）。
 * 动画源码不能走 canvas 光栅化（drawImage 只留第一帧），必须由 DOM `<img>` 实时渲染
 * ——`<img>` 里声明式动画照常播放（只有脚本被禁），这是浏览器的固有行为。
 */
export function isAnimatedSvg(code: string): boolean {
  return /<animate[\s>]|<animateTransform[\s>]|<animateMotion[\s>]|@keyframes|animation\s*:/i.test(code);
}

/** SVG → PNG dataURL（pptx 导出用；失败 null，导出侧降级占位块） */
export function svgToPng(svg: string, w: number, h: number, background: string, scale = 2): Promise<string | null> {
  return new Promise((res) => {
    const cw = Math.max(2, Math.round(w * scale));
    const ch = Math.max(2, Math.round(h * scale));
    const sized = retagSvg(svg, { width: cw, height: ch });
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext("2d");
        if (!ctx) return res(null);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        res(canvas.toDataURL("image/png"));
      } catch {
        res(null);
      }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}
