"use client";

/**
 * 桌宠模块的浏览器侧预览页（对齐 dev-preview 其它页：URL 直达，不接桌面桥）。
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/pet
 *
 * 三块各验一件事：
 *  ① **图集全链路**：canvas 现场画一只 8×9 雪碧图（data URL，不依赖任何素材文件），
 *     走 Codex 契约默认行表——验证逐帧时长、一次性动作末帧停留回落、拖拽映射、
 *     命令面插播与声明层回落；
 *  ② **动图通道**：`public/pet-fixtures/` 下的 APNG / 动图 WebP fixture（脚本生成，
 *     见 scripts/generate-pet-fixtures.py），`<img>` 原生播放 + replay 重挂 src；
 *  ③ **外部清单**：贴任意 pet.json 地址（如 GitHub raw 上的 Codex 官方包）直接加载，
 *     验证 spritesheetPath 兼容与资源解析。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PetWidget } from "@/components/pet/pet-widget";
import type { PetMotion, PetRef } from "@/lib/pet/types";
import { PET_MOTIONS } from "@/lib/pet/types";
import { ATLAS_ROWS } from "@/lib/pet/atlas";

/** dev 用模拟事件总线：按钮手动 emit，走与生产完全相同的 PetWidget 事件链。 */
function makeEventBus() {
  const subs = new Set<(frame: { name: string; threadId?: string }) => void>();
  return {
    subscribe: (cb: (frame: { name: string; threadId?: string }) => void) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    emit: (frame: { name: string; threadId?: string }) => {
      for (const sub of subs) sub(frame);
    },
  };
}

const SIM_EVENTS = [
  ["agent.turn.completed", "任务完成"],
  ["agent.turn.error", "运行出错"],
  ["agent.approval.pending", "等审批"],
  ["agent.question.pending", "等回答"],
  ["automation.task.completed", "定时完成"],
  ["automation.task.failed", "定时失败"],
] as const;

/* -------------------------------------------------------------------------- */
/* ① canvas 现造 8×9 图集                                                       */
/* -------------------------------------------------------------------------- */

/** 单帧姿势参数（刻意保持玩具级：验的是管线不是美术）。 */
interface Pose {
  bodyY?: number;
  bodyX?: number;
  squashX?: number;
  squashY?: number;
  lean?: number;
  legPhase?: number;
  arm?: "none" | "right-up" | "both-front";
  eyeDirX?: number;
  eyeSquint?: number;
  tear?: boolean;
  mouth?: "smile" | "flat" | "sad";
}

const CELL_W = 192;
const CELL_H = 208;
const GROUND_Y = 186;

function drawCell(ctx: CanvasRenderingContext2D, col: number, row: number, pose: Pose): void {
  const x0 = col * CELL_W;
  const y0 = row * CELL_H;
  const cx = x0 + CELL_W / 2 + (pose.bodyX ?? 0);
  const squashX = pose.squashX ?? 1;
  const squashY = pose.squashY ?? 1;
  const bodyW = 96 * squashX;
  const bodyH = 116 * squashY;
  const cy = y0 + GROUND_Y - bodyH / 2 + (pose.bodyY ?? 0);
  const lean = pose.lean ?? 0;

  // 腿脚：跑步相位左右交替；其余并拢
  const legSpread = 22;
  const legLift = pose.legPhase === undefined ? 0 : Math.sin(pose.legPhase * Math.PI * 2);
  ctx.fillStyle = "#7c4a12";
  ctx.beginPath();
  ctx.ellipse(cx - legSpread + legLift * 8, y0 + GROUND_Y - Math.max(0, legLift) * 10, 14, 9, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + legSpread - legLift * 8, y0 + GROUND_Y - Math.max(0, -legLift) * 10, 14, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // 身体：橙色圆豆，随 lean 倾斜
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(lean * 0.35);
  ctx.fillStyle = "#f6a821";
  ctx.strokeStyle = "#8a5a10";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyW / 2, bodyH / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 手臂
  ctx.fillStyle = "#e08f12";
  if (pose.arm === "right-up") {
    ctx.beginPath();
    ctx.ellipse(bodyW / 2 - 6, -bodyH / 2 - 14, 13, 20, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-bodyW / 2 + 8, 14, 12, 18, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (pose.arm === "both-front") {
    ctx.beginPath();
    ctx.ellipse(-16, 18, 12, 16, 0.2, 0, Math.PI * 2);
    ctx.ellipse(16, 18, 12, 16, -0.2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(-bodyW / 2 + 6, 12, 12, 18, 0.25, 0, Math.PI * 2);
    ctx.ellipse(bodyW / 2 - 6, 12, 12, 18, -0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  // 眼睛（眼距 26，眼白 + 随 eyeDirX 偏移的瞳孔；eyeSquint 压扁）
  const squint = pose.eyeSquint ?? 0;
  const eyeH = 16 * (1 - squint * 0.85);
  const eyeY = -18;
  for (const side of [-1, 1]) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(side * 26, eyeY, 11, Math.max(2.5, eyeH), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222222";
    ctx.beginPath();
    ctx.ellipse(side * 26 + (pose.eyeDirX ?? 0), eyeY, 5, Math.max(2, eyeH * 0.55), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 嘴
  ctx.strokeStyle = "#5c3a08";
  ctx.lineWidth = 4;
  ctx.beginPath();
  const mouthY = 14;
  if (pose.mouth === "sad") {
    ctx.arc(0, mouthY + 10, 14, Math.PI * 1.15, Math.PI * 1.85);
  } else if (pose.mouth === "flat") {
    ctx.moveTo(-10, mouthY);
    ctx.lineTo(10, mouthY);
  } else {
    ctx.arc(0, mouthY - 6, 14, Math.PI * 0.15, Math.PI * 0.85);
  }
  ctx.stroke();
  ctx.restore();

  // failed 的眼泪：挂在左眼下，硬边小圆
  if (pose.tear) {
    ctx.fillStyle = "#4aa3ff";
    ctx.beginPath();
    ctx.arc(x0 + CELL_W / 2 - 28, y0 + GROUND_Y - 74, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 每行动作的逐帧姿势表（帧数与 `ATLAS_ROWS` 的契约一致）。 */
function poseFor(motion: PetMotion, i: number): Pose {
  const wave = Math.sin(((i + 0.5) / (ATLAS_ROWS.waving.frames)) * Math.PI * 2);
  switch (motion) {
    case "idle": {
      const bob = Math.sin((i / ATLAS_ROWS.idle.frames) * Math.PI * 2) * 5;
      return { bodyY: bob, eyeSquint: i === 3 ? 0.9 : 0, mouth: "smile" };
    }
    case "moving-right":
      return { lean: 0.55, bodyY: -Math.abs(Math.sin((i / 8) * Math.PI * 2)) * 8, legPhase: i / 8, eyeDirX: 2, mouth: "smile" };
    case "moving-left":
      return { lean: -0.55, bodyY: -Math.abs(Math.sin((i / 8) * Math.PI * 2)) * 8, legPhase: i / 8, eyeDirX: -2, mouth: "smile" };
    case "waving":
      return { arm: "right-up", bodyY: -3, bodyX: wave * 3, eyeDirX: 2, mouth: "smile" };
    case "jumping": {
      // 蹲 → 蹬 → 空中 → 下落 → 落地压扁
      const table: Pose[] = [
        { squashY: 0.82, squashX: 1.12, bodyY: 10 },
        { squashY: 1.1, squashX: 0.92, bodyY: -34, legPhase: 0.25 },
        { squashY: 1.04, squashX: 0.96, bodyY: -52, legPhase: 0.25 },
        { squashY: 1.02, squashX: 0.98, bodyY: -18 },
        { squashY: 0.86, squashX: 1.1, bodyY: 12 },
      ];
      return table[i] ?? {};
    }
    case "failed":
      return {
        lean: 0.2 + i * 0.04,
        bodyY: 6 + i,
        eyeSquint: 0.6,
        eyeDirX: -1,
        tear: i >= 3,
        mouth: "sad",
      };
    case "waiting": {
      // 左右张望 + 踏脚
      const look = [(-2), 0, 2, 2, 0, (-2)][i % 6] ?? 0;
      return { bodyY: i % 2 === 0 ? -3 : 0, legPhase: i % 2 === 0 ? 0.25 : undefined, eyeDirX: look, mouth: "flat" };
    }
    case "working":
      return { bodyX: (i % 2 === 0 ? 1 : -1) * 2.5, arm: "both-front", eyeSquint: 0.35, eyeDirX: 0, mouth: "flat" };
    case "review":
      return { lean: 0.28, bodyY: 4, eyeSquint: 0.5, eyeDirX: ((i % 6) - 2.5) * 1.2, mouth: "flat" };
  }
}

/** 行号 → 动作（按 `ATLAS_ROWS` 的契约行序反查；`PET_MOTIONS` 的排列不是行序）。 */
const ROW_TO_MOTION = (Object.entries(ATLAS_ROWS) as [PetMotion, { row: number }][])
  .sort((a, b) => a[1].row - b[1].row)
  .map(([motion]) => motion);

/** 现场画 8×9 图集并导出 data URL（PNG 带透明）。 */
function buildAtlasDataUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W * 8;
  canvas.height = CELL_H * 9;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  for (let row = 0; row < 9; row++) {
    const motion = ROW_TO_MOTION[row]!;
    const frames = ATLAS_ROWS[motion].frames;
    for (let col = 0; col < frames; col++) {
      drawCell(ctx, col, row, poseFor(motion, col));
    }
  }
  return canvas.toDataURL("image/png");
}

/* -------------------------------------------------------------------------- */
/* 页面                                                                         */
/* -------------------------------------------------------------------------- */

const MOTION_LABELS: Record<PetMotion, string> = {
  "idle": "待机 idle",
  "working": "工作中 working",
  "waiting": "等待授权 waiting",
  "review": "审查 review",
  "failed": "失败 failed",
  "waving": "挥手 waving",
  "jumping": "跳跃 jumping",
  "moving-left": "左走 moving-left",
  "moving-right": "右走 moving-right",
};

export default function PetPreviewPage() {
  /* ① 图集演示：用 canvas 现画的方块豆（v1 契约），零外部素材依赖 */
  const [atlasSource, setAtlasSource] = useState<"blob">("blob");
  const [atlasUrl, setAtlasUrl] = useState("");
  const petRef = useRef<PetRef | null>(null);
  const [atlasError, setAtlasError] = useState<string | null>(null);
  const [currentMotion, setCurrentMotion] = useState<PetMotion>("idle");
  const simBus = useMemo(makeEventBus, []);

  useEffect(() => {
    setAtlasUrl(buildAtlasDataUrl());
  }, []);

  const atlasManifest = useMemo<
    string | { id: string; displayName: string; spritesheet: string } | null
  >(() => {
    return atlasUrl === "" ? null : { id: "blob-demo", displayName: "方块豆（现画图集）", spritesheet: atlasUrl };
  }, [atlasSource, atlasUrl]);

  /* 拖拽演示：最简单的指针拖动，把 dragging 喂给组件 */
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const onDragPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = { px: event.clientX, py: event.clientY, ox: pos.x, oy: pos.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pos]);
  const onDragPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    setPos({ x: start.ox + event.clientX - start.px, y: start.oy + event.clientY - start.py });
  }, []);
  const onDragPointerEnd = useCallback(() => {
    dragStartRef.current = null;
    setDragging(false);
  }, []);

  /* ② 动图 fixture 演示 */
  const [animatedError, setAnimatedError] = useState<string | null>(null);
  const animatedManifest = useMemo(
    () => ({
      id: "fixture-demo",
      displayName: "Fixture 动图",
      motions: { idle: "/pet-fixtures/boil.apng", working: "/pet-fixtures/bounce.webp" },
    }),
    [],
  );

  /* ③ 外部清单 / 动图 URL */
  const [manifestUrl, setManifestUrl] = useState("");
  const [loadedManifestUrl, setLoadedManifestUrl] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);

  const externalImageManifest = useMemo(
    () => (loadedImageUrl === null ? null : { id: "img-demo", motions: { idle: loadedImageUrl } }),
    [loadedImageUrl],
  );

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", display: "grid", gap: 28, maxWidth: 980 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>桌宠模块预览（/dev-preview/pet）</h1>

      {/* ① 图集 */}
      <section style={{ display: "grid", gap: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>
          ① 图集全链路（动作切换 / 一次性回落 / 拖拽映射 / v2 视线追踪）
        </h2>
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [["blob", "方块豆（canvas 现画 v1，9 行）"]] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setAtlasError(null);
                setAtlasSource(key);
              }}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                cursor: "pointer",
                fontWeight: atlasSource === key ? 700 : 400,
                borderColor: atlasSource === key ? "#f6a821" : undefined,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          style={{ position: "relative", height: 300, border: "1px dashed #bbb", borderRadius: 12, overflow: "hidden" }}
        >
          {atlasManifest === null ? (
            <p style={{ padding: 12, color: "#888" }}>正在现场生成图集…</p>
          ) : (
            <div
              style={{ position: "absolute", left: pos.x, top: pos.y, touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
              onPointerDown={onDragPointerDown}
              onPointerMove={onDragPointerMove}
              onPointerUp={onDragPointerEnd}
              onPointerCancel={onDragPointerEnd}
            >
              <PetWidget
                ref={petRef}
                variant="inline"
                manifest={atlasManifest}
                size={170}
                dragging={dragging}
                subscribeEvents={simBus.subscribe}
                onError={(error) => {
                  setAtlasError(error.message);
                }}
                onMotionChange={setCurrentMotion}
              />
            </div>
          )}
          <div
            style={{
              position: "absolute",
              right: 12,
              top: 12,
              fontSize: 12,
              color: "#555",
              background: "rgba(255,255,255,.8)",
              padding: "4px 8px",
              borderRadius: 8,
            }}
          >
            当前动作：{MOTION_LABELS[currentMotion]}
            {dragging ? "（拖拽 → moving-right）" : ""}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {PET_MOTIONS.map((m) => (
            <button
              key={m}
              onClick={() => {
                petRef.current?.motion({ type: m, replay: true });
              }}
              style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
            >
              {MOTION_LABELS[m]}
            </button>
          ))}
          <button
            onClick={() => {
              petRef.current?.clear();
            }}
            style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
          >
            clear（回落声明层）
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#888" }}>模拟事件（动作+气泡，走生产同款链路）：</span>
          {SIM_EVENTS.map(([name, label]) => (
            <button
              key={name}
              onClick={() => {
                simBus.emit({ name, threadId: "demo-thread" });
              }}
              style={{ padding: "4px 10px", fontSize: 12, cursor: "pointer", borderColor: "#7f9634" }}
            >
              {label}
            </button>
          ))}
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "#888" }}>
          单击宠物身体会插播一次 waving 再回落；waving / jumping / failed / review
          是一次性动作（末帧停留后自动回落）；拖拽按方向落到左右行走行。
          方块豆是 v1 图集（9 行）没有视线格；放一只 v2 宠物（含 16 格视线）进宠物目录即可在设置页预览转头效果。
          {atlasError !== null && <span style={{ color: "#c00" }}> 错误：{atlasError}</span>}
        </p>
      </section>

      {/* ② 动图 fixture */}
      <section style={{ display: "grid", gap: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>② 动图通道（APNG / 动图 WebP，&lt;img&gt; 原生播放）</h2>
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ display: "grid", justifyItems: "center", gap: 4 }}>
            <PetWidget variant="inline" manifest={animatedManifest} size={110} motion="idle" subscribeEvents={simBus.subscribe} onError={(error: Error) => setAnimatedError(error.message)} />
            <code style={{ fontSize: 11 }}>idle → boil.apng</code>
          </div>
          <div style={{ display: "grid", justifyItems: "center", gap: 4 }}>
            <PetWidget variant="inline" manifest={animatedManifest} size={110} motion="working" subscribeEvents={simBus.subscribe} onError={() => {}} />
            <code style={{ fontSize: 11 }}>working → bounce.webp</code>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: "#888" }}>
          fixture 由 scripts/generate-pet-fixtures.py 生成到 public/pet-fixtures/。
          动图形态只有循环语义（replay = 重挂 src 从头播）；一次性动作只有图集形态有。
          {animatedError !== null && <span style={{ color: "#c00" }}> 加载失败：{animatedError}（fixture 未生成时属预期）</span>}
        </p>
      </section>

      {/* ③ 外部清单与动图 URL */}
      <section style={{ display: "grid", gap: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>③ 外部清单（可直接吃 Codex 官方 pet.json）</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={manifestUrl}
            onChange={(event) => {
              setManifestUrl(event.target.value);
            }}
            placeholder="https://…/pet.json（清单内相对资源按其目录解析）"
            style={{ flex: 1, padding: "6px 10px", fontSize: 13 }}
          />
          <button
            onClick={() => {
              setExternalError(null);
              setLoadedManifestUrl(manifestUrl.trim() === "" ? null : manifestUrl.trim());
            }}
            style={{ padding: "4px 12px", cursor: "pointer" }}
          >
            加载
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ width: 140, height: 160, border: "1px dashed #bbb", borderRadius: 12, display: "grid", placeItems: "center" }}>
            {loadedManifestUrl !== null && <PetWidget variant="inline" manifest={loadedManifestUrl} size={128} subscribeEvents={simBus.subscribe} onError={(error: Error) => setExternalError(error.message)} />}
          </div>
          <div style={{ width: 140, height: 160, border: "1px dashed #bbb", borderRadius: 12, display: "grid", placeItems: "center" }}>
            {externalImageManifest !== null && <PetWidget variant="inline" manifest={externalImageManifest} size={128} subscribeEvents={simBus.subscribe} onError={(error: Error) => setExternalError(error.message)} />}
          </div>
          <div style={{ display: "grid", gap: 6, flex: 1 }}>
            <input
              value={imageUrl}
              onChange={(event) => {
                setImageUrl(event.target.value);
              }}
              placeholder="任意 APNG / 动图 WebP / PNG 地址，喂给 idle"
              style={{ padding: "6px 10px", fontSize: 13 }}
            />
            <button
              onClick={() => {
                setExternalError(null);
                setLoadedImageUrl(imageUrl.trim() === "" ? null : imageUrl.trim());
              }}
              style={{ padding: "4px 12px", cursor: "pointer", justifySelf: "start" }}
            >
              喂动图
            </button>
          </div>
        </div>
        {externalError !== null && <p style={{ margin: 0, fontSize: 12, color: "#c00" }}>{externalError}</p>}
      </section>
    </div>
  );
}
