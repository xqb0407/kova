/**
 * 图片落盘的内存侧纯逻辑（无 RN / expo 依赖，便于单测）：
 * - 该不该落盘（动图跳过、超大跳过、端支持与否由调用方传入）
 * - 转录行扫描：找「还没落盘的内联工具图片」
 * - 回写：把某行的图片块换成 file:// 结果并**丢掉 data**
 * 依赖原生能力的部分在 image-materialize.ts（本文件被它 re-export）。
 */

/** 长边上限（pt@3x 的屏宽上限约 1300px，留一点余量） */
export const IMAGE_MAX_EDGE = 1600;
/** base64 字符数上限（≈18MB 二进制）：再大也不值得为展示解码，直接放弃 */
export const IMAGE_MAX_INPUT_CHARS = 24_000_000;

export type MaterializedImage = {
  uri: string;
  mimeType: string;
  width: number;
  height: number;
};

/** 重编码会丢帧的动图格式 */
const ANIMATED_MIME = new Set(["image/gif", "image/webp"]);

/** 是否值得落盘：动图跳过（丢帧）、空/超大跳过（解码成本不划算） */
export const shouldMaterializeImage = (
  dataBase64: string,
  mimeType: string,
  supported = true,
): boolean =>
  supported &&
  !ANIMATED_MIME.has(mimeType) &&
  dataBase64.length > 0 &&
  dataBase64.length <= IMAGE_MAX_INPUT_CHARS;

/** 长边降采样后的目标尺寸（宽高都已知时用；未知/无需缩放返回 null） */
export const fitWithinMaxEdge = (
  width: number,
  height: number,
  maxEdge: number = IMAGE_MAX_EDGE,
): { width: number; height: number } | null => {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= maxEdge || longest <= 0) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/* --------------------------- 转录行扫描 / 回写（纯逻辑，可单测） --------------------------- */

export type InlineImageTarget = {
  /** 行所在数组：本窗 / 分页旧页 */
  where: "messages" | "olderMessages";
  rowIndex: number;
  partIndex: number;
  data: string;
  mimeType: string;
};

type AnyRow = { role?: unknown; content?: unknown };

const rowImagePart = (row: unknown, partIndex: number) => {
  const parts = (row as AnyRow | null)?.content;
  if (!Array.isArray(parts)) return null;
  const part = parts[partIndex] as Record<string, unknown> | undefined;
  if (!part || part.type !== "image") return null;
  return part;
};

/**
 * 收集「还没落盘的内联工具图片」：toolResult 行里 type=image、有 data（base64）且
 * 尚无 uri 的块。用户消息里的图片**不碰**——那条链要留给编辑/重发读原 data。
 */
export function collectInlineToolImages(
  messages: readonly unknown[],
  olderMessages: readonly unknown[],
  limit: number,
): InlineImageTarget[] {
  const out: InlineImageTarget[] = [];
  const scan = (rows: readonly unknown[], where: InlineImageTarget["where"]) => {
    for (let rowIndex = 0; rowIndex < rows.length && out.length < limit; rowIndex++) {
      const row = rows[rowIndex] as AnyRow | null;
      if (!row || row.role !== "toolResult" || !Array.isArray(row.content)) continue;
      const parts = row.content as readonly Record<string, unknown>[];
      for (let partIndex = 0; partIndex < parts.length && out.length < limit; partIndex++) {
        const part = parts[partIndex];
        if (!part || part.type !== "image") continue;
        if (typeof part.uri === "string" && part.uri.length > 0) continue;
        const data = typeof part.data === "string" ? part.data : "";
        const mimeType = typeof part.mimeType === "string" ? part.mimeType : "";
        if (!data || !mimeType || !shouldMaterializeImage(data, mimeType)) continue;
        out.push({ where, rowIndex, partIndex, data, mimeType });
      }
    }
  };
  scan(messages, "messages");
  if (out.length < limit) scan(olderMessages, "olderMessages");
  return out;
}

/**
 * 把某一行的某个图片块替换成落盘结果（新行对象、新 content 数组；**丢掉 data**，
 * 这正是省内存的一刀）。形状不符或索引越界返回原数组引用（调用方据此跳过）。
 */
export function patchRowImage(
  rows: readonly unknown[],
  rowIndex: number,
  partIndex: number,
  patch: MaterializedImage,
): unknown[] | null {
  const row = rows[rowIndex] as (Record<string, unknown> & { content?: unknown }) | undefined;
  if (!row || !Array.isArray(row.content)) return null;
  const parts = row.content as readonly Record<string, unknown>[];
  const part = parts[partIndex];
  if (!part || part.type !== "image") return null;
  if (typeof part.uri === "string" && part.uri.length > 0) return null;
  const nextParts = parts.slice();
  const { data: _dropInlineData, ...rest } = part;
  nextParts[partIndex] = {
    ...rest,
    uri: patch.uri,
    mimeType: patch.mimeType,
    width: patch.width,
    height: patch.height,
  };
  const nextRows = rows.slice();
  nextRows[rowIndex] = { ...row, content: nextParts };
  return nextRows;
}

/** 行的图片块当前是否已落盘（供 UI 判断是否需要占位/角标） */
export const rowImagePartIsMaterialized = (row: unknown, partIndex: number): boolean =>
  typeof rowImagePart(row, partIndex)?.uri === "string";

/**
 * 把某行的图片 uri 摘掉（渲染层报过这个文件读不出来时用）：行回到"没有 uri"的状态，
 * 下一次快照把 base64 带回来时就会重新落盘成新文件。形状不符/没有 uri 返回 null。
 */
export function clearRowImageUri(
  rows: readonly unknown[],
  rowIndex: number,
  partIndex: number,
): unknown[] | null {
  const row = rows[rowIndex] as (Record<string, unknown> & { content?: unknown }) | undefined;
  if (!row || !Array.isArray(row.content)) return null;
  const parts = row.content as readonly Record<string, unknown>[];
  const part = parts[partIndex];
  if (!part || part.type !== "image" || typeof part.uri !== "string") return null;
  const nextParts = parts.slice();
  const { uri: _drop, width: _w, height: _h, ...rest } = part;
  nextParts[partIndex] = rest;
  const nextRows = rows.slice();
  nextRows[rowIndex] = { ...row, content: nextParts };
  return nextRows;
}

/** 行里所有「已落盘但被标记读不出来」的图片块位置（自愈扫描用） */
export function collectFailedImageParts(
  messages: readonly unknown[],
  olderMessages: readonly unknown[],
  isFailed: (uri: string) => boolean,
): { where: "messages" | "olderMessages"; rowIndex: number; partIndex: number; uri: string }[] {
  const out: { where: "messages" | "olderMessages"; rowIndex: number; partIndex: number; uri: string }[] = [];
  const scan = (rows: readonly unknown[], where: "messages" | "olderMessages") => {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex] as AnyRow | null;
      if (!row || !Array.isArray(row.content)) continue;
      const parts = row.content as readonly Record<string, unknown>[];
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        if (!part || part.type !== "image") continue;
        const uri = typeof part.uri === "string" ? part.uri : "";
        if (uri && isFailed(uri)) out.push({ where, rowIndex, partIndex, uri });
      }
    }
  };
  scan(messages, "messages");
  scan(olderMessages, "olderMessages");
  return out;
}
