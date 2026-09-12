"use client";

import { useMemo, useState, type FC } from "react";
import { Canvas } from "@react-three/fiber";
import { Html, Instance, Instances, OrbitControls } from "@react-three/drei";
import { useHtmlDark } from "@/lib/use-html-dark";
import { formatTokens, type UsageStatsDay } from "@/lib/usage-stats";
import {
  buildHeatGrid,
  heatColor,
  type HeatCell,
  type HeatGranularity,
} from "./usage-heatmap";

/**
 * Token 活动热力图 3D 视图（three.js skyline）：每天一根挤出柱，高度与颜色
 * 随强度变化；OrbitControls 拖拽旋转/滚轮缩放。经 next/dynamic 按需加载
 * （three 全家桶不进设置页首屏包），导出 buildHeatGrid 与 2D 共用同一网格。
 */

const SPACING = 1.1;
const MAX_HEIGHT = 2.6;

const UsageHeatmap3D: FC<{
  days: UsageStatsDay[];
  granularity: HeatGranularity;
}> = ({ days, granularity }) => {
  const grid = useMemo(() => buildHeatGrid(days, granularity), [days, granularity]);
  const [hover, setHover] = useState<HeatCell | null>(null);
  const dark = useHtmlDark();
  const zeroColor = dark ? "#2b2b31" : "#e4e4e7";

  const colCenter = ((grid.cols - 1) * SPACING) / 2;
  const rowCenter = (6 * SPACING) / 2;
  const floorSize = Math.max(grid.cols, 10) * SPACING;

  return (
    <div className="h-80 w-full">
      <Canvas camera={{ position: [colCenter + 2, 10, 14], fov: 40 }} dpr={[1, 2]}>
        <ambientLight intensity={0.85} />
        <directionalLight position={[8, 14, 6]} intensity={1.5} />
        <group position={[-colCenter, 0, -rowCenter]}>
          <Instances range={grid.cells.length} limit={Math.max(grid.cells.length, 1)}>
            <boxGeometry args={[0.72, 1, 0.72]} />
            <meshStandardMaterial roughness={0.45} />
            {grid.cells.map((cell) => {
              const h = 0.05 + cell.ratio * MAX_HEIGHT;
              return (
                <Instance
                  key={cell.date}
                  position={[cell.col * SPACING, h / 2, cell.row * SPACING]}
                  scale={[1, h, 1]}
                  color={cell.ratio > 0 ? heatColor(cell.ratio) : zeroColor}
                  onPointerOver={(e) => {
                    e.stopPropagation();
                    setHover(cell);
                  }}
                  onPointerOut={() =>
                    setHover((cur) => (cur?.date === cell.date ? null : cur))
                  }
                />
              );
            })}
          </Instances>
          {hover && (
            <Html
              position={[
                hover.col * SPACING,
                0.05 + hover.ratio * MAX_HEIGHT + 0.45,
                hover.row * SPACING,
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
        </group>
        <gridHelper
          args={[floorSize, Math.round(floorSize / SPACING), "#88888855", "#88888830"]}
        />
        <OrbitControls
          enablePan={false}
          minDistance={6}
          maxDistance={36}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, 0.5, 0]}
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
