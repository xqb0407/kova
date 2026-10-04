"use client";

import { fsListDir, fsReadFile } from "@/lib/workspace/fs";
import type { DocListItem } from "./ui-plugin-bridge";

/**
 * 工作区文档盘点：插件面板首页"历史卡片墙"数据源。
 *
 * 走 Tauri fs 命令（workspace 信任根 + 相对路径守卫），刻意只做浅扫：
 * 根目录 + 两层子目录、最多 60 份——首页卡片不是文件浏览器，穷尽仓库没有意义。
 * 扫描范围 = 调用方给的面板认领 glob（已装插件各面板的 opens 摘要，缺省仍是
 * `*.canvas.json` 兼容旧调用），同一份文件可能命中多个 glob 只列一次；每份档
 * 读内容做摘要（画布档给页框布局缩略图、Univer 快照档给名称，按 kind 分支）；
 * JSON 解析失败的**照常列出并打 corrupt 标记**——静默跳过会让用户以为文档丢了
 * （task 模式"打开是空的"的帮凶之一），坏档在卡片上可见才能被发现和处理。
 * mtime 目前恒为 0（Rust 侧列目录不做逐项 stat），排序退化为按名称。
 */

/** 递归深度上限（根 = 0） */
const MAX_DEPTH = 2;
/** 卡片条数上限 */
const MAX_DOCS = 60;
/** 缩略图页框条数上限（宿主截断，插件端只管画） */
const MAX_PREVIEW_FRAMES = 24;

/** 缺省扫描 glob：兼容旧调用方（宿主未传面板 opens 时仍能列出画布档） */
const DEFAULT_GLOBS = ["*.canvas.json"];

/** glob → RegExp（与 sidecar manifest.globMatch 同语义：`*` 不跨路径分隔符，另 `?` 单字符） */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** 路径后缀 → 列表 kind（.univer.json 快照档优先于宽 glob 的画布后缀） */
function kindOfPath(path: string): DocListItem["kind"] {
  if (/\.sheet\.univer\.json$/i.test(path)) return "sheet";
  if (/\.doc\.univer\.json$/i.test(path)) return "doc";
  if (/\.uidesign\.json$/i.test(path)) return "design";
  return "board";
}

export async function listCanvasDocs(
  cwd: string | null,
  globs: string[] = DEFAULT_GLOBS,
): Promise<DocListItem[]> {
  if (!cwd) return [];
  const patterns = (globs.length > 0 ? globs : DEFAULT_GLOBS).map(globToRegExp);
  // 与 sidecar open-panel-tool 同款：相对路径与文件名各自试一遍——
  // `*.canvas.json` 这类按相对路径只能打中根级文件，basename 兜底才覆盖子目录
  const match = (rel: string, name: string) =>
    patterns.some((re) => re.test(rel) || re.test(name));
  const paths: string[] = [];
  const seen = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || paths.length >= MAX_DOCS) return;
    const listing = await fsListDir(cwd, dir);
    if (!listing) return;
    for (const e of listing.entries) {
      if (paths.length >= MAX_DOCS) return;
      if (e.dir) {
        await walk(dir ? `${dir}/${e.name}` : e.name, depth + 1);
        continue;
      }
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (!match(rel, e.name) || seen.has(rel)) continue;
      seen.add(rel);
      paths.push(rel);
    }
  };
  await walk("", 0);

  const items: DocListItem[] = [];
  for (const path of paths) {
    const f = await fsReadFile(cwd, path);
    // 二进制/超长（截断）都不进列表：截断的 JSON 会解析失败，UI 上只会多一张坏卡
    if (!f || f.binary || f.truncated) continue;
    let doc: Record<string, unknown> | null = null;
    try {
      doc = JSON.parse(f.content) as Record<string, unknown>;
    } catch {
      doc = null;
    }
    // 解析失败不静默丢：坏档也要在卡片墙上现身（标注 + 可删），
    // 否则用户只会看到"面板是空的"，不知道盘上其实有东西。
    items.push(doc ? summarize(path, doc) : corruptItem(path));
  }
  items.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return items;
}

/** 内容不可解析的档：只报路径与名字，摘要字段全空 */
function corruptItem(path: string): DocListItem {
  return {
    path,
    name: (path.split("/").pop() ?? path)
      .replace(/\.sheet\.univer\.json$/i, "")
      .replace(/\.doc\.univer\.json$/i, "")
      .replace(/\.uidesign\.json$/i, "")
      .replace(/\.canvas\.json$/i, ""),
    kind: kindOfPath(path),
    mtime: 0,
    frames: 0,
    objects: 0,
    preview: [],
    corrupt: true,
  };
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** 快照档展示名：文档内声明的名称优先，缺省退文件名（不含认领后缀） */
function snapshotName(path: string, doc: Record<string, unknown>): string {
  const declared = typeof doc.name === "string" ? doc.name : typeof doc.title === "string" ? doc.title : "";
  if (declared.trim()) return declared.trim();
  return (path.split("/").pop() ?? path)
    .replace(/\.sheet\.univer\.json$/i, "")
    .replace(/\.doc\.univer\.json$/i, "");
}

/**
 * UI 设计档（`*.uidesign.json`）摘要：与插件端 docStats 同口径——
 * frames=当前页顶层画板数、objects=全档节点总数、preview=当前页画板布局。
 * 改这里记得同步 plugins/ui-design/ui/src/doc.ts 的 docStats。
 */
function summarizeDesign(path: string, doc: Record<string, unknown>): DocListItem {
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  const fallbackName = (path.split("/").pop() ?? path).replace(/\.uidesign\.json$/i, "");
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName;
  const pages = Array.isArray(doc.pages) ? (doc.pages as Record<string, unknown>[]) : [];
  const active = typeof doc.activePage === "string" ? pages.find((p) => p.id === doc.activePage) : undefined;
  const page = active ?? pages[0];
  const nodes = (Array.isArray(page?.nodes) ? (page as Record<string, unknown>).nodes : []) as Record<string, unknown>[];
  const countTree = (list: Record<string, unknown>[]): number =>
    list.reduce((acc, n) => acc + 1 + countTree(Array.isArray(n.children) ? (n.children as Record<string, unknown>[]) : []), 0);
  const frames = nodes.filter((n) => n.type === "frame");
  return {
    path,
    name,
    kind: "design",
    mtime: 0,
    frames: frames.length,
    objects: countTree(nodes),
    preview: frames.slice(0, MAX_PREVIEW_FRAMES).map((f) => {
      const fills = Array.isArray(f.fills) ? (f.fills as Record<string, unknown>[]) : [];
      const solid = fills.find((x) => x.type === "solid" && x.visible !== false);
      return {
        x: num(f.x),
        y: num(f.y),
        w: num(f.w, 390),
        h: num(f.h, 844),
        bg: typeof solid?.color === "string" ? solid.color : "#ffffff",
      };
    }),
  };
}

function summarize(path: string, doc: Record<string, unknown>): DocListItem {
  const kind = kindOfPath(path);
  if (kind === "design") return summarizeDesign(path, doc);
  if (kind !== "board") {
    // Univer 快照档：卡片只报名称，frames/objects/preview 是画布档专属语义，恒空
    return {
      path,
      name: snapshotName(path, doc),
      kind,
      mtime: 0,
      frames: 0,
      objects: 0,
      preview: [],
    };
  }
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  // v3 纯画布：objects 单层（旧 v1 slides / v2 frames 由插件读盘时自动拍平，
  // 这里对旧档只兜底数一下 objects，preview 用元素包围盒簇示意）
  const objects = (Array.isArray(doc.objects) ? doc.objects : []) as Record<string, unknown>[];
  const canvasKind = meta.kind === "ui" ? "ui" : "board"; // deck 已成历史，一律按画布处理
  const fallbackName = (path.split("/").pop() ?? path).replace(/\.canvas\.json$/i, "");
  const name =
    typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName;
  // 缩略图：取前 24 个元素的包围盒（聚类示意，非精确排版）
  const preview = objects.slice(0, MAX_PREVIEW_FRAMES).map((f) => ({
    x: num(f.x),
    y: num(f.y),
    w: num(f.w, 120),
    h: num(f.h, 80),
    bg: typeof f.fill === "string" ? f.fill : typeof f.background === "string" ? f.background : "#ffffff",
  }));
  return {
    path,
    name,
    kind: canvasKind,
    mtime: 0,
    frames: 0,
    objects: objects.length,
    preview,
  };
}
