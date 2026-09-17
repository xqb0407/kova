/**
 * 工具结果图片块的 UI 投影（设计：docs/image-part-design.md）。
 *
 * stream.ts（直播 chunk）与 transcript.ts（历史重建）共用的唯一事实源：
 * output 文本拼装、过滤降级占位、data-image part（id + data）全部在这里产出，
 * “直播 = 刷新后”的同构是构造性保证而非靠两处分头实现守约定。
 *
 * 闸门也单点在这里：单图 ≤2MiB + 栅格 MIME 白名单。越界的图只得到一行占位文本，
 * 上不了线——护住前端渲染与 Rust 重放缓冲（16MiB/run，见 pi_agent.rs）。
 * 注意投影只加 UI 通道，不改 agent 消息本体（模型上下文语义不动）。
 */
import type { PiImagePartData } from "./types";

/** part 名：chunk type `data-image`；前端 makeAssistantDataUI("image") 按名认领 */
export const IMAGE_PART_NAME = "image";

/**
 * 单图原始字节上限（≈2MiB，base64 后约 2.7MiB）。1080p PNG 截图常见 0.5–2MiB；
 * 更大的期望由工具侧出 JPEG/缩放图（文生图工具应按约定控制产出体量）。
 */
export const IMAGE_INLINE_MAX_BYTES = 2 * 1024 * 1024;

/** 允许投影的栅格格式；svg 整体挡掉（可含外链与可欺骗绘制的 UI，不值得那个面） */
const IMAGE_MIME_ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 工具结果 content 块（形状按需放宽：只关心 text/image 两类，其余透传占位语义） */
export type ProjectableContentBlock = {
  type?: string;
  text?: string;
  data?: unknown;
  mimeType?: unknown;
};

export type ProjectedImage = {
  /** 稳定 id：`img-<toolCallId>-<图块序号>`；直播与历史同值（AI SDK 按 id upsert） */
  id: string;
  data: PiImagePartData;
};

export type ProjectedToolResult = {
  /** 工具 part 的 output 文本（既有 text 拼装语义 + 未投影图的占位行） */
  output: string;
  images: ProjectedImage[];
};

/** MIME 归一 + 白名单判定；不合法/不在白名单返回 null */
function normalizeMime(mime: unknown): string | null {
  if (typeof mime !== "string") return null;
  const m = mime.trim().toLowerCase();
  // 部分服务器发 image/jpg（非规范拼写），归一到 jpeg
  const canon = m === "image/jpg" ? "image/jpeg" : m;
  return IMAGE_MIME_ALLOWED.has(canon) ? canon : null;
}

const fmtMiB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * 工具结果 → UI 通道投影：output 文本 + data-image part 清单。
 * 超限/白名单外/数据为空的 image 块不进线，改为在 output 尾部追加一行提示
 * （降级可见，与 MCP 输出防护的占位哲学一致），绝不静默吞图。
 */
export function projectToolResult(
  content: ProjectableContentBlock[] | undefined,
  ctx: { toolCallId: string | null; toolName?: string },
): ProjectedToolResult {
  const blocks = Array.isArray(content) ? content : [];
  // 保留既有拼装语义：非文本块贡献空段（join 出空行），历史侧逐字一致的前提
  let output = blocks
    .map((c) => (c?.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
  const notices: string[] = [];
  const images: ProjectedImage[] = [];
  // alt 取第一个非空文本块首行（工具侧约定的 headline，如 "GET … -> 200 image/png"）
  const alt = blocks
    .map((c) => (c?.type === "text" ? String(c.text ?? "").trim() : ""))
    .find((t) => t.length > 0)
    ?.split("\n")[0]
    ?.slice(0, 120);
  let imgIndex = 0;
  for (const c of blocks) {
    if (c?.type !== "image") continue;
    const index = imgIndex++;
    const b64 = typeof c.data === "string" ? c.data.trim() : "";
    const mime = normalizeMime(c.mimeType);
    if (!mime) {
      const label =
        typeof c.mimeType === "string" && c.mimeType.trim()
          ? c.mimeType.trim()
          : "未知类型";
      notices.push(`[图片未展示：不支持的类型 ${label}（仅 png/jpeg/gif/webp）]`);
      continue;
    }
    if (!b64) {
      notices.push(`[图片未展示：${mime} 数据为空]`);
      continue;
    }
    const bytes = Math.floor((b64.length * 3) / 4); // base64 长度近似解码后字节，免解码
    if (bytes > IMAGE_INLINE_MAX_BYTES) {
      notices.push(
        `[图片未展示：约 ${fmtMiB(bytes)}，超过 ${fmtMiB(IMAGE_INLINE_MAX_BYTES)} 内联上限]`,
      );
      continue;
    }
    images.push({
      id: `img-${ctx.toolCallId ?? "direct"}-${index}`,
      data: {
        src: `data:${mime};base64,${b64}`,
        mimeType: mime,
        bytes,
        toolCallId: ctx.toolCallId,
        ...(ctx.toolName ? { toolName: ctx.toolName } : {}),
        ...(alt ? { alt } : {}),
      },
    });
  }
  if (notices.length) {
    output = output.trim() ? `${output}\n${notices.join("\n")}` : notices.join("\n");
  }
  return { output, images };
}
