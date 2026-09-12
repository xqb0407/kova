"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import { Canvas, useThree } from "@react-three/fiber";
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
 * Token 活动热力图 3D 视图（three.js skyline，对齐参考风格的三个要点）：
 * 1. 只有活跃日有柱子，空白日以细线网格铺底（不铺灰色占位块）；
 * 2. 柱子紧密排列（间距的 ~92%），颜色即强度色带；
 * 3. 低角度略带侧转的相机（长条斜向贯穿画面），距离按视口宽高比精确拟合撑满横向。
 * 经 next/dynamic 按需加载（three 全家桶不进设置页首屏包），buildHeatGrid 与
 * 2D 共用同一网格。
 */

const SPACING = 0.85;
const MAX_HEIGHT = 2.6;
const ROWS = 7;
const FOV = 40;

/** 相机拟合：按视口宽高比算水平 FOV，场景宽度 92% 入框；低角度 + 侧转让长条斜向贯穿 */
function CameraRig({ width }: { width: number }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const aspect = Math.max(size.width / Math.max(size.height, 1), 0.5);
    const halfVFov = (FOV / 2) * (Math.PI / 180);
    const halfHFov = Math.atan(Math.tan(halfVFov) * aspect);
    const dist = width / 2 / Math.tan(halfHFov) / 0.92;
    camera.position.set(width * 0.1, dist * 0.34, dist * 0.9);
    camera.lookAt(0, 0.5, 0);
  }, [camera, size.width, size.height, width]);
  return null;
}

const UsageHeatmap3D: FC<{
  days: UsageStatsDay[];
  granularity: HeatGranularity;
}> = ({ days, granularity }) => {
  const grid = useMemo(() => buildHeatGrid(days, granularity), [days, granularity]);
  const [hover, setHover] = useState<HeatCell | null>(null);
  const dark = useHtmlDark();

  const width = grid.cols * SPACING;
  const depth = ROWS * SPACING;
  const halfW = width / 2;
  const halfD = depth / 2;
  const fitDist = Math.max(24, width * 0.55);

  // 只有活跃日出柱子（空白日交给底部线框网格）
  const activeCells = useMemo(
    () => grid.cells.filter((c) => c.ratio > 0),
    [grid],
  );

  // 底部线框网格：列边界 (cols+1) 条 + 行边界 8 条，铺出空白日的格子
  const floorLines = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= grid.cols; i += 1) {
      const x = i * SPACING - halfW;
      pts.push(x, 0, -halfD, x, 0, halfD);
    }
    for (let j = 0; j <= ROWS; j += 1) {
      const z = j * SPACING - halfD;
      pts.push(-halfW, 0, z, halfW, 0, z);
    }
    return new Float32Array(pts);
  }, [grid.cols, halfW, halfD]);

  const gridColor = dark ? "#2f2f36" : "#e0e0e4";

  return (
    <div className="h-72 w-full">
      <Canvas camera={{ fov: FOV }} dpr={[1, 2]}>
        <CameraRig width={width} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[8, 14, 6]} intensity={1.5} />
        {activeCells.length > 0 && (
          <Instances range={activeCells.length} limit={activeCells.length}>
            <boxGeometry args={[SPACING * 0.92, 1, SPACING * 0.92]} />
            <meshStandardMaterial roughness={0.45} />
            {activeCells.map((cell) => {
              const h = 0.08 + cell.ratio * MAX_HEIGHT;
              return (
                <Instance
                  key={cell.date}
                  position={[
                    cell.col * SPACING - halfW + SPACING / 2,
                    h / 2,
                    cell.row * SPACING - halfD + SPACING / 2,
                  ]}
                  scale={[1, h, 1]}
                  color={heatColor(cell.ratio)}
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
        )}
        {hover && (
          <Html
            position={[
              hover.col * SPACING - halfW + SPACING / 2,
              0.08 + hover.ratio * MAX_HEIGHT + 0.45,
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
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[floorLines, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={gridColor} />
        </lineSegments>
        <OrbitControls
          enablePan={false}
          minDistance={fitDist * 0.3}
          maxDistance={fitDist * 1.8}
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
