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

/** 去掉 max-width 内联约束 + 声明等比适配，交给外层 CSS 拉满元素盒 */
function normalize(svg: string): string {
  return svg
    .replace(/style="max-width:[^"]*;?"/g, "")
    .replace(/\swidth="[^"]*"/g, "")
    .replace(/\sheight="[^"]*"/g, "")
    .replace("<svg ", '<svg preserveAspectRatio="xMidYMid meet" ');
}

/** SVG → PNG dataURL（pptx 导出用；失败 null，导出侧降级占位块） */
export function svgToPng(svg: string, w: number, h: number, background: string, scale = 2): Promise<string | null> {
  return new Promise((res) => {
    const cw = Math.max(2, Math.round(w * scale));
    const ch = Math.max(2, Math.round(h * scale));
    const sized = svg.replace("<svg ", `<svg width="${cw}" height="${ch}" `);
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
