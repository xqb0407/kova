/**
 * 设计档 → SVG / PNG 导出（浏览器侧封装）。SVG 字符串构建在 svg.ts（纯函数，
 * MCP 截图同库共用）；本文件只补浏览器独有的两件事：
 * ① 位图资产：从 leafer/assets 缓存取 blob url → base64 dataURL；
 * ② PNG 光栅化与落盘：canvas + 桥（宿主态走工作区文件，独立态浏览器下载）。
 */
import { allFrames, findNode, type DesignDoc, type DesignNode } from "./doc";
import { buildSvg, collectImageSrcs, type SvgOptions } from "./svg";
import { docToPrototypeHtml } from "./html";
import { getAssetState } from "./leafer/assets";
import type { MeasureFn } from "./leafer/scene";
import { bridge, blobToBase64 } from "./bridge";
import type { Box } from "./geometry";

/** 解析档内节点的图片资产为 dataURL（assets 缓存 blob url → base64，失败 null） */
export async function resolveImages(srcs: Set<string>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    [...srcs].map(async (src) => {
      const st = getAssetState(src);
      if (!st || st.status !== "ready" || !st.url) {
        out.set(src, null);
        return;
      }
      try {
        const blob = await fetch(st.url).then((r) => r.blob());
        out.set(src, await blobToBase64(blob).then((b64) => `data:${blob.type || "image/png"};base64,${b64}`));
      } catch {
        out.set(src, null);
      }
    }),
  );
  return out;
}

export type NodesToSvgOptions = {
  /** 画幅底色（截图给模型看时避免透明底；导出默认不加） */
  background?: string;
  /**
   * 预解析的 src→href 资产表。给了就**直接用**（bundle 导出把 href 指向 `assets/xxx.png`
   * 静态路径、而非 dataURL 时走这条），省一次浏览器取图；不给则按浏览器缓存解析成 dataURL。
   */
  images?: Map<string, string | null>;
};

/**
 * 导出给定节点集合（世界盒为画幅）→ SVG 字符串。
 * 顶层节点用局部坐标；嵌套选中经世界盒平移对齐。
 */
export async function nodesToSvg(
  doc: DesignDoc,
  ids: string[],
  measure: MeasureFn,
  backgroundOrOpts?: string | NodesToSvgOptions,
): Promise<{ svg: string; box: Box } | null> {
  // 兼容旧签名（第 4 参是 background 字符串）与新 opts 对象
  const optsIn: NodesToSvgOptions =
    typeof backgroundOrOpts === "string" ? { background: backgroundOrOpts } : backgroundOrOpts ?? {};
  const nodes = ids
    .map((id) => findNode(doc, id)?.node)
    .filter((n): n is DesignNode => !!n);
  const images = optsIn.images ?? (await resolveImages(collectImageSrcs(nodes)));
  const opts: SvgOptions = { measure, images, background: optsIn.background };
  return buildSvg(doc, ids, opts);
}

/** SVG → PNG（浏览器光栅化；字体走本机解析，与画布渲染同源） */
export function svgToPngBlob(svg: string, w: number, h: number, scale: number): Promise<Blob> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(w * scale));
      cv.height = Math.max(1, Math.round(h * scale));
      const ctx = cv.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        rej(new Error("no-2d"));
        return;
      }
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => (b ? res(b) : rej(new Error("toBlob-fail"))), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("svg-load-fail"));
    };
    img.src = url;
  });
}

/** 落盘：宿主态走桥（工作区文件）；独立态浏览器下载 */
export async function saveBlob(name: string, blob: Blob): Promise<void> {
  if (bridge.standalone) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  bridge.exportFile(name, await blobToBase64(blob));
}

/**
 * 浏览器**自包含单文件**原型 HTML：先把档内位图解析成 dataURL（缓存 blob→base64），
 * 再交给纯构建器 docToPrototypeHtml。给 FileMenu 的「导出 HTML 原型」用。
 */
export async function docToPrototypeHtmlSelfContained(
  doc: DesignDoc,
  opts: { measure: MeasureFn; pageId?: string; title?: string },
): Promise<string | null> {
  const frames = allFrames(doc).filter((f) => !opts.pageId || f.pageId === opts.pageId);
  const srcs = new Set<string>();
  for (const { frame } of frames) for (const s of collectImageSrcs([frame])) srcs.add(s);
  return docToPrototypeHtml(doc, { ...opts, images: await resolveImages(srcs) });
}
