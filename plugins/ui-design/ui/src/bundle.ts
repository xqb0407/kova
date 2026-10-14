/**
 * 导出工程包的**纯装配器**（零 IO / 零 DOM：浏览器面板与 MCP server 共用同一份）。
 *
 * 一个"导出产物"不再是一坨单文件，而是一个目录包：
 *   <dir>/
 *     manifest.json           —— 列出每个文件的相对路径/类型/尺寸（静态文件路径清单）
 *     <档名>.uidesign.json    —— 源档副本（可再导入继续编辑）
 *     index.html              —— 交互原型，位图**外链** assets/（非 dataURL 内联）
 *     screens/01-首页.png      —— 每个顶层画板一张位图（高清，不受内联 2MiB 闸门约束）
 *     screens/01-首页.svg      —— 可选矢量（自包含）
 *     assets/xxx.png           —— 档内引用到的位图资产逐份复制进包（让包可整体拷走）
 *
 * 本文件只决定"该有哪些文件、叫什么名、彼此怎么相对引用"；真正的取图/光栅化/落盘
 * 由注入的适配器完成（mcp/export.ts 用 node:fs + resvg；面板 export 走桥 + canvas）。
 * 保证两条链路产出的目录结构与 manifest 完全一致。
 */
import type { DesignDoc, DesignNode, InstanceNode, Page } from "./doc";
import { bakeInstanceNodes, findNode } from "./doc";

export type ExportFormat = "png" | "svg" | "html" | "source" | "code";

export const EXPORT_FORMATS: ExportFormat[] = ["png", "svg", "html", "source"];
export const DEFAULT_FORMATS: ExportFormat[] = ["png", "html", "source"];

/** 文件名安全 token：保留中日韩与字母数字，路径分隔/控制字符与空白折叠成 `-` */
export function safeToken(name: string, fallback = "screen"): string {
  const cleaned = (name || "")
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return cleaned || fallback;
}

/** `a/b/c.png` → `c.png`（去目录、去 .uidesign 之类后缀无关；仅取 basename 并安全化） */
function baseName(src: string): string {
  const seg = src.split(/[/\\]/).filter(Boolean).pop() ?? src;
  return safeToken(seg.replace(/\.[^.]+$/, ""), "asset") + extOf(seg);
}
function extOf(seg: string): string {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(seg);
  return m ? m[0].toLowerCase() : ".png";
}

export type BundleScreen = {
  index: number; // 1-based，参与文件名（01/02…），保证唯一
  id: string;
  name: string;
  w: number;
  h: number;
  pngPath: string; // 工作区相对
  svgPath: string;
  codePath: string; // Dev Mode CSS 标注
};

export type BundleAsset = { src: string; /** assets/ 下的相对文件名（去重后） */ rel: string; path: string };

export type BundleOptions = {
  /** 包目录名（工作区相对）；缺省 = `<dirBase>-export` */
  dir?: string;
  formats?: ExportFormat[];
  scale?: number;
  maxDim?: number;
  /** PNG 画幅底色；null = 透明（缺省，画板通常自绘底色） */
  background?: string | null;
};

export type BundlePlan = {
  dir: string;
  pageName: string;
  screens: BundleScreen[];
  /** 包内 assets/ 清单：src（档内相对路径）→ path（工作区相对，指向复制进包的文件） */
  assets: BundleAsset[];
  formats: Set<ExportFormat>;
  indexHtmlPath: string;
  manifestPath: string;
  sourcePath: string;
  scale: number;
  maxDim: number;
  background: string | null;
};

/**
 * 依据选中的顶层节点（ids）装配包结构。ids 应已由上层过滤（可见性/存在性），
 * 这里按给定顺序编号。src 集合从这些节点的子树收集。
 */
export function planBundle(
  doc: DesignDoc,
  page: Page,
  ids: string[],
  dirBase: string,
  opts: BundleOptions = {},
): BundlePlan {
  const dir = (opts.dir?.trim() || `${dirBase}-export`).replace(/\/+$/, "");
  const formats = new Set<ExportFormat>(opts.formats?.length ? opts.formats : DEFAULT_FORMATS);
  const screens: BundleScreen[] = [];
  const srcs = new Set<string>();

  let n = 0;
  for (const id of ids) {
    const loc = findNode(doc, id);
    const node = loc?.node;
    if (!node || node.visible === false) continue;
    n += 1;
    const idx = String(n).padStart(2, "0");
    const token = safeToken(node.name, `screen${idx}`);
    screens.push({
      index: n,
      id,
      name: node.name,
      w: Math.round(node.w),
      h: Math.round(node.h),
      pngPath: `${dir}/screens/${idx}-${token}.png`,
      svgPath: `${dir}/screens/${idx}-${token}.svg`,
      codePath: `${dir}/code/${idx}-${token}.css`,
    });
    collectSrcs(node, srcs, doc);
  }

  // 资产名去重：同名不同源时插入 ~2/~3（扩展名前）
  const used = new Set<string>();
  const assets: BundleAsset[] = [];
  for (const src of srcs) {
    let rel = baseName(src);
    let bump = 2;
    while (used.has(rel)) rel = baseName(src).replace(/(\.[^.]+)$/, `~${bump++}$1`);
    used.add(rel);
    assets.push({ src, rel, path: `${dir}/assets/${rel}` });
  }

  return {
    dir,
    pageName: page.name,
    screens,
    assets,
    formats,
    indexHtmlPath: `${dir}/index.html`,
    manifestPath: `${dir}/manifest.json`,
    sourcePath: `${dir}/${safeToken(dirBase, "design")}.uidesign.json`,
    scale: opts.scale ?? 2,
    maxDim: opts.maxDim ?? 4096,
    background: opts.background ?? null,
  };
}

function collectSrcs(node: DesignNode, out: Set<string>, doc: DesignDoc): void {
  if (node.type === "image") out.add(node.src);
  // 实例内部的位图也要随包导出：展开解析视图（覆盖后的 image src 才算数）
  if (node.type === "instance") {
    const baked = bakeInstanceNodes(doc, node as InstanceNode);
    if (baked) for (const c of baked) collectSrcs(c, out, doc);
    return;
  }
  if (node.type === "frame" || node.type === "group") for (const c of node.children) collectSrcs(c, out, doc);
}

/** index.html 与 assets/ 同目录：src → "assets/<rel>" 的外链 href 表（供 buildSvg/原型 HTML） */
export function externalImagesMap(plan: BundlePlan): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const a of plan.assets) m.set(a.src, `assets/${a.rel}`);
  return m;
}

export type BundleFileKind = "source" | "png" | "svg" | "html" | "asset" | "manifest" | "code";
export type BundleFileResult = {
  path: string; // 工作区相对
  kind: BundleFileKind;
  screen?: string;
  /** png = 像素尺寸；svg/html = 设计盒尺寸 */
  width?: number;
  height?: number;
  bytes: number;
};

export type Manifest = {
  generator: "ui-design/export";
  doc: string;
  docName: string;
  page: string;
  createdAt: string;
  formats: ExportFormat[];
  screens: { name: string; width: number; height: number }[];
  files: BundleFileResult[];
  note: string;
};

/**
 * 汇总 manifest：files 按 路径 稳定排序；screens 附设计尺寸。
 * `docPath` = 源档的工作区相对路径（manifest 里标注产物来自哪份档）。
 */
export function buildManifest(
  doc: DesignDoc,
  plan: BundlePlan,
  docPath: string,
  files: BundleFileResult[],
  nowIso: string,
): Manifest {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    generator: "ui-design/export",
    doc: docPath,
    docName: doc.meta.name,
    page: plan.pageName,
    createdAt: nowIso,
    formats: [...plan.formats],
    screens: plan.screens.map((s) => ({ name: s.name, width: s.w, height: s.h })),
    files: sorted,
    note: "静态导出包：index.html 直接浏览器打开可点原型；screens/*.png 为逐画板位图；assets/ 为外链位图；本文件列出全部相对路径。",
  };
}

/** manifest.json 的稳定序列化（键序固定，便于 diff/测试） */
export function serializeManifest(m: Manifest): string {
  return JSON.stringify(m, null, 2);
}
