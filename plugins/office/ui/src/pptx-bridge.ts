/**
 * pptx → 幻灯片文档（CanvasDoc v2 deck）转换桥（纯函数域模块，跑在面板 iframe）。
 * pptx = zip + OOXML：jszip 解包、XML 解析器由调用方注入（浏览器 DOMParser /
 * 测试 @xmldom/xmldom），本模块只做 DrawingML → deck 元素的映射。
 *
 * v1 保真子集：文本框（位置/字号/粗体/颜色/对齐/竖直锚点/项目符号）、基本形状
 * （rect/roundRect/ellipse + 填充描边）、图片（落工作区资产，src 指向 <名>-assets/）、
 * 表格（a:tbl → deck table）、页背景、页尺寸（EMU/9525=px）。主题色走 theme1.xml
 * 的 clrScheme 查表。渐变/阴影/SmartArt/图表/动画不转换 → warnings 汇总。
 */
import JSZip from "jszip";
import type { El, ShapeKind } from "./doc";

export type PptxImage = { name: string; base64: string };
export type PptxResult = {
  doc: {
    version: 2;
    meta: { name: string; pagePreset: string; kind: "deck" };
    objects: El[];
    frames: {
      id: string;
      w: number;
      h: number;
      type: "slide";
      name?: string;
      background?: string;
      elements: El[];
    }[];
  };
  images: PptxImage[];
  warnings: string[];
};

type XmlDoc = Document;

const EMU_PX = 9525;

/** XML 解析器注入点：浏览器传 (s) => new DOMParser().parseFromString(s, "text/xml") */
export type XmlParser = (xml: string) => XmlDoc;

function q(elem: Element | null, name: string): string | null {
  return elem?.getAttribute(name) ?? null;
}

/** a:off/a:ext 坐标（EMU）→ deck px（取整） */
function readXfrm(spPrLike: Element | null): { x: number; y: number; w: number; h: number; rot: number } | null {
  // graphicFrame 直接传入的就是 xfrm 本身（p:xfrm），sp 传入的是 spPr（内嵌 a:xfrm）
  const selfLocal = spPrLike?.nodeName.replace(/^.*:/, "");
  const xfrm = selfLocal === "xfrm" ? spPrLike : (spPrLike?.getElementsByTagName("a:xfrm")[0] ?? null);
  const off = xfrm?.getElementsByTagName("a:off")[0] ?? null;
  const ext = xfrm?.getElementsByTagName("a:ext")[0] ?? null;
  if (!off || !ext) return null;
  const x = Math.round(Number(q(off, "x") ?? 0) / EMU_PX);
  const y = Math.round(Number(q(off, "y") ?? 0) / EMU_PX);
  const w = Math.round(Number(q(ext, "cx") ?? 0) / EMU_PX);
  const h = Math.round(Number(q(ext, "cy") ?? 0) / EMU_PX);
  const rot = Math.round(Number(q(xfrm, "rot") ?? 0) / 60000);
  return { x, y, w: Math.max(w, 1), h: Math.max(h, 1), rot };
}

/** 元素直接子层里第一个匹配局部名的节点（OOXML 命名空间前缀随文件而异，按 localName 匹配） */
function childByLocal(elem: Element, ...names: string[]): Element | null {
  for (const child of Array.from(elem.children)) {
    const local = child.nodeName.replace(/^.*:/, "");
    if (names.includes(local)) return child;
  }
  return null;
}

/** solidFill 里的颜色：srgbClr@val 优先，schemeClr 查主题表 */
function readColor(elem: Element | null, theme: Record<string, string>): string | undefined {
  if (!elem) return undefined;
  const srgb = childByLocal(elem, "srgbClr");
  if (srgb) {
    const v = q(srgb, "val");
    if (v) return `#${v.replace("#", "").toUpperCase()}`;
  }
  const scheme = childByLocal(elem, "schemeClr");
  if (scheme) {
    const v = q(scheme, "val");
    if (v && theme[v]) return theme[v];
  }
  return undefined;
}

/** a:r 运行 → deck run（字号 pt→px×4/3、粗体、颜色） */
function readRuns(paragraph: Element, theme: Record<string, string>, warnings: Set<string>): { text: string; size?: number; bold?: true; color?: string }[] {
  const runs: { text: string; size?: number; bold?: true; color?: string }[] = [];
  for (const r of Array.from(paragraph.children)) {
    if (r.nodeName.replace(/^.*:/, "") !== "r") continue;
    const t = r.getElementsByTagName("a:t")[0];
    const text = t?.textContent ?? "";
    if (!text) continue;
    const rPr = r.getElementsByTagName("a:rPr")[0] ?? null;
    const run: { text: string; size?: number; bold?: true; color?: string } = { text };
    const sz = Number(q(rPr, "sz") ?? 0);
    if (sz > 0) run.size = Math.round((sz / 100) * (4 / 3));
    if (q(rPr, "b") === "1") run.bold = true;
    const color = readColor(rPr?.getElementsByTagName("a:solidFill")[0] ?? null, theme);
    if (color) run.color = color;
    runs.push(run);
  }
  if (runs.length === 0 && paragraph.getElementsByTagName("a:fld").length > 0) {
    warnings.add("页码/占位字段（fld）按空处理");
  }
  return runs;
}

/** txBody → deck text 元素内容（runs 数组，段落间 \n；bullet 加前缀） */
function readTextBody(txBody: Element, theme: Record<string, string>, warnings: Set<string>): {
  runs: { text: string; size?: number; bold?: true; color?: string }[];
  align?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";
} {
  const runs: { text: string; size?: number; bold?: true; color?: string }[] = [];
  let align: "left" | "center" | "right" | undefined;
  let vAlign: "top" | "middle" | "bottom" | undefined;
  const bodyPr = childByLocal(txBody, "bodyPr");
  const anchor = q(bodyPr, "anchor");
  if (anchor === "ctr") vAlign = "middle";
  else if (anchor === "b") vAlign = "bottom";

  const paragraphs = Array.from(txBody.children).filter((e) => e.nodeName.replace(/^.*:/, "") === "p");
  paragraphs.forEach((p, i) => {
    if (i > 0) runs.push({ text: "\n" });
    const pPr = childByLocal(p, "pPr");
    const algn = q(pPr, "algn");
    if (algn === "ctr") align = align ?? "center";
    else if (algn === "r") align = align ?? "right";
    const bulleted = childByLocal(p, "buChar") !== null || childByLocal(p, "buAutoNum") !== null;
    let first = true;
    for (const run of readRuns(p, theme, warnings)) {
      // 项目符号只加段落首个 run
      runs.push(bulleted && first ? { ...run, text: "• " + run.text } : run);
      first = false;
    }
  });
  return { runs: runs.filter((r) => r.text !== ""), align, vAlign };
}

/** 形状几何映射；未知 prst 返回 rect（记告警） */
function readShapeKind(prst: string, warnings: Set<string>): { shape: ShapeKind; radius?: number } {
  if (prst === "ellipse") return { shape: "ellipse" };
  if (prst === "roundRect") return { shape: "rect", radius: 12 };
  if (prst !== "rect") warnings.add(`形状 ${prst} 按矩形近似`);
  return { shape: "rect" };
}

/** slide rels：rId → media 文件名 */
function readSlideRels(zip: JSZip, slidePath: string, parse: XmlParser): Promise<Record<string, string>> {
  const relPath = slidePath.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
  const file = zip.file(relPath);
  if (!file) return Promise.resolve({});
  return file.async("string").then((xml) => {
    const doc = parse(xml);
    const out: Record<string, string> = {};
    for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
      const id = rel.getAttribute("Id") ?? "";
      const target = rel.getAttribute("Target") ?? "";
      if (target.includes("../media/")) out[id] = target.replace(/^.*\.\.\//, "");
    }
    return out;
  });
}

/** theme1.xml clrScheme → schemeClr 名 → #hex */
function readTheme(zip: JSZip, parse: XmlParser): Promise<Record<string, string>> {
  const themeFile =
    zip.file("ppt/theme/theme1.xml") ?? zip.file(/ppt\/theme\/theme\d+\.xml/)?.[0] ?? null;
  if (!themeFile) return Promise.resolve({});
  return themeFile.async("string").then((xml) => {
    const doc = parse(xml);
    const scheme = doc.getElementsByTagName("a:clrScheme")[0];
    const out: Record<string, string> = {};
    if (!scheme) return out;
    for (const slot of Array.from(scheme.children)) {
      const name = slot.nodeName.replace(/^.*:/, ""); // dk1/lt1/dk2/lt2/accent1..
      const srgb = slot.getElementsByTagName("a:srgbClr")[0];
      const sys = slot.getElementsByTagName("a:sysClr")[0];
      const hex = srgb?.getAttribute("val") ?? sys?.getAttribute("lastClr");
      if (hex) out[name] = `#${hex.replace("#", "").toUpperCase()}`;
      // PowerPoint 语义：tx1=文字色(深) bg1=背景色(浅)，与 dk1/lt1 同值
      if (name === "dk1") out.tx1 = out[name];
      if (name === "lt1") out.bg1 = out[name];
    }
    return out;
  });
}

/** pptx 字节 → deck 文档 + 图片资产（调用方负责 doc.create 后逐个 attach） */
export async function importPptxToDeck(buf: ArrayBuffer, name: string, parse: XmlParser): Promise<PptxResult> {
  const warnings = new Set<string>();
  const zip = await JSZip.loadAsync(buf);

  // 页尺寸（presentation.xml p:sldSz），EMU → px
  let frameW = 1280;
  let frameH = 720;
  const presFile = zip.file("ppt/presentation.xml");
  if (presFile) {
    const pres = parse(await presFile.async("string"));
    const sldSz = pres.getElementsByTagName("p:sldSz")[0];
    const cx = Number(q(sldSz, "cx") ?? 0);
    const cy = Number(q(sldSz, "cy") ?? 0);
    if (cx > 0 && cy > 0) {
      frameW = Math.round(cx / EMU_PX);
      frameH = Math.round(cy / EMU_PX);
    }
  }

  // 主题色表
  const theme = await readTheme(zip, parse);

  // 页序：presentation.xml sldIdLst → rels → slideN.xml
  const slideOrder: string[] = [];
  if (presFile) {
    const pres = parse(await presFile.async("string"));
    const relsDoc = parse(
      (await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")) ?? "<Relationships/>",
    );
    const rels: Record<string, string> = {};
    for (const rel of Array.from(relsDoc.getElementsByTagName("Relationship"))) {
      rels[rel.getAttribute("Id") ?? ""] = rel.getAttribute("Target") ?? "";
    }
    for (const sldId of pres.getElementsByTagName("p:sldId")) {
      const rid = sldId.getAttribute("r:id") ?? sldId.getAttribute("id") ?? "";
      const target = rels[rid]?.replace(/^\.\.\//, "ppt/").replace(/^slides\//, "ppt/slides/");
      if (target?.endsWith(".xml")) slideOrder.push(target);
    }
  }
  if (slideOrder.length === 0) {
    slideOrder.push(
      ...Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => (Number(a.match(/\d+/)?.[0]) || 0) - (Number(b.match(/\d+/)?.[0]) || 0)),
    );
  }

  const images: PptxImage[] = [];
  const imageNames = new Set<string>();
  const frames: PptxResult["doc"]["frames"] = [];

  for (let i = 0; i < slideOrder.length; i++) {
    const slidePath = slideOrder[i]!;
    const file = zip.file(slidePath);
    if (!file) continue;
    const doc = parse(await file.async("string"));
    const spTree = doc.getElementsByTagName("p:spTree")[0];
    if (!spTree) continue;
    const rels = await readSlideRels(zip, slidePath, parse);

    const elements: El[] = [];
    const frame: PptxResult["doc"]["frames"][number] = {
      id: `s${i + 1}`,
      w: frameW,
      h: frameH,
      type: "slide",
      name: `第 ${i + 1} 页`,
      elements,
    };

    // 页背景：p:bg/bgPr/solidFill
    const bg = doc.getElementsByTagName("p:bg")[0];
    const bgPr = bg ? childByLocal(bg, "bgPr") : null;
    const bgColor = bgPr ? readColor(childByLocal(bgPr, "solidFill"), theme) : undefined;
    if (bgColor) frame.background = bgColor;

    for (const node of Array.from(spTree.children)) {
      const kind = node.nodeName.replace(/^.*:/, "");

      if (kind === "pic") {
        // 图片：blip@r:embed → rels → media 字节落资产
        const blip = node.getElementsByTagName("a:blip")[0];
        const rid = blip?.getAttribute("r:embed") ?? blip?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? "";
        const media = rels[rid];
        const xfrm = readXfrm(childByLocal(node, "spPr"));
        if (media && xfrm) {
          const mediaFile = zip.file(`ppt/${media}`) ?? zip.file(media);
          if (mediaFile) {
            const base64 = await mediaFile.async("base64");
            const filename = media.split("/").pop() ?? `image${images.length + 1}.png`;
            let unique = filename;
            let n = 2;
            while (imageNames.has(unique)) unique = `dup${n++}-${filename}`;
            imageNames.add(unique);
            images.push({ name: unique, base64 });
            elements.push({
              kind: "image",
              id: `e${elements.length + 1}`,
              src: `${name}-assets/${unique}`,
              x: xfrm.x,
              y: xfrm.y,
              w: xfrm.w,
              h: xfrm.h,
              fit: "contain",
            } as El);
          }
        }
        continue;
      }

      if (kind === "graphicFrame") {
        // 表格：a:tbl → deck table
        const tbl = node.getElementsByTagName("a:tbl")[0];
        const xfrm = readXfrm(node.getElementsByTagName("p:xfrm")[0] ?? null);
        if (tbl && xfrm) {
          const rows = Array.from(tbl.getElementsByTagName("a:tr")).map((tr) =>
            Array.from(tr.getElementsByTagName("a:tc")).map((tc) =>
              Array.from(tc.getElementsByTagName("a:t")).map((t) => t.textContent ?? "").join(""),
            ),
          );
          if (rows.length > 0) {
            elements.push({
              kind: "table",
              id: `e${elements.length + 1}`,
              x: xfrm.x,
              y: xfrm.y,
              w: xfrm.w,
              h: xfrm.h,
              rows,
              header: true,
            } as El);
          }
        } else if (node.getElementsByTagName("a:graphic").length > 0) {
          warnings.add("图表/SmartArt 未转换");
        }
        continue;
      }

      if (kind !== "sp" && kind !== "cxnSp") continue;
      const spPr = childByLocal(node, "spPr");
      const xfrm = readXfrm(spPr);
      if (!xfrm) continue;
      const txBody = childByLocal(node, "txBody");
      const textContent = txBody ? readTextBody(txBody, theme, warnings) : null;
      const hasText = textContent !== null && textContent.runs.length > 0;

      if (hasText && textContent) {
        // 文本框（含形状内文字：文字优先，形状底色进 shape 元素由 PPT 语义弱化，v1 只保文字）
        elements.push({
          kind: "text",
          id: `e${elements.length + 1}`,
          x: xfrm.x,
          y: xfrm.y,
          w: xfrm.w,
          h: xfrm.h,
          runs: textContent.runs,
          ...(textContent.align ? { align: textContent.align } : {}),
          ...(textContent.vAlign ? { vAlign: textContent.vAlign } : {}),
        } as El);
        continue;
      }

      // 纯形状（cxnSp 连线按 line 近似）
      const prstGeom = spPr?.getElementsByTagName("a:prstGeom")[0];
      const prst = prstGeom?.getAttribute("prst") ?? "rect";
      const geom =
        kind === "cxnSp"
          ? { shape: "line" as ShapeKind }
          : readShapeKind(prst, warnings);
      const fill = readColor(spPr?.getElementsByTagName("a:solidFill")[0] ?? null, theme);
      const ln = spPr?.getElementsByTagName("a:ln")[0] ?? null;
      const stroke = readColor(ln?.getElementsByTagName("a:solidFill")[0] ?? null, theme);
      if (!fill && !stroke && geom.shape === "rect") continue; // 空占位形状不落元素
      elements.push({
        kind: "shape",
        id: `e${elements.length + 1}`,
        shape: geom.shape,
        x: xfrm.x,
        y: xfrm.y,
        w: xfrm.w,
        h: xfrm.h,
        ...(geom.radius ? { radius: geom.radius } : {}),
        ...(fill ? { fill } : {}),
        ...(stroke ? { stroke } : { stroke: "none" }),
        ...(xfrm.rot ? { rotation: xfrm.rot } : {}),
      } as El);
    }

    frames.push(frame);
  }

  if (frames.length === 0) {
    frames.push({ id: "s1", w: frameW, h: frameH, type: "slide", elements: [] });
  }
  return {
    doc: {
      version: 2,
      meta: { name, pagePreset: "16:9", kind: "deck" },
      objects: [],
      frames,
    },
    images,
    warnings: [...warnings],
  };
}
