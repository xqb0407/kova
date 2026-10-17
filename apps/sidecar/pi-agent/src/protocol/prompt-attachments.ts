/**
 * prompt 附件（用户图片 + 文档）的解析与闸门（设计：docs/user-image-attachment-plan.md）。
 *
 * 前端经 prompt 消息的 attachments 字段下发（[{ name, mimeType, data | path }]），
 * 这里单点裁决哪些附件进模型上下文 / 落盘：
 * - 图片：MIME 白名单（png/jpeg/gif/webp/bmp；SVG 整体挡掉）、每条 ≤4 张。
 *   **超限不再丢**：图先交给 image-normalize.ts（Photon）解码 → EXIF 摆正 →
 *   缩放到当前模型 inputLimits.images.resize（缺省 2000x2000）→ 逐档降质/降尺寸
 *   直到 base64 ≤ 内联闸门（2MiB 原始字节）→ BMP 转 PNG，然后组装成
 *   ImageContent 交 agent.prompt(text, images)——pi-agent-core 会把图片拼进
 *   user 消息 content，随 agent 消息本体自动落转录（persist 存整条 agent JSON）。
 *   解不开/处理不了才折算成一行说明。
 * - 文档（PDF/Word/Excel/PPT/文本类）：多模态 API 不吃文档内联，统一落盘到
 *   <cwd>/.kova/attachments/（时间戳前缀防撞名），路径折算成说明行追加到
 *   prompt 文本尾部——agent 用文件工具读取处理（docx/pdf 的解析交给 agent 的
 *   bash/技能，本层只负责把文件送到 agent 的工作目录）。两种载荷：
 *   path（桌面端：前端经 Rust attachment_stage 落盘中转，这里校验后复制，
 *   帧不带字节，上限 20MiB）/ data（网页端回退：base64 内联，上限 8MiB 并计入
 *   总体积红线）。
 * - 体积红线：内联附件（图片经归一化后 + data 文档）裸字节合计 ≤
 *   PROMPT_ATTACH_TOTAL_MAX_BYTES（base64 后 ~14.7MiB，低于 Rust 重放缓冲
 *   16MiB），超出者拒收说明。path 模式不占帧体积，不计入。
 *
 * 拒收不抛错不静默：一律折算成一行中文说明追加到 prompt 文本尾部（模型可读、
 * 刷新后可见），与 image-parts 的降级占位哲学一致。
 * 模型硬门已移除：目录真值与自定义端点默认值都可能把支持图像的模型标成
 * text-only（实测误拦），input 元数据不可靠；图片过物理闸门后一律放行，
 * 端点真不支持时 API 报错且错误对模型/用户可见，好过静默吞图。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { QueueAttachment } from "pi-protocol";
import { IMAGE_INLINE_MAX_BYTES } from "../tools/image-parts";
import {
  IMAGE_INPUT_MAX_BYTES,
  getDefaultImageProcessor,
  imageHints,
  imageLimitsForModel,
  prepareImageBase64,
  type ImageLimitModel,
} from "../tools/image-normalize";
import { normalizeProcessableMime } from "../tools/image-mime";
import type { ImageProcessor } from "../vendor/pi-images/processor";
import { INLINE_IMAGE_TYPES } from "../vendor/pi-images/processor";

/** 单条 prompt 允许携带的图片上限 */
export const PROMPT_IMAGE_MAX_COUNT = 4;

/** 单个文档字节上限（path 模式：前端已落盘中转，这里复制，不受帧体积约束） */
export const PROMPT_DOC_MAX_BYTES = 20 * 1024 * 1024;

/** 单个文档字节上限（data 内联回退：网页端无本地 FS，受请求体/重放缓冲约束） */
export const PROMPT_DOC_INLINE_MAX_BYTES = 8 * 1024 * 1024;

/** 单条 prompt 允许携带的文档上限（两种模式共用，防说明行刷屏） */
export const PROMPT_DOC_MAX_COUNT = 2;

/** 单条 prompt 内联附件（图片+data 文档）裸字节合计上限（base64 后 ~14.7MiB，
 *  低于 Rust 重放缓冲 16MiB；path 模式不占帧体积，不计入） */
export const PROMPT_ATTACH_TOTAL_MAX_BYTES = 11 * 1024 * 1024;

/** 单条 prompt 图片"输入侧"原始字节合计上限：归一化前先挡住并发解码/内存尖峰
 *  （输出侧仍由 2MiB/张与 11MiB 红线约束）。24MiB/张 × 4 张的理论尖峰太大，
 *  这里按 48MiB 合计收口；超出的图按顺序得到说明行。 */
export const PROMPT_IMAGE_INPUT_TOTAL_MAX_BYTES = 48 * 1024 * 1024;

/** 文档附件白名单：扩展名 → { mime, 展示标签 }（mime 反查种类的依据） */
const DOC_TYPES: Readonly<Record<string, { mime: string; label: string }>> = {
  pdf: { mime: "application/pdf", label: "PDF 文档" },
  doc: { mime: "application/msword", label: "Word 文档" },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word 文档",
  },
  ppt: { mime: "application/vnd.ms-powerpoint", label: "PPT 演示" },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PPT 演示",
  },
  xls: { mime: "application/vnd.ms-excel", label: "Excel 表格" },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel 表格",
  },
  csv: { mime: "text/csv", label: "CSV 表格" },
  txt: { mime: "text/plain", label: "文本文件" },
  md: { mime: "text/markdown", label: "Markdown 文档" },
  rtf: { mime: "application/rtf", label: "RTF 文档" },
};

const DOC_MIME = new Set(Object.values(DOC_TYPES).map((t) => t.mime));

/**
 * 按扩展名优先、mime 兜底判定文档种类；命中返回种类描述。
 * 客户端 mime 常缺失（系统粘贴板给空 type），扩展名是主判据，mime 只做交叉。
 */
export function docTypeOf(
  name: string,
  mime?: unknown,
): { ext: string; mime: string; label: string } | null {
  const norm = name.toLowerCase();
  const dot = norm.lastIndexOf(".");
  const ext = dot > 0 ? norm.slice(dot + 1) : "";
  if (ext && DOC_TYPES[ext]) return { ext, ...DOC_TYPES[ext]! };
  const m = typeof mime === "string" ? mime.trim().toLowerCase() : "";
  if (m && DOC_MIME.has(m)) {
    for (const [ext, t] of Object.entries(DOC_TYPES)) {
      if (t.mime === m) return { ext, mime: t.mime, label: t.label };
    }
  }
  return null;
}

export type PreparedPromptAttachments = {
  images: ImageContent[];
  /** 拒收/落盘说明行（空数组 = 全部合法）；调用方按行拼接进 prompt 文本尾部 */
  noticeLines: string[];
};

/** preparePromptAttachments 的可选项；processor 供测试注入（缺省懒加载 Photon） */
export type PreparePromptAttachmentsOptions = {
  cwd?: string;
  /** 当前会话模型：只用于 inputLimits.images.resize，不做能力硬门 */
  model?: ImageLimitModel;
  /** undefined = 用默认 Photon；null = 禁用处理（降级回旧内联闸门） */
  processor?: ImageProcessor | null;
};

/** 原始 prompt 文本 + 拒收说明行 → 模态文本（空行分隔，无说明时原样返回） */
export function noticeAppendedText(text: string, noticeLines: string[]): string {
  return noticeLines.length ? `${text}\n${noticeLines.join("\n")}` : text;
}

/** data URL 防御性剥离（约定传裸 base64，历史客户端可能整段粘贴 data URL） */
function stripDataUrl(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/** 文档落盘目录：<cwd>/.kova/attachments（与全局/工作区层 .kova 同居一处） */
export function docSaveDir(cwd: string): string {
  return join(cwd, ".kova", "attachments");
}

/** 文件名消毒：取 basename、去控制字符防路径穿越；空/点名回退 */
function sanitizeDocName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "document";
}

/** 落盘文件名：时间戳前缀防撞名（同一份文档反复粘贴互不覆盖） */
function timestampedName(name: string): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return `${stamp}-${sanitizeDocName(name)}`;
}

const fmtBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MiB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/**
 * prompt 消息 → 可进模型的 ImageContent 列表 + 拒收/落盘说明行。
 * 图片按序收满 PROMPT_IMAGE_MAX_COUNT 张；超限图先归一化到模型/内联限制，
 * 处理不了才降级说明；文档按序收满 PROMPT_DOC_MAX_COUNT 个（opts.cwd 提供时
 * 落盘并说明路径，缺省拒收）；其余与非法项各得一行说明。
 */
export async function preparePromptAttachments(
  msg: Record<string, unknown>,
  opts?: PreparePromptAttachmentsOptions,
): Promise<PreparedPromptAttachments> {
  const raw = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (raw.length === 0) return { images: [], noticeLines: [] };

  const processorOption = opts?.processor;
  const limits = imageLimitsForModel(opts?.model);
  const noticeLines: string[] = [];
  const images: ImageContent[] = [];
  let docsSaved = 0;
  let totalBytes = 0;
  let imageInputBytes = 0;

  for (let i = 0; i < raw.length; i++) {
    const item = (raw[i] ?? {}) as Record<string, unknown>;
    const rawName =
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim().slice(0, 120)
        : "";
    const mimeRaw = item.mimeType ?? item.mediaType;
    let data = typeof item.data === "string" ? stripDataUrl(item.data.trim()) : "";
    const rawPath = typeof item.path === "string" && item.path.trim() ? item.path.trim() : "";
    let bytes = data ? Buffer.byteLength(data, "base64") : 0;
    const imageMime = normalizeProcessableMime(mimeRaw);
    const docType = imageMime ? null : docTypeOf(rawName, mimeRaw);

    // dialog 直选的图片（path 载荷、无 data）：读盘转 base64，与内联图片走
    // 完全同一套降采样/转码；读盘失败或超过处理上限给专用说明行
    if (!data && rawPath && imageMime) {
      try {
        const st = statSync(rawPath);
        if (!st.isFile() || st.size > IMAGE_INPUT_MAX_BYTES) throw new Error("size");
        data = readFileSync(rawPath).toString("base64");
        bytes = Buffer.byteLength(data, "base64");
      } catch {
        noticeLines.push(
          `[${rawName || `图片${i + 1}`} 已省略：附件图片不可读或超过 ${(IMAGE_INPUT_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 处理上限]`,
        );
        continue;
      }
    }

    if (imageMime) {
      const name = rawName || `图片${i + 1}`;
      if (bytes <= 0) {
        noticeLines.push(`[${name} 已省略：图片数据为空]`);
        continue;
      }
      if (bytes > IMAGE_INPUT_MAX_BYTES) {
        noticeLines.push(
          `[${name} 已省略：图片超过 ${(IMAGE_INPUT_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 处理上限]`,
        );
        continue;
      }
      if (images.length >= PROMPT_IMAGE_MAX_COUNT) {
        noticeLines.push(`[${name} 已省略：单条消息最多 ${PROMPT_IMAGE_MAX_COUNT} 张图片]`);
        continue;
      }
      // 归一化前合计输入上限：防多张超大图把解码内存/CPU 叠加成尖峰
      if (imageInputBytes + bytes > PROMPT_IMAGE_INPUT_TOTAL_MAX_BYTES) {
        noticeLines.push(`[${name} 已省略：单条消息图片输入总体积超限]`);
        continue;
      }
      imageInputBytes += bytes;
      // 懒加载：只有真的处理图片时才初始化 Photon（文档-only 的 prompt 不碰 WASM）
      const processor =
        processorOption === undefined ? getDefaultImageProcessor() : processorOption;
      // 处理到合规：模型限制（2000x2000 / 4.5MiB）+ 内联闸门（2MiB）取严
      let prepared = await prepareImageBase64(data, imageMime, limits, processor);
      if (!prepared) {
        // 处理器不可用（wasm 加载失败）时维持旧闸门：本来合规的内联图放行
        if (
          processor === null &&
          INLINE_IMAGE_TYPES.has(imageMime) &&
          bytes <= IMAGE_INLINE_MAX_BYTES
        ) {
          prepared = { data, mimeType: imageMime };
        } else {
          noticeLines.push(`[${name} 已省略：图片无法解码或压缩到内联上限]`);
          continue;
        }
      }
      const outBytes = Buffer.byteLength(prepared.data, "base64");
      // 处理器承诺"压到 limits.maxBytes 内"；这里再兜一道（处理器被替换/降级
      // 时也不能把超闸门的 base64 塞进 prompt 帧）
      if (outBytes > IMAGE_INLINE_MAX_BYTES) {
        noticeLines.push(
          `[${name} 已省略：图片无法压缩到 ${(IMAGE_INLINE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 内联上限]`,
        );
        continue;
      }
      if (totalBytes + outBytes > PROMPT_ATTACH_TOTAL_MAX_BYTES) {
        noticeLines.push(`[${name} 已省略：单条消息附件总体积超限]`);
        continue;
      }
      totalBytes += outBytes;
      images.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
      noticeLines.push(...imageHints(prepared, imageMime));
      continue;
    }

    const name = rawName || `附件${i + 1}`;

    if (docType) {
      if (docsSaved >= PROMPT_DOC_MAX_COUNT) {
        noticeLines.push(`[${name} 已省略：单条消息最多 ${PROMPT_DOC_MAX_COUNT} 个文档]`);
        continue;
      }
      const cwd = opts?.cwd;
      if (!cwd) {
        noticeLines.push(`[${name} 已省略：附件落盘目录不可用]`);
        continue;
      }

      // path 模式：前端给的是真实存在的本地文件（dialog 直选的原文件，或粘贴
      // 经 Rust 中转的落盘文件）——原位引用不复制，不往 cwd 写任何东西
      // （避免污染工作区 git 状态）。说明行直接给绝对路径，agent 用文件工具读。
      if (rawPath) {
        let size = 0;
        try {
          const st = statSync(rawPath);
          if (!st.isFile()) throw new Error("not-file");
          size = st.size;
        } catch {
          noticeLines.push(`[${name} 已省略：附件文件不存在或不可读]`);
          continue;
        }
        if (size > PROMPT_DOC_MAX_BYTES) {
          noticeLines.push(
            `[${name} 已省略：文档超过 ${(PROMPT_DOC_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限]`,
          );
          continue;
        }
        docsSaved += 1;
        noticeLines.push(
          `[用户附件：${sanitizeDocName(name)}（${docType.label}，${fmtBytes(size)}）位于 ${rawPath}，请用文件工具读取处理]`,
        );
        continue;
      }

      // data 内联回退（网页端）：base64 经帧传输，上限更紧并计入总体积红线
      if (bytes <= 0 || bytes > PROMPT_DOC_INLINE_MAX_BYTES) {
        noticeLines.push(
          `[${name} 已省略：文档超过 ${(PROMPT_DOC_INLINE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限]`,
        );
        continue;
      }
      if (totalBytes + bytes > PROMPT_ATTACH_TOTAL_MAX_BYTES) {
        noticeLines.push(`[${name} 已省略：单条消息附件总体积超限]`);
        continue;
      }
      const fname = timestampedName(name);
      try {
        mkdirSync(docSaveDir(cwd), { recursive: true });
        writeFileSync(join(docSaveDir(cwd), fname), Buffer.from(data, "base64"));
      } catch {
        noticeLines.push(`[${name} 已省略：附件落盘失败]`);
        continue;
      }
      totalBytes += bytes;
      docsSaved += 1;
      // 显示名与落盘名都取消毒后的 basename：穿越符不进模型上下文，避免
      // 模型误读出一个目录外的路径
      noticeLines.push(
        `[用户附件：${sanitizeDocName(name)}（${docType.label}，${fmtBytes(bytes)}）已保存到 .kova/attachments/${fname}，请用文件工具读取处理]`,
      );
      continue;
    }

    noticeLines.push(
      `[${name} 已省略：仅支持图片（PNG/JPEG/GIF/WebP）或文档（PDF/Word/Excel/PPT/TXT/MD/CSV）]`,
    );
  }
  return { images, noticeLines };
}

/* ------------------------- 队列条目的附件透传 -------------------------
 * 队列快照（sessions/prompt-queue.ts）与出队（protocol/handlers/queue.ts）
 * 必须按**前端真实帧形状**过滤附件：{ name, mimeType, data | path }——
 * 这里没有 `type: "image"` 字段（曾按它过滤，导致带图排队项的图片在快照/
 * 出队时被整体丢弃，刷新、重启、接力泵重发全丢图）。两处共用本函数，
 * 形状一旦再漂移只需改一处。
 * ------------------------------------------------------------------------- */

/** prompt 帧 attachments → 可随队列携带的图片附件（白名单 + 有 data/path 才收） */
export function queueImageAttachments(msg: Record<string, unknown>): QueueAttachment[] {
  const raw = Array.isArray(msg.attachments) ? msg.attachments : [];
  const out: QueueAttachment[] = [];
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    // 可处理口径（含 BMP）：真正的降采样/转码在出队派发时由 preparePromptAttachments 做
    if (!normalizeProcessableMime(item.mimeType ?? item.mediaType)) continue;
    const data = typeof item.data === "string" && item.data.trim() ? item.data : undefined;
    const path = typeof item.path === "string" && item.path.trim() ? item.path.trim() : undefined;
    if (!data && !path) continue;
    const name =
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim().slice(0, 120)
        : undefined;
    out.push({
      ...(name ? { name } : {}),
      mimeType: (item.mimeType ?? item.mediaType) as string,
      ...(data ? { data: stripDataUrl(data.trim()) } : {}),
      ...(path ? { path } : {}),
    });
  }
  return out;
}

/** 出队/重发用：path-only 图片读出字节内联（超过处理上限才拒）；读不了返回 null
 *  （调用方丢弃该项并留痕——重发链路要的是可直接进 prompt 的 data 载荷）。
 *  2MiB 内联闸门不在这里：出队派发时 preparePromptAttachments 会先降采样/转码。 */
export function inlineQueueAttachment(att: QueueAttachment): QueueAttachment | null {
  if (att.data) return att;
  if (!att.path) return null;
  try {
    const st = statSync(att.path);
    if (!st.isFile() || st.size > IMAGE_INPUT_MAX_BYTES) return null;
    return { ...att, data: readFileSync(att.path).toString("base64") };
  } catch {
    return null;
  }
}
