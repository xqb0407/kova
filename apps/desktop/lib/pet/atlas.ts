/**
 * 桌宠模块 · 图集契约与几何数学（纯函数，无 React / DOM）。
 *
 * 行语义对齐 Codex 官方契约（`openai/skills` 的 hatch-pet / codex-pet-contract）：
 * 单张雪碧图 8 列、格 192×208，v1 共 9 行固定顺序，v2 多两行共 16 格视线（look）。
 * 渲染走 `background-size: 列×100% 行×100%` + `background-position` 百分比切格，
 * 与图集真实像素解耦（`toPercent`）。
 */

import type { PetAtlasGeometry, PetMotion } from "./types";

/** 图集固定列数（契约）。 */
export const PET_ATLAS_COLUMNS = 8;

/** 图集单格宽（px，契约）。 */
export const PET_FRAME_WIDTH = 192;

/** 图集单格高（px，契约）。 */
export const PET_FRAME_HEIGHT = 208;

/** v1 图集行数（9 行动作，无视线格）。 */
export const PET_ATLAS_ROWS_V1 = 9;

/** v2 图集行数（11 行 = 9 行动作 + 2 行 × 8 格视线）。 */
export const PET_ATLAS_ROWS_V2 = 11;

/** v2 视线格起始行。 */
export const PET_LOOK_START_ROW = 9;

/** 视线格总数（16 = 每 22.5° 一格，顺时针从正上开始）。 */
export const PET_LOOK_CELLS = 16;

/** 视线追踪死区（px）：偏移小于它视为「没在看」，回待机帧。 */
export const PET_LOOK_DEADZONE = 24;

/** 视线作用半径系数：指针超出 `max(宽, 高) × 系数` 直接回待机帧。 */
export const PET_LOOK_RADIUS_FACTOR = 1.25;

/** 默认显示宽（px）。Codex 格子里人物基本铺满，同宽度下比 16:9 视频画布宠大一倍，基准取一半。 */
export const PET_DEFAULT_SIZE = 231;

/** 图集默认行表（行号 = Codex 契约的固定行序）。
 *
 * idle 的逐帧时长取「慢速呼吸档」（首/末帧长停留）：匀速 160ms 的常驻待机
 * 会切帧过快、从不停顿，观感像快速抖动而不是呼吸。其它行匀速即可。
 */
export const ATLAS_ROWS: Record<PetMotion, {
  row: number;
  frames: number;
  interval: number;
  durations?: number[];
  loop: boolean;
}> = {
  "idle": { row: 0, frames: 6, interval: 160, durations: [1680, 660, 660, 840, 840, 1920], loop: true },
  "moving-right": { row: 1, frames: 8, interval: 120, loop: true },
  "moving-left": { row: 2, frames: 8, interval: 120, loop: true },
  "waving": { row: 3, frames: 4, interval: 140, loop: false },
  "jumping": { row: 4, frames: 5, interval: 140, loop: false },
  "failed": { row: 5, frames: 8, interval: 140, loop: false },
  "waiting": { row: 6, frames: 6, interval: 150, loop: true },
  "working": { row: 7, frames: 6, interval: 120, loop: true },
  "review": { row: 8, frames: 6, interval: 150, loop: false },
};

/** 网格序号 → 背景图百分比定位（配合 `background-size: count×100%`）。 */
export function toPercent(index: number, count: number): number {
  return count <= 1 ? 0 : (index * 100) / (count - 1);
}

/** v2 视线格序号 → 行/列。行 9 放 0-7（上→右上→…→左上左半圈），行 10 放 8-15。 */
export function lookCellRowCol(index: number): { row: number; column: number } {
  const i = ((Math.floor(index) % PET_LOOK_CELLS) + PET_LOOK_CELLS) % PET_LOOK_CELLS;
  return { row: PET_LOOK_START_ROW + Math.floor(i / PET_ATLAS_COLUMNS), column: i % PET_ATLAS_COLUMNS };
}

/**
 * 指针相对宠物中心的偏移 → 视线格序号（22.5° 一格，顺时针，0 = 正上）。
 * 死区内（含零向量）返回 undefined = 回待机帧。
 */
export function lookIndexFor(
  offset: { x: number; y: number },
  deadzone = 0,
): number | undefined {
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) return undefined;
  if (Math.hypot(offset.x, offset.y) <= Math.max(0, deadzone)) return undefined;
  // atan2(x, -y)：屏幕 y 向下，取负让 0° 落在正上，顺时针为正
  const degrees = (Math.atan2(offset.x, -offset.y) * 180) / Math.PI;
  const normalized = ((degrees % 360) + 360) % 360;
  return Math.round(normalized / 22.5) % PET_LOOK_CELLS;
}

/** 视线是否可用：仅 v2 图集（行数 > 9）支持。 */
export function lookSupported(geometry: PetAtlasGeometry): boolean {
  return geometry.rows > PET_ATLAS_ROWS_V1;
}
