/**
 * MCP 侧的画布内容渲染核（无 DOM：bun 直跑）。
 *
 * 与面板导出同库：SVG 字符串来自 ui/src/svg.ts 的 buildSvg（纯函数），
 * 本文件只补 MCP 环境独有的三件事：
 * ① 位图资产：image.src 是工作区相对路径 → 直接 readFileSync 转 dataURL
 *    （面板里那条 asset.request→宿主 base64 的桥在这里不需要）；
 * ② 文本测量：浏览器 canvas measureText 没有等价物 → 按 Unicode 区间近似字宽
 *    （CJK 全宽=1em、拉丁分桶），只影响折行位置，观感与面板一致的近似；
 * ③ 光栅化：@resvg/resvg-wasm（纯 wasm，随插件 node_modules 分发——napi 原生
 *    版无法进内置插件包）把 SVG 画成 PNG。字体用插件内置的 Noto Sans SC
 *    （mcp/fonts/，OFL）：wasm 沙箱读不了系统字体（loadSystemFonts 在 wasm
 *    胶水里是空实现），内置字体换来开发/打包、跨平台完全一致的渲染。PNG 超
 *    内联闸门（2MiB，见 sidecar tools/image-parts.ts）时自动降倍率重渲。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

// wasm 只能初始化一次且必须先于任何 Resvg 构造；模块顶层的 await 保证同步 API
// （rasterizePng）拿到即用。字节从依赖包本体读：mcp/ 往上一级即插件根，开发态
// （仓库 node_modules）与物化态（插件根 node_modules，打包器 vendor）同布局。
// 缺文件 = 包被裁了运行时依赖，直接报可读错误。
try {
  await initWasm(
    readFileSync(
      new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url),
    ),
  );
} catch (err) {
  throw new Error(
    "ui-design mcp: 初始化 resvg wasm 失败（node_modules/@resvg/resvg-wasm 不可达，插件包不完整？）",
    { cause: err },
  );
}

/** 内置渲染字体：wasm 只认 fontBuffers（系统字体发现未实现），一次性读入复用 */
const FONT_BUFFERS = (() => {
  try {
    return [readFileSync(new URL("./fonts/NotoSansSC-Regular.otf", import.meta.url))];
  } catch (err) {
    throw new Error("ui-design mcp: 内置字体 mcp/fonts/NotoSansSC-Regular.otf 缺失（插件包不完整？）", {
      cause: err,
    });
  }
})();

/** resvg 字体档：家族名兜底接住 FONT_STACK 里的 system-ui/…/sans-serif 各写法 */
const FONT_OPTIONS = {
  fontBuffers: FONT_BUFFERS,
  defaultFontFamily: "Noto Sans SC",
  sansSerifFamily: "Noto Sans SC",
} as const;
import { findNode, type DesignDoc, type DesignNode } from "../ui/src/doc";
import { buildSvg, collectImageSrcs } from "../ui/src/svg";
import type { MeasureFn } from "../ui/src/leafer/scene";

/* ---------------- 资产：工作区文件 → dataURL ---------------- */

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** resvg 能内嵌解码的栅格格式；svg 外链等一律按缺图占位 */
function imageMime(p: string): string | null {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? null;
}

const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export type DocImages = {
  /** src → dataURL（null=读不到，画占位）——内联 SVG / 光栅化用 */
  urls: Map<string, string | null>;
  /** src → 原始字节（null=读不到）——导出包把资产复制进 assets/ 用 */
  raw: Map<string, Buffer | null>;
  missing: number;
};

/**
 * 读节点子树引用的位图资产（src = 工作区相对路径）。绝对/越界/未知格式/超大 → 该 src
 * 记 null（缺图占位）。同时给出 dataURL 与原始字节：前者供 SVG/光栅化，后者供导出包复制。
 */
export function readDocImages(workspace: string, nodes: DesignNode[]): DocImages {
  const urls = new Map<string, string | null>();
  const raw = new Map<string, Buffer | null>();
  let missing = 0;
  for (const src of collectImageSrcs(nodes)) {
    try {
      if (path.isAbsolute(src)) throw new Error("absolute");
      const abs = path.resolve(workspace, src);
      if (!abs.startsWith(workspace + path.sep)) throw new Error("escape");
      const mime = imageMime(abs);
      if (!mime) throw new Error("format");
      const buf = readFileSync(abs);
      if (buf.byteLength > MAX_ASSET_BYTES) throw new Error("large");
      urls.set(src, `data:${mime};base64,${buf.toString("base64")}`);
      raw.set(src, buf);
    } catch {
      urls.set(src, null);
      raw.set(src, null);
      missing++;
    }
  }
  return { urls, raw, missing };
}

/* ---------------- 文本测量：Unicode 近似 ---------------- */

/** 全角区（CJK 汉字/假名/韩文/全角标点）→ 1em；其余按桶近似 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo 初声
    (cp >= 0x2e80 && cp <= 0x303f) || // CJK 部首/假名/标点
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul 音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
    (cp >= 0xfe30 && cp <= 0xfe4f) || // 兼容标点
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 窄字符（约 0.28em）与次窄字符（约 0.36em）分桶；其余拉丁按常规宽窄 */
const NARROW = new Set(["i", "l", "ï", "ı", "!", "'", ".", ",", ":", ";", "|", "`", "^", "(", ")", "[", "]", "{", "}", "/", "\\", "­"]);
const NARROW2 = new Set(["f", "t", "r", "J", "[", "j", "-", "]"]);

function charFactor(ch: string): number {
  if (isWide(ch.codePointAt(0) ?? 0)) return 1;
  if (ch === " ") return 0.3;
  if (NARROW.has(ch)) return 0.28;
  if (NARROW2.has(ch)) return 0.36;
  if (ch === "m") return 0.85;
  if (ch === "M") return 0.94;
  if (ch === "w") return 0.78;
  if (ch === "W") return 0.9;
  if (ch === "%" || ch === "&" || ch === "@") return 0.88;
  if (ch >= "0" && ch <= "9") return 0.56;
  if (ch >= "A" && ch <= "Z") return 0.68;
  if (ch >= "a" && ch <= "z") return 0.53;
  return 0.6;
}

/** 近似 MeasureFn：接口与 canvas 版一致（width / ascent / descent），fontCss 解析字号与粗细 */
export function makeApproxMeasure(): MeasureFn {
  const cache = new Map<string, number>();
  return (text, fontCss) => {
    const size = parseFloat(fontCss.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16") || 16;
    const bold = /\b700\b|bold/.test(fontCss);
    const key = `${text}|${size}|${bold ? 1 : 0}`;
    let width = cache.get(key);
    if (width === undefined) {
      let sum = 0;
      for (const ch of text) sum += charFactor(ch);
      width = sum * size * (bold ? 1.04 : 1);
      cache.set(key, width);
    }
    return { width, ascent: size * 0.8, descent: size * 0.2 };
  };
}

/* ---------------- 光栅化 ---------------- */

/** sidecar 内联闸门（image-parts.ts：单图 ≤2MiB）；留 5% 余量 */
const PNG_BUDGET = Math.floor(2 * 1024 * 1024 * 0.95);

export type RenderPngOptions = {
  /** 输出最长边像素上限（默认 1600） */
  maxDim?: number;
  /** 目标倍率上限（默认 2x；实际倍率 = min(scale, maxDim/最长边)） */
  scale?: number;
  /** 画幅底色；null = 透明 */
  background?: string | null;
  /** 字节预算：超过则降倍率重渲。缺省 = 内联闸门 2MiB；null = 不设上限（导出文件用） */
  budgetBytes?: number | null;
};

export type RenderedPng = {
  png: Uint8Array;
  width: number;
  height: number;
  boxW: number;
  boxH: number;
  /** 缺图数（image 资产读不到 → 占位灰块） */
  missingImages: number;
};

/**
 * SVG → PNG。给定倍率与最长边上限，超预算自动降倍率重渲（budgetBytes=null 时不降）。
 * 独立导出（文件）与截图（内联）共用；差别只在 budgetBytes。
 */
export function rasterizePng(
  svg: string,
  boxW: number,
  boxH: number,
  opts: { scale?: number; maxDim?: number; budgetBytes?: number | null } = {},
): { png: Uint8Array; width: number; height: number } {
  let ratio = opts.scale ?? 2;
  const maxDim = opts.maxDim ?? 1600;
  const budget = opts.budgetBytes === undefined ? PNG_BUDGET : opts.budgetBytes;
  ratio = Math.min(ratio, maxDim / Math.max(boxW, boxH));
  const draw = (r: number) => {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: Math.max(1, Math.round(boxW * r)) },
      font: { ...FONT_OPTIONS },
    });
    const img = resvg.render();
    return { png: img.asPng(), width: img.width, height: img.height };
  };
  for (let guard = 0; ; guard++) {
    const out = draw(Math.max(0.05, ratio));
    const over = budget !== null && out.png.byteLength > budget;
    if (!over || ratio <= 0.3 || guard >= 6) return out;
    ratio *= 0.7;
  }
}

/**
 * 设计档给定节点集合 → PNG 字节（世界盒为画幅）。ids 全不可见/不存在 → null。
 * 与面板 nodesToSvg 同一套 SVG 构建（ui/src/svg.ts），仅资产来源/测量/光栅化换成
 * bun 侧等价物，所以截图观感 ≈ 面板所见（文字折行可能有轻微近似差）。
 */
export function renderDocPng(
  workspace: string,
  doc: DesignDoc,
  ids: string[],
  opts: RenderPngOptions = {},
): RenderedPng | null {
  const nodes = ids
    .map((id) => findNode(doc, id)?.node)
    .filter((n): n is DesignNode => !!n && n.visible !== false);
  if (nodes.length === 0) return null;
  const imgs = readDocImages(workspace, nodes);
  const built = buildSvg(doc, nodes.map((n) => n.id), {
    measure: makeApproxMeasure(),
    images: imgs.urls,
    background: opts.background ?? undefined,
  });
  if (!built) return null;
  const { svg, box } = built;
  const r = rasterizePng(svg, box.w, box.h, { scale: opts.scale, maxDim: opts.maxDim, budgetBytes: opts.budgetBytes });
  return { ...r, boxW: Math.round(box.w), boxH: Math.round(box.h), missingImages: imgs.missing };
}

/**
 * 设计档给定节点集合 → 自包含 SVG 串（位图内联 dataURL，无外链）。导出包的
 * `screens/*.svg` 用；ids 全不可见/不存在 → null。
 */
export function renderDocSvg(
  workspace: string,
  doc: DesignDoc,
  ids: string[],
  opts: { background?: string | null } = {},
): { svg: string; boxW: number; boxH: number; missingImages: number } | null {
  const nodes = ids
    .map((id) => findNode(doc, id)?.node)
    .filter((n): n is DesignNode => !!n && n.visible !== false);
  if (nodes.length === 0) return null;
  const imgs = readDocImages(workspace, nodes);
  const built = buildSvg(doc, nodes.map((n) => n.id), {
    measure: makeApproxMeasure(),
    images: imgs.urls,
    background: opts.background ?? undefined,
  });
  if (!built) return null;
  return { svg: built.svg, boxW: Math.round(built.box.w), boxH: Math.round(built.box.h), missingImages: imgs.missing };
}
