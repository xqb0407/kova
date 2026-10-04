"use client";

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Html,
  Instance,
  Instances,
  OrbitControls,
  RoundedBoxGeometry,
} from "@react-three/drei";
import type { Group } from "three";
import { useHtmlDark } from "@/lib/settings/use-html-dark";
import { formatTokens, type UsageStatsDay } from "@/lib/model/usage-stats";
import {
  adaptiveWeeks,
  buildHeatGrid,
  heatColor,
  type HeatCell,
  type HeatGranularity,
} from "./usage-heatmap";

/**
 * Token 活动热力图 3D 视图（等距圆角瓦片风格）：
 * 1. 每一天都是一块圆角瓦片——空白日为低矮的素色瓦片，活跃日按强度升高并着色，
 *    数据稀疏时整张网格依然完整，不会出现「空旷线框 + 孤零零几根柱子」；
 * 2. 展示周数按数据自适应（adaptiveWeeks；平面视图恒为 53 周，不受影响），
 *    只有几天数据时网格也是紧凑的小方块；
 * 3. 相机俯视略带侧转（等距感），按网格实际投影范围（宽度 + 俯仰后的深度 + 实际最高瓦片）
 *    精确拟合，无论数据多少内容都撑满画面；
 * 4. 挂载/切换粒度时瓦片从左到右波浪式生长。
 * 经 next/dynamic 按需加载（three 全家桶不进设置页首屏包），buildHeatGrid 与
 * 2D 共用同一网格。
 */

const SPACING = 0.8;
const TILE = SPACING * 0.86;
const TILE_RADIUS = 0.13;
const ROWS = 7;
const FOV = 38;
const ELEVATION = (52 * Math.PI) / 180;
const AZIMUTH = (12 * Math.PI) / 180;
const INACTIVE_H = 0.07;
const ACTIVE_BASE = 0.16;
const ACTIVE_RISE = 1.25;
const STAGGER = 0.014; // 每列波浪延迟（秒）
const RISE = 0.5; // 单块瓦片生长时长（秒）

type Tile = HeatCell & { x: number; z: number; h: number };

/** hex 向白色混合 amt 比例（hover 提亮用） */
function lighten(hex: string, amt: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** 相机拟合：按视口宽高比把「网格宽度」与「俯仰后的深度+实际最高瓦片」两个投影范围都装进画面 */
function CameraRig({
  width,
  depth,
  maxH,
}: {
  width: number;
  depth: number;
  maxH: number;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = Math.max(size.width / Math.max(size.height, 1), 0.5);
    const halfVFov = (FOV / 2) * (Math.PI / 180);
    const halfHFov = Math.atan(Math.tan(halfVFov) * aspect);
    const distW = width / 2 / Math.tan(halfHFov);
    const distH =
      ((depth * Math.cos(ELEVATION)) / 2 +
        (maxH * Math.sin(ELEVATION)) / 2 +
        0.35) /
      Math.tan(halfVFov);
    const dist = Math.max(distW, distH) / 0.92;
    camera.position.set(
      dist * Math.cos(ELEVATION) * Math.sin(AZIMUTH),
      0.3 + dist * Math.sin(ELEVATION),
      dist * Math.cos(ELEVATION) * Math.cos(AZIMUTH),
    );
    camera.lookAt(0, 0.3, 0);
  }, [camera, size.width, size.height, width, depth, maxH]);
  return null;
}

/** 波浪生长动画：逐列延迟 + easeOutCubic，缩放/位移每帧直接写进实例 */
function TilesAnimator({
  tiles,
  refs,
  start,
}: {
  tiles: Tile[];
  refs: React.RefObject<(Group | null)[]>;
  start: React.RefObject<number>;
}) {
  useFrame(() => {
    const t = performance.now() / 1000 - start.current;
    for (let i = 0; i < tiles.length; i += 1) {
      const obj = refs.current[i];
      if (!obj) continue;
      const { h, col } = tiles[i];
      const p = Math.min(Math.max((t - col * STAGGER) / RISE, 0), 1);
      const e = 1 - (1 - p) ** 3;
      const hh = Math.max(h * e, 0.002);
      // 几何体挤出轴是局部 Z（实例绕 X 转了 -90°，局部 Z 即世界 Y 高度）
      obj.scale.set(1, 1, hh);
      obj.position.y = hh / 2;
    }
  });
  return null;
}

const UsageHeatmap3D: FC<{
  days: UsageStatsDay[];
  granularity: HeatGranularity;
}> = ({ days, granularity }) => {
  const weeks = useMemo(() => adaptiveWeeks(days), [days]);
  const grid = useMemo(
    () => buildHeatGrid(days, granularity, weeks),
    [days, granularity, weeks],
  );
  const [hover, setHover] = useState<HeatCell | null>(null);
  const dark = useHtmlDark();

  const width = grid.cols * SPACING;
  const depth = ROWS * SPACING;
  const halfW = width / 2;
  const halfD = depth / 2;
  const fitDist = Math.max(10, width * 0.6);

  const tiles = useMemo<Tile[]>(
    () =>
      grid.cells.map((c) => ({
        ...c,
        x: c.col * SPACING - halfW + SPACING / 2,
        z: c.row * SPACING - halfD + SPACING / 2,
        h: c.ratio > 0 ? ACTIVE_BASE + c.ratio * ACTIVE_RISE : INACTIVE_H,
      })),
    [grid, halfW, halfD],
  );

  // 相机按实际最高瓦片拟合（数据少时不必为理论最大值留白）
  const maxTileH = useMemo(
    () => tiles.reduce((m, t) => Math.max(m, t.h), INACTIVE_H),
    [tiles],
  );

  const refs = useRef<(Group | null)[]>([]);
  // ssr:false 保证客户端渲染；初值即挂载时刻，避免首帧在 effect 前跑完动画
  const start = useRef(performance.now() / 1000);
  useEffect(() => {
    start.current = performance.now() / 1000;
  }, [grid]);

  const emptyColor = dark ? "#2b2b33" : "#e8e8ee";

  return (
    <div className="h-80 w-full">
      <Canvas camera={{ fov: FOV }} dpr={[1, 2]}>
        <CameraRig width={width} depth={depth} maxH={maxTileH} />
        <ambientLight intensity={1.0} />
        <directionalLight position={[6, 12, 8]} intensity={1.1} />
        <TilesAnimator tiles={tiles} refs={refs} start={start} />
        <Instances range={tiles.length} limit={tiles.length}>
          <RoundedBoxGeometry
            args={[TILE, TILE, 1]}
            radius={TILE_RADIUS}
            smoothness={4}
            bevelSegments={3}
          />
          <meshStandardMaterial roughness={0.5} />
          {tiles.map((tile, i) => {
            const base = tile.ratio > 0 ? heatColor(tile.ratio) : emptyColor;
            return (
              <Instance
                key={tile.date}
                ref={(o) => {
                  // drei 的 Instance ref 类型声明解析为 unknown，运行时即 PositionMesh（Group 子类）
                  refs.current[i] = o as Group | null;
                }}
                position={[tile.x, 0.001, tile.z]}
                rotation={[-Math.PI / 2, 0, 0]}
                scale={[1, 1, 0.002]}
                color={hover?.date === tile.date ? lighten(base, 0.4) : base}
                onPointerOver={(e) => {
                  e.stopPropagation();
                  setHover(tile);
                }}
                onPointerOut={() =>
                  setHover((cur) => (cur?.date === tile.date ? null : cur))
                }
              />
            );
          })}
        </Instances>
        {hover && (
          <Html
            position={[
              hover.col * SPACING - halfW + SPACING / 2,
              (hover.ratio > 0
                ? ACTIVE_BASE + hover.ratio * ACTIVE_RISE
                : INACTIVE_H) + 0.35,
              hover.row * SPACING - halfD + SPACING / 2,
            ]}
            center
            zIndexRange={[40, 0]}
            style={{ pointerEvents: "none" }}
          >
            <div className="bg-popover text-popover-foreground w-max rounded-lg border px-3 py-1.5 text-xs shadow-md">
              <div className="font-medium">{formatDateCN(hover.date)}</div>
              <div className="text-muted-foreground">
                {formatTokens(hover.tokens)} tokens · {hover.messages} 轮消息
              </div>
            </div>
          </Html>
        )}
        <OrbitControls
          enablePan={false}
          minDistance={fitDist * 0.4}
          maxDistance={fitDist * 1.8}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, 0.3, 0]}
        />
      </Canvas>
    </div>
  );
};

const formatDateCN = (date: string): string => {
  const [y, m, d] = date.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
};

export default UsageHeatmap3D;
