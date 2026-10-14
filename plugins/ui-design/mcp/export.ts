/**
 * MCP 侧导出工程包：把设计档落盘成一个**多文件目录包**（非单产物），并返回全部
 * 静态文件的工作区相对路径清单。目录结构/命名/manifest 由 ui/src/bundle.ts 的纯
 * 装配器决定，浏览器面板导出走同一装配器 → 两条链路产物一致。
 *
 * 包内容（按需）：
 *   <dir>/manifest.json          路径清单（每个文件的相对路径/类型/像素或设计尺寸/字节数）
 *   <dir>/<档名>.uidesign.json   源档副本（可再导入）
 *   <dir>/index.html             交互原型，位图**外链** assets/（非 dataURL 内联）
 *   <dir>/screens/NN-<画板>.png   逐画板位图（高清，不受截图内联 2MiB 闸门约束）
 *   <dir>/screens/NN-<画板>.svg   逐画板自包含矢量（可选）
 *   <dir>/assets/<文件>           档内引用到的位图资产逐份复制进包（整体可拷走）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findNode, type DesignDoc, type DesignNode, type Page } from "../ui/src/doc";
import {
  buildManifest,
  externalImagesMap,
  planBundle,
  serializeManifest,
  type BundleFileResult,
  type BundleOptions,
} from "../ui/src/bundle";
import { renderPrototypeHtml } from "../ui/src/html";
import { nodeToCss } from "../ui/src/css";
import { makeApproxMeasure, readDocImages, renderDocPng, renderDocSvg } from "./render";

const DOC_SUFFIX = ".uidesign.json";

export type ExportSummary = {
  /** 包目录（工作区相对，正斜杠） */
  dir: string;
  doc: string;
  docName: string;
  page: string;
  screens: string[];
  /** 全部产物文件（工作区相对路径）——agent 据此展示/引用静态文件 */
  files: { path: string; kind: BundleFileResult["kind"]; width?: number; height?: number; bytes: number }[];
  manifest: string;
  /** 读不到、未落盘的位图资产数（档内 image.src 指向缺失文件） */
  missingAssets: number;
};

const toRel = (workspace: string, abs: string): string => {
  const rel = path.relative(workspace, abs);
  return (rel && !rel.startsWith("..") ? rel : abs).split(path.sep).join("/");
};

/** 把包内相对路径解析成绝对路径，并守住不越出工作区 */
function resolveInside(workspace: string, rel: string): string {
  const abs = path.resolve(workspace, rel);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`导出路径越出工作区：${rel}`);
  }
  return abs;
}

function write(workspace: string, rel: string, data: string | Buffer): number {
  const abs = resolveInside(workspace, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return Buffer.byteLength(data);
}

/**
 * 把字节/文本写到工作区内的相对路径（父目录自动建），返回规范化正斜杠相对路径。
 * 越出工作区或空路径抛错。截图 `saveTo`、单文件落盘共用。
 */
export function saveToWorkspace(workspace: string, rel: string, data: string | Buffer): string {
  const clean = (rel || "").trim().replace(/\\/g, "/");
  if (!clean) throw new Error("saveTo 路径不能为空");
  write(workspace, clean, data);
  return clean.split("/").filter(Boolean).join("/");
}

export function exportBundle(
  workspace: string,
  docAbs: string,
  doc: DesignDoc,
  page: Page,
  ids: string[],
  opts: BundleOptions & { dirBase?: string } = {},
): ExportSummary {
  const nodes = ids
    .map((id) => findNode(doc, id)?.node)
    .filter((n): n is DesignNode => !!n && n.visible !== false);
  if (nodes.length === 0) throw new Error(`页面「${page.name}」没有可见的顶层画板可导出`);

  const dirBase = opts.dirBase ?? path.basename(docAbs, DOC_SUFFIX);
  const plan = planBundle(doc, page, nodes.map((n) => n.id), dirBase, opts);
  const imgs = readDocImages(workspace, nodes);
  const files: BundleFileResult[] = [];

  // 源档副本（原样字节，最保真）
  const srcText = readFileSync(docAbs);
  files.push({ path: plan.sourcePath, kind: "source", bytes: write(workspace, plan.sourcePath, srcText) });

  // 资产复制：读得到的落进 assets/，读不到的计入 missingAssets
  let missingAssets = 0;
  for (const a of plan.assets) {
    const buf = imgs.raw.get(a.src);
    if (buf) files.push({ path: a.path, kind: "asset", bytes: write(workspace, a.path, buf) });
    else missingAssets++;
  }

  // 逐画板 PNG / SVG
  if (plan.formats.has("png") || plan.formats.has("svg")) {
    for (const s of plan.screens) {
      if (plan.formats.has("png")) {
        const png = renderDocPng(workspace, doc, [s.id], {
          scale: plan.scale,
          maxDim: plan.maxDim,
          background: plan.background,
          budgetBytes: null,
        });
        if (png)
          files.push({
            path: s.pngPath,
            kind: "png",
            screen: s.name,
            width: png.width,
            height: png.height,
            bytes: write(workspace, s.pngPath, Buffer.from(png.png)),
          });
      }
      if (plan.formats.has("svg")) {
        const svg = renderDocSvg(workspace, doc, [s.id], { background: plan.background ?? undefined });
        if (svg)
          files.push({
            path: s.svgPath,
            kind: "svg",
            screen: s.name,
            width: svg.boxW,
            height: svg.boxH,
            bytes: write(workspace, s.svgPath, svg.svg),
          });
      }
    }
  }

  // Dev Mode：逐画板 CSS 标注（子树每个节点一条规则）
  if (plan.formats.has("code")) {
    for (const s of plan.screens) {
      const loc = findNode(doc, s.id);
      if (!loc) continue;
      const rules: string[] = [];
      const walk = (n: DesignNode): void => {
        rules.push(nodeToCss(n, doc));
        if (n.type === "frame" || n.type === "group") for (const c of n.children) walk(c);
      };
      walk(loc.node);
      files.push({
        path: s.codePath,
        kind: "code",
        screen: s.name,
        bytes: write(workspace, s.codePath, rules.join("\n\n")),
      });
    }
  }

  // 交互原型 HTML（外链 assets/，与包内静态文件同目录）
  if (plan.formats.has("html")) {
    const html = renderPrototypeHtml(doc, {
      measure: makeApproxMeasure(),
      pageId: page.id,
      title: doc.meta.name,
      images: externalImagesMap(plan),
    });
    if (html) files.push({ path: plan.indexHtmlPath, kind: "html", bytes: write(workspace, plan.indexHtmlPath, html) });
  }

  const docRel = toRel(workspace, docAbs);
  const manifestText = serializeManifest(buildManifest(doc, plan, docRel, files, new Date().toISOString()));
  files.push({ path: plan.manifestPath, kind: "manifest", bytes: write(workspace, plan.manifestPath, manifestText) });

  return {
    dir: plan.dir,
    doc: docRel,
    docName: doc.meta.name,
    page: plan.pageName,
    screens: plan.screens.map((s) => s.name),
    files: files.map((f) => ({ path: f.path, kind: f.kind, width: f.width, height: f.height, bytes: f.bytes })),
    manifest: plan.manifestPath,
    missingAssets,
  };
}
