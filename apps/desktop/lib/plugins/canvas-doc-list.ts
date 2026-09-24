"use client";

import { fsListDir, fsReadFile } from "@/lib/workspace/fs";
import type { DocListItem } from "./ui-plugin-bridge";

/**
 * 画布档（`*.canvas.json`）盘点：插件面板首页的"历史卡片墙"数据源。
 *
 * 走 Tauri fs 命令（workspace 信任根 + 相对路径守卫），刻意只做浅扫：
 * 根目录 + 两层子目录、最多 60 份——首页卡片不是文件浏览器，穷尽仓库没有意义；
 * 每份档读内容做摘要（名称/类型/页框布局），读不动或解析失败的直接跳过。
 * mtime 目前恒为 0（Rust 侧列目录不做逐项 stat），排序退化为按名称。
 */

/** 递归深度上限（根 = 0） */
const MAX_DEPTH = 2;
/** 卡片条数上限 */
const MAX_DOCS = 60;
/** 缩略图页框条数上限（宿主截断，插件端只管画） */
const MAX_PREVIEW_FRAMES = 24;

export async function listCanvasDocs(cwd: string | null): Promise<DocListItem[]> {
  if (!cwd) return [];
  const paths: string[] = [];
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
      if (/\.canvas\.json$/i.test(e.name)) paths.push(dir ? `${dir}/${e.name}` : e.name);
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
      continue;
    }
    items.push(summarize(path, doc));
  }
  items.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return items;
}

function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function summarize(path: string, doc: Record<string, unknown>): DocListItem {
  const meta = (doc.meta ?? {}) as Record<string, unknown>;
  // v1 老档是 slides 数组（插件读盘时会迁移成 frames），摘要按两者取一
  const frames = (
    Array.isArray(doc.frames)
      ? doc.frames
      : Array.isArray(doc.slides)
        ? doc.slides
        : []
  ) as Record<string, unknown>[];
  const objects = Array.isArray(doc.objects) ? doc.objects : [];
  const kind =
    meta.kind === "board" || meta.kind === "deck" || meta.kind === "ui"
      ? meta.kind
      : frames.length > 0 && objects.length === 0
        ? "deck"
        : "board";
  const fallbackName = (path.split("/").pop() ?? path).replace(/\.canvas\.json$/i, "");
  const name =
    typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : fallbackName;
  return {
    path,
    name,
    kind,
    mtime: 0,
    frames: frames.length,
    objects: objects.length,
    preview: frames.slice(0, MAX_PREVIEW_FRAMES).map((f) => ({
      x: num(f.x),
      y: num(f.y),
      w: num(f.w, 1280),
      h: num(f.h, 720),
      bg: typeof f.background === "string" ? f.background : "#ffffff",
    })),
  };
}
