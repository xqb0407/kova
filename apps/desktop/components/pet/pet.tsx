"use client";

/**
 * **桌宠统一入口** —— 吃一份 `pet.json` 清单（对象或 URL），按清单自动落三种渲染通道：
 *
 * - **atlas**：Codex 契约雪碧图（`spritesheet` / `spritesheetPath`），`useSpritePlayer`
 *   逐帧推进，支持逐帧时长、一次性动作末帧停留、v2 视线格（idle 追鼠标）；
 * - **animated**：APNG / 动图 WebP（motions 值写资源路径），`<img>` 原生播放；
 *   循环态专用——没有一次性语义（重播 = 换 revision 重挂 src 重头播）；
 * - **static**：单帧图片兜底。
 *
 * 动作来源是 `lib/pet/motion` 状态机（声明 prop + 命令面 ref，优先级与收尾规则见其文件头）。
 * 拖拽（`dragging`）在图集上没有专门的「被拽起」行，渲染层映射到 moving-left/right。
 *
 * ```tsx
 * const ref = useRef<PetRef>(null)
 * <Pet ref={ref} manifest="/pet-fixtures/pet.json" size={192} motion="working" />
 * ref.current?.motion({ type: "waving", replay: true })
 * ```
 *
 * 组件只负责画与动作；定位（fixed 悬浮）、拖拽实现、宿主接线（agent 状态 → motion）
 * 都是宿主的事。
 */

import * as React from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from "react";
import type { PetManifest, PetMotion, PetMotionInput, PetRef, ResolvedPet } from "@/lib/pet/types";
import {
  PET_ATLAS_COLUMNS,
  PET_DEFAULT_SIZE,
  PET_FRAME_HEIGHT,
  PET_FRAME_WIDTH,
  PET_LOOK_DEADZONE,
  PET_LOOK_RADIUS_FACTOR,
  lookIndexFor,
  lookSupported,
} from "@/lib/pet/atlas";
import { clipForMotion, resolvePetManifest, resolvePetUrl } from "@/lib/pet/manifest";
import { fetchPetBase64, fetchPetJson } from "@/lib/pet/fetch-manifest";
import { usePetMotion } from "./use-pet-motion";
import { useReducedMotion } from "./use-reduced-motion";
import { useSpritePlayer } from "./use-sprite-player";

/** 图集缺省几何（与契约一致），清单未就绪时保持布局稳定。 */
const DEFAULT_GEOMETRY = {
  columns: PET_ATLAS_COLUMNS,
  rows: 9,
  frameWidth: PET_FRAME_WIDTH,
  frameHeight: PET_FRAME_HEIGHT,
} as const;

export interface PetProps {
  /** 清单：对象，或 pet.json 地址（清单内相对资源按该地址目录解析） */
  manifest: PetManifest | string;
  /** 相对资源基址（对象清单时用它拼 motions 里的相对路径） */
  baseUrl?: string;
  /** 显示宽度 px；高度按图集格宽高比推。缺省 `PET_DEFAULT_SIZE` */
  size?: number;
  /** 声明式动作（回落层，见 `lib/pet/motion`） */
  motion?: PetMotionInput;
  /** 手势态：true=拖拽（方向未知，落向右行）；"left"/"right"=带方向的拖拽 */
  dragging?: boolean | "left" | "right" | "up" | "down";
  mirrored?: boolean;
  hidden?: boolean;
  /** v2 图集 idle 时追视鼠标（默认开；v1 图集自动无效） */
  lookAtPointer?: boolean;
  /** 视线死区 px（默认 24） */
  lookDeadzone?: number;
  /** 视线作用半径系数（默认 1.25，超出回待机帧） */
  lookRadiusFactor?: number;
  /** 单击插播 waving（拖拽中/清单没有 waving 时跳过；默认开） */
  clickWaving?: boolean;
  className?: string;
  style?: CSSProperties;
  /** 身体命中框 ref（点击/指针事件都落在这里，透明像素不响应） */
  hitboxRef?: Ref<HTMLDivElement>;
  onHitboxPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  onHitboxPointerMove?: React.PointerEventHandler<HTMLDivElement>;
  onHitboxPointerUp?: React.PointerEventHandler<HTMLDivElement>;
  onHitboxPointerCancel?: React.PointerEventHandler<HTMLDivElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onMotionChange?: (motion: PetMotion) => void;
  /** 命令面：`motion / clear / current` */
  ref?: Ref<PetRef | null>;
}

/** 清单来源解析：对象同步归一化；URL 拉取后归一化（陈旧响应丢弃）。 */

function useResolvedPet(
  source: PetManifest | string,
  baseUrl: string | undefined,
  onError: ((error: Error) => void) | undefined,
): ResolvedPet | null {
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const [remote, setRemote] = React.useState<ResolvedPet | null>(null);

  const inlineResult = React.useMemo(
    () => (typeof source === "string" ? null : resolvePetManifest(source, baseUrl)),
    [source, baseUrl],
  );

  React.useEffect(() => {
    if (inlineResult !== null && !inlineResult.ok) {
      onErrorRef.current?.(new Error(`桌宠清单无效：${inlineResult.error}`));
    }
  }, [inlineResult]);

  const isUrl = typeof source === "string";
  React.useEffect(() => {
    if (!isUrl) return undefined;
    let cancelled = false;
    const base = baseUrl ?? source.replace(/[^/]*$/, "");
    // fetchPetJson：fetch 优先，kova://pet/ 失败（典型是 dev http 页面被 Chromium
    // 拦自定义协议）回落桥读并标记 viaBridge——此时图集地址同样加载不了，要把
    // 图集也走桥并内嵌成 data URL。生产（kova://app 同源）走不到兜底。
    fetchPetJson(source)
      .then(async ({ json, viaBridge }) => {
        if (!viaBridge) {
          const r = resolvePetManifest(json, base);
          if (!r.ok) throw new Error(`桌宠清单无效：${r.error}`);
          if (!cancelled) setRemote(r.pet);
          return;
        }
        const m = json as PetManifest;
        const sheetRel = typeof m.spritesheet === "string"
          ? m.spritesheet
          : typeof m.spritesheetPath === "string"
            ? m.spritesheetPath
            : "spritesheet.webp";
        const asset = await fetchPetBase64(resolvePetUrl(sheetRel, base));
        const r = resolvePetManifest(
          { ...m, spritesheet: `data:${asset.mime};base64,${asset.base64}`, spritesheetPath: undefined },
          undefined,
        );
        if (!r.ok) throw new Error(`桌宠清单无效：${r.error}`);
        if (!cancelled) setRemote(r.pet);
      })
      .catch((err: unknown) => {
        if (!cancelled) onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
      setRemote(null);
    };
  }, [baseUrl, isUrl, source]);

  return isUrl ? remote : (inlineResult !== null && inlineResult.ok ? inlineResult.pet : null);
}

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function Pet(props: PetProps) {
  const {
    manifest,
    baseUrl,
    size,
    motion,
    dragging = false,
    mirrored,
    hidden,
    lookAtPointer = true,
    lookDeadzone = PET_LOOK_DEADZONE,
    lookRadiusFactor = PET_LOOK_RADIUS_FACTOR,
    clickWaving = true,
    className,
    style,
    hitboxRef,
    onHitboxPointerDown,
    onHitboxPointerMove,
    onHitboxPointerUp,
    onHitboxPointerCancel,
    onDoubleClick,
    onContextMenu,
    onReady,
    onError,
    onMotionChange,
    ref,
  } = props;

  const pet = useResolvedPet(manifest, baseUrl, onError);
  const reducedMotion = useReducedMotion();
  // 手势态归一（布尔 + 方向）：状态机只吃布尔，渲染映射另用方向
  const isDragging = typeof dragging === "string" || dragging === true;
  const { machine, state } = usePetMotion({ motion, dragging: isDragging, ref, onMotionChange });

  /* --------------------------------- 几何与动作 -------------------------------- */

  const geometry = pet?.geometry ?? DEFAULT_GEOMETRY;
  const width = Math.max(16, size ?? PET_DEFAULT_SIZE);
  const height = width * (geometry.frameHeight / geometry.frameWidth);

  // 拖拽渲染映射：图集没有拖拽行，落到左右行走行——
  // 方向由宿主显式给出（dragging: "left"/"right"）时优先，否则沿用动作/缺省向右
  const renderMotion: PetMotion = !isDragging
    ? state.type
    : dragging === "left"
      ? "moving-left"
      : dragging === "right"
        ? "moving-right"
        : dragging === "up" || dragging === "down"
          ? "jumping"
          : state.type === "moving-left" || state.type === "moving-right"
            ? state.type
            : "moving-right";

  const clip = React.useMemo(
    () => (pet === null ? null : clipForMotion(pet, renderMotion)),
    [pet, renderMotion],
  );

  /* ------------------------------- v2 视线追踪（look） ------------------------------ */

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [lookIndex, setLookIndex] = React.useState<number | undefined>(undefined);

  const lookEnabled = lookAtPointer
    && !reducedMotion
    && !dragging
    && pet?.geometry != null
    && lookSupported(pet.geometry)
    && state.type === "idle"
    && state.loop;
  const lookEnabledRef = React.useRef(lookEnabled);
  lookEnabledRef.current = lookEnabled;
  const lookDeadzoneRef = React.useRef(lookDeadzone);
  lookDeadzoneRef.current = lookDeadzone;
  const lookRadiusRef = React.useRef(lookRadiusFactor);
  lookRadiusRef.current = lookRadiusFactor;

  React.useEffect(() => {
    const clear = () => {
      setLookIndex(undefined);
    };
    const onMove = (event: PointerEvent) => {
      if (!lookEnabledRef.current) return;
      const element = containerRef.current;
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      const offset = {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2),
      };
      // 作用半径：指针离宠物太远直接回待机帧，否则会停在 look 格上不再回 idle
      const radius = Math.max(rect.width, rect.height) * lookRadiusRef.current;
      if (Math.hypot(offset.x, offset.y) > radius) {
        setLookIndex(undefined);
        return;
      }
      setLookIndex(lookIndexFor(offset, lookDeadzoneRef.current));
    };
    const onOut = (event: PointerEvent) => {
      // 指针离开整窗（relatedTarget 为空）后不会再有 pointermove，主动清防止定格
      if (event.relatedTarget === null) clear();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerout", onOut, { passive: true });
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onOut);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // 追视不可用的场合（v1 图集 / 非 idle / 减少动效）直接忽略 look，无需回 effect 清状态
  const effectiveLookIndex = lookEnabled ? lookIndex : undefined;

  /* ---------------------------------- 帧播放 --------------------------------- */

  const spriteRef = React.useRef<HTMLDivElement | null>(null);
  const atlasClip = clip !== null && clip.kind === "atlas" ? clip : null;
  useSpritePlayer({
    elementRef: spriteRef,
    clip: atlasClip,
    columns: geometry.columns,
    rows: geometry.rows,
    revision: state.revision,
    reducedMotion,
    lookIndex: effectiveLookIndex,
    onFinish: () => {
      machine.finish();
    },
  });

  /* ------------------------------- 图集加载探测 ------------------------------- */

  const onReadyRef = React.useRef(onReady);
  onReadyRef.current = onReady;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const spritesheetUrl = pet?.spritesheetUrl ?? null;

  React.useEffect(() => {
    // 图集是普通图片：用一次性 Image 探测上报加载成败，不额外挂可见元素
    if (spritesheetUrl === null) return undefined;
    const image = new Image();
    const handleLoad = () => {
      onReadyRef.current?.();
    };
    const handleError = () => {
      onErrorRef.current?.(new Error(`桌宠图集加载失败：${spritesheetUrl}`));
    };
    image.addEventListener("load", handleLoad);
    image.addEventListener("error", handleError);
    image.src = spritesheetUrl;
    return () => {
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
    };
  }, [spritesheetUrl]);

  /* --------------------------------- 点击回应 --------------------------------- */

  const onClick = () => {
    // 拖拽中的 pointerup 不算点击；清单没有 waving 也不插播
    if (!clickWaving || dragging || pet === null || pet.clips.waving === undefined) return;
    machine.request({ type: "waving", replay: true });
  };

  /* ---------------------------------- 渲染 ---------------------------------- */

  const rootStyle: CSSProperties = {
    position: "relative",
    width: `${width}px`,
    height: `${height}px`,
    display: hidden ? "none" : undefined,
    ...style,
  };
  const mediaStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    transform: mirrored ? "scaleX(-1)" : undefined,
  };

  return (
    <div
      ref={containerRef}
      className={joinClassNames("kova-pet", hidden && "kova-pet--hidden", className)}
      data-motion={renderMotion}
      data-clip={clip?.kind ?? "none"}
      style={rootStyle}
    >
      {clip?.kind === "atlas" ? (
        <div className="kova-pet__visual" style={mediaStyle}>
          <div
            ref={spriteRef}
            className="kova-pet__sprite"
            style={{
              width: "100%",
              height: "100%",
              backgroundImage: `url("${clip.src}")`,
              backgroundSize: `${geometry.columns * 100}% ${geometry.rows * 100}%`,
              backgroundRepeat: "no-repeat",
            }}
          />
        </div>
      ) : clip !== null ? (
        // animated：key = revision，replay 时重挂 src 让 APNG/动图 WebP 从头播；
        // static：key 恒定，不参与重播
        <img
          key={clip.kind === "animated" ? state.revision : "static"}
          className="kova-pet__img"
          src={clip.src}
          alt=""
          draggable={false}
          style={{ ...mediaStyle, objectFit: "contain" }}
        />
      ) : null}
      <div
        ref={hitboxRef}
        className="kova-pet__hitbox"
        style={{ position: "absolute", left: "25%", top: "10%", width: "50%", height: "85%" }}
        onClick={onClick}
        onPointerDown={onHitboxPointerDown}
        onPointerMove={onHitboxPointerMove}
        onPointerUp={onHitboxPointerUp}
        onPointerCancel={onHitboxPointerCancel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}
