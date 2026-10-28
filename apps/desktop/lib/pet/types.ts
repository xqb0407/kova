/**
 * 桌宠模块 · 类型层。
 *
 * 三种资源形态统一成 clip 判别联合：
 * - `atlas`    —— 单张雪碧图集（Codex 契约：8 列、格 192×208、9 行 v1 / 11 行 v2），
 *                 逐帧时长可控，是唯一支持「一次性动作 + 末帧停留」的形态；
 * - `animated` —— 每个动作一张动图（APNG / 动图 WebP），`<img>` 原生播放，
 *                 循环态完美；没有一次性语义（重播 = 重挂 src 近似）；
 * - `static`   —— 单帧图片兜底（动图形态里给非动图扩展名的回落）。
 *
 * `kind: "video"` 是预留位：透明 webm/mov 已定不进 v1，manifest 解析层遇到视频
 * 扩展名会明确报错（见 `manifest.ts`），后续补 `video` clip 不动调用方。
 */

/** 动作词表（行语义对齐 Codex 图集，见 `atlas.ts` 的默认行表）。 */
export type PetMotion =
  | "idle"
  | "working"
  | "waiting"
  | "review"
  | "failed"
  | "waving"
  | "jumping"
  | "moving-left"
  | "moving-right";

/** 全部动作名（供遍历）。 */
export const PET_MOTIONS = [
  "idle",
  "working",
  "waiting",
  "review",
  "failed",
  "waving",
  "jumping",
  "moving-left",
  "moving-right",
] as const satisfies readonly PetMotion[];

/**
 * 动作下发：
 * - 字符串 = 动作名（循环语义由词表定）；
 * - 对象可覆盖循环语义，`replay: true` 强制从头重播（命令面有效，prop 里忽略）。
 */
export type PetMotionInput = PetMotion | {
  type: PetMotion;
  loop?: boolean;
  replay?: boolean;
};

/** 图集几何。缺省值即 Codex 契约（8 列 × 192×208）。 */
export interface PetAtlasGeometry {
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
}

/** 归一化后的可播放片段。 */
export type PetClip =
  | {
    kind: "atlas";
    src: string;
    /** 行号（0 起） */
    row: number;
    /** 帧数（列数） */
    frames: number;
    /** 每帧时长 ms（`durations` 缺项时的回落值） */
    interval: number;
    /** 逐帧时长 ms；第 N 项 = 第 N 帧停留时长，优先级高于 `interval` */
    durations?: number[];
    loop: boolean;
  }
  | { kind: "animated"; src: string; loop: boolean }
  | { kind: "static"; src: string };

/** 清单里单个动作的写法：
 * - 字符串 —— 资源相对路径（按扩展名分派 clip 形态）；
 * - 数字 —— 图集行号（其余参数用默认行表）；
 * - 对象 —— 图集行定义（`row` 必带）或动图（`src` 必带）的显式覆盖。
 */
export type PetMotionSpec =
  | string
  | number
  | {
    src?: string;
    row?: number;
    frames?: number;
    interval?: number;
    durations?: number[];
    loop?: boolean;
  };

/**
 * 清单（`pet.json`）：
 * - 我们的写法：`spritesheet` + 几何字段，`motions` 可整体省略（落默认行表）；
 * - Codex 官方包：`spritesheetPath` + `spriteVersionNumber`，原样识别，免改直接吃。
 */
export interface PetManifest {
  id?: string;
  displayName?: string;
  description?: string;
  /** 图集相对路径（我们的字段名） */
  spritesheet?: string;
  /** Codex 官方字段名，与 `spritesheet` 等价 */
  spritesheetPath?: string;
  /** Codex 官方字段：1 = 9 行，2 = 11 行（多 16 格视线） */
  spriteVersionNumber?: number;
  columns?: number;
  rows?: number;
  frameWidth?: number;
  frameHeight?: number;
  motions?: Partial<Record<PetMotion, PetMotionSpec>>;
}

/** `resolvePetManifest` 的产出：组件直接消费的归一化宠物。 */
export interface ResolvedPet {
  meta: Pick<PetManifest, "id" | "displayName" | "description">;
  /** 图集几何；纯动图宠物为 null */
  geometry: PetAtlasGeometry | null;
  /** 图集资源地址（相对 `baseUrl` 解析后）；无图集为 null */
  spritesheetUrl: string | null;
  /** 每个动作的可播放片段；缺失的动作由消费方回落 idle */
  clips: Partial<Record<PetMotion, PetClip>>;
}

/** 命令面（`<Pet ref>`）。 */
export interface PetRef {
  /** 插播/切换动作（优先于 motion prop，直到 prop 变化或一次性播完） */
  motion: (input: PetMotionInput) => void;
  /** 清掉命令面，回落 motion prop */
  clear: () => void;
  /** 当前生效动作 */
  readonly current: PetMotion;
}
