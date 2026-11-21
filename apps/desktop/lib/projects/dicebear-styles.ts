/**
 * DiceBear 全量风格清单：`@dicebear/styles` 自带的 61 种风格。
 *
 * 「随机」头像从整个 DiceBear 目录里抽，而不是只限 Gaze 的 24 个预设。
 * 定义在这里静态引入——Next 静态导出 + kova:// 本地协议下不依赖运行时
 * 动态 chunk；`Style` 实例按需懒构造并缓存，61 份 schema 校验只在真正
 * 抽到某一种风格时发生。
 */
import { Style } from "@dicebear/core";
import adventurerNeutral from "@dicebear/styles/adventurer-neutral.json";
import adventurer from "@dicebear/styles/adventurer.json";
import avataaarsNeutral from "@dicebear/styles/avataaars-neutral.json";
import avataaars from "@dicebear/styles/avataaars.json";
import bigEarsNeutral from "@dicebear/styles/big-ears-neutral.json";
import bigEars from "@dicebear/styles/big-ears.json";
import bigSmile from "@dicebear/styles/big-smile.json";
import blobs from "@dicebear/styles/blobs.json";
import botttsNeutral from "@dicebear/styles/bottts-neutral.json";
import bottts from "@dicebear/styles/bottts.json";
import cameo from "@dicebear/styles/cameo.json";
import clay from "@dicebear/styles/clay.json";
import constellation from "@dicebear/styles/constellation.json";
import critters from "@dicebear/styles/critters.json";
import croodlesNeutral from "@dicebear/styles/croodles-neutral.json";
import croodles from "@dicebear/styles/croodles.json";
import cutouts from "@dicebear/styles/cutouts.json";
import disco from "@dicebear/styles/disco.json";
import dylan from "@dicebear/styles/dylan.json";
import funEmoji from "@dicebear/styles/fun-emoji.json";
import gaze from "@dicebear/styles/gaze.json";
import glass from "@dicebear/styles/glass.json";
import glyphs from "@dicebear/styles/glyphs.json";
import icons from "@dicebear/styles/icons.json";
import identicon from "@dicebear/styles/identicon.json";
import initialFace from "@dicebear/styles/initial-face.json";
import initials from "@dicebear/styles/initials.json";
import landscape from "@dicebear/styles/landscape.json";
import lineFace from "@dicebear/styles/line-face.json";
import loops from "@dicebear/styles/loops.json";
import loreleiNeutral from "@dicebear/styles/lorelei-neutral.json";
import lorelei from "@dicebear/styles/lorelei.json";
import marbles from "@dicebear/styles/marbles.json";
import micah from "@dicebear/styles/micah.json";
import miniavs from "@dicebear/styles/miniavs.json";
import moods from "@dicebear/styles/moods.json";
import notionistsNeutral from "@dicebear/styles/notionists-neutral.json";
import notionists from "@dicebear/styles/notionists.json";
import openPeeps from "@dicebear/styles/open-peeps.json";
import patchwork from "@dicebear/styles/patchwork.json";
import personas from "@dicebear/styles/personas.json";
import pixelArtNeutral from "@dicebear/styles/pixel-art-neutral.json";
import pixelArt from "@dicebear/styles/pixel-art.json";
import pixelbot from "@dicebear/styles/pixelbot.json";
import planets from "@dicebear/styles/planets.json";
import rings from "@dicebear/styles/rings.json";
import shadows from "@dicebear/styles/shadows.json";
import shapeGrid from "@dicebear/styles/shape-grid.json";
import shapes from "@dicebear/styles/shapes.json";
import slice from "@dicebear/styles/slice.json";
import sprouts from "@dicebear/styles/sprouts.json";
import squircles from "@dicebear/styles/squircles.json";
import stack from "@dicebear/styles/stack.json";
import stripes from "@dicebear/styles/stripes.json";
import thumbs from "@dicebear/styles/thumbs.json";
import toonHead from "@dicebear/styles/toon-head.json";
import triangles from "@dicebear/styles/triangles.json";
import voxelArt from "@dicebear/styles/voxel-art.json";
import voxelBot from "@dicebear/styles/voxel-bot.json";
import waves from "@dicebear/styles/waves.json";
import weave from "@dicebear/styles/weave.json";

/** 风格 id → 定义 JSON（id 与 @dicebear/styles 的导出名一致） */
const DEFINITIONS: Readonly<Record<string, unknown>> = {
  "adventurer-neutral": adventurerNeutral,
  adventurer,
  "avataaars-neutral": avataaarsNeutral,
  avataaars,
  "big-ears-neutral": bigEarsNeutral,
  "big-ears": bigEars,
  "big-smile": bigSmile,
  blobs,
  "bottts-neutral": botttsNeutral,
  bottts,
  cameo,
  clay,
  constellation,
  critters,
  "croodles-neutral": croodlesNeutral,
  croodles,
  cutouts,
  disco,
  dylan,
  "fun-emoji": funEmoji,
  gaze,
  glass,
  glyphs,
  icons,
  identicon,
  "initial-face": initialFace,
  initials,
  landscape,
  "line-face": lineFace,
  loops,
  "lorelei-neutral": loreleiNeutral,
  lorelei,
  marbles,
  micah,
  miniavs,
  moods,
  "notionists-neutral": notionistsNeutral,
  notionists,
  "open-peeps": openPeeps,
  patchwork,
  personas,
  "pixel-art-neutral": pixelArtNeutral,
  "pixel-art": pixelArt,
  pixelbot,
  planets,
  rings,
  shadows,
  "shape-grid": shapeGrid,
  shapes,
  slice,
  sprouts,
  squircles,
  stack,
  stripes,
  thumbs,
  "toon-head": toonHead,
  triangles,
  "voxel-art": voxelArt,
  "voxel-bot": voxelBot,
  waves,
  weave,
};

export const DICEBEAR_STYLE_IDS: readonly string[] = Object.keys(DEFINITIONS);

const STYLE_ID_SET = new Set(DICEBEAR_STYLE_IDS);

export function isDicebearStyleId(value: string): boolean {
  return STYLE_ID_SET.has(value);
}

/** 每种风格的 Style 实例只构造一次（schema 校验 + 深拷贝不便宜） */
const STYLE_CACHE = new Map<string, Style>();

/** 风格 id → Style 实例；未知 id 返回 null */
export function dicebearStyle(id: string): Style | null {
  const cached = STYLE_CACHE.get(id);
  if (cached) return cached;
  const definition = DEFINITIONS[id];
  if (!definition) return null;
  const style = new Style<unknown>(definition);
  STYLE_CACHE.set(id, style);
  return style;
}
