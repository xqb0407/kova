/**
 * prompt 附件（用户图片 + 文档）的解析与闸门（设计：docs/user-image-attachment-plan.md）。
 *
 * 前端经 prompt 消息的 attachments 字段下发（[{ name, mimeType, data | path }]），
 * 这里单点裁决哪些附件进模型上下文 / 落盘：
 * - 图片：MIME 白名单（与工具结果图片投影 image-parts 同一张表，SVG 整体挡掉）、
 *   单图 ≤2MiB（同 IMAGE_INLINE_MAX_BYTES，base64 后 ~2.7MiB）、每条 ≤4 张；
 *   合法图片组装成 ImageContent 交 agent.prompt(text, images)——pi-agent-core 会
 *   把图片拼进 user 消息 content，随 agent 消息本体自动落转录（persist 存整条
 *   agent JSON）。
 * - 文档（PDF/Word/Excel/PPT/文本类）：多模态 API 不吃文档内联，统一落盘到
 *   <cwd>/.xulux/attachments/（时间戳前缀防撞名），路径折算成说明行追加到
 *   prompt 文本尾部——agent 用文件工具读取处理（docx/pdf 的解析交给 agent 的
 *   bash/技能，本层只负责把文件送到 agent 的工作目录）。两种载荷：
 *   path（桌面端：前端经 Rust attachment_stage 落盘中转，这里校验后复制，
 *   帧不带字节，上限 20MiB）/ data（网页端回退：base64 内联，上限 8MiB 并计入
 *   总体积红线）。
 * - 体积红线：内联附件（图片+data 文档）裸字节合计 ≤ PROMPT_ATTACH_TOTAL_MAX_BYTES
 *   （base64 后 ~14.7MiB，低于 Rust 重放缓冲 16MiB），超出者拒收说明。
 *
 * 拒收不抛错不静默：一律折算成一行中文说明追加到 prompt 文本尾部（模型可读、
 * 刷新后可见），与 image-parts 的降级占位哲学一致。
 * 模型硬门已移除：目录真值与自定义端点默认值都可能把支持图像的模型标成
 * text-only（实测误拦），input 元数据不可靠；图片过物理闸门后一律放行，
 * 端点真不支持时 API 报错且错误对模型/用户可见，好过静默吞图。
 */
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IMAGE_INLINE_MAX_BYTES, normalizeMime } from "./image-parts";

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

/** 原始 prompt 文本 + 拒收说明行 → 模态文本（空行分隔，无说明时原样返回） */
export function noticeAppendedText(text: string, noticeLines: string[]): string {
  return noticeLines.length ? `${text}\n${noticeLines.join("\n")}` : text;
}

/** data URL 防御性剥离（约定传裸 base64，历史客户端可能整段粘贴 data URL） */
function stripDataUrl(data: string): string {
  return data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
}

/** 文档落盘目录：<cwd>/.xulux/attachments（与全局/工作区层 .xulux 同居一处） */
export function docSaveDir(cwd: string): string {
  return join(cwd, ".xulux", "attachments");
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
 * 图片按序收满 PROMPT_IMAGE_MAX_COUNT 张；文档按序收满 PROMPT_DOC_MAX_COUNT 个
 * （opts.cwd 提供时落盘并说明路径，缺省拒收）；其余与非法项各得一行说明。
 */
export function preparePromptAttachments(
  msg: Record<string, unknown>,
  opts?: { cwd?: string },
): PreparedPromptAttachments {
  const raw = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (raw.length === 0) return { images: [], noticeLines: [] };

  const noticeLines: string[] = [];
  const images: ImageContent[] = [];
  let docsSaved = 0;
  let totalBytes = 0;

  for (let i = 0; i < raw.length; i++) {
    const item = (raw[i] ?? {}) as Record<string, unknown>;
    const rawName =
      typeof item.name === "string" && item.name.trim()
        ? item.name.trim().slice(0, 120)
        : "";
    const mimeRaw = item.mimeType ?? item.mediaType;
    const data = typeof item.data === "string" ? stripDataUrl(item.data.trim()) : "";
    const bytes = data ? Buffer.byteLength(data, "base64") : 0;
    const imageMime = normalizeMime(mimeRaw);
    const docType = imageMime ? null : docTypeOf(rawName, mimeRaw);

    if (imageMime) {
      const name = rawName || `图片${i + 1}`;
      if (bytes <= 0 || bytes > IMAGE_INLINE_MAX_BYTES) {
        noticeLines.push(
          `[${name} 已省略：图片超过 ${(IMAGE_INLINE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限]`,
        );
        continue;
      }
      if (images.length >= PROMPT_IMAGE_MAX_COUNT) {
        noticeLines.push(`[${name} 已省略：单条消息最多 ${PROMPT_IMAGE_MAX_COUNT} 张图片]`);
        continue;
      }
      if (totalBytes + bytes > PROMPT_ATTACH_TOTAL_MAX_BYTES) {
        noticeLines.push(`[${name} 已省略：单条消息附件总体积超限]`);
        continue;
      }
      totalBytes += bytes;
      images.push({ type: "image", data, mimeType: imageMime });
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
      const fname = timestampedName(name);

      // path 模式（桌面端）：前端已经 Rust 落盘中转，校验存在后复制进 cwd 附件
      // 目录——帧里只有路径没有字节，请求体不随文档膨胀
      const rawPath = typeof item.path === "string" ? item.path.trim() : "";
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
        try {
          mkdirSync(docSaveDir(cwd), { recursive: true });
          copyFileSync(rawPath, join(docSaveDir(cwd), fname));
        } catch {
          noticeLines.push(`[${name} 已省略：附件落盘失败]`);
          continue;
        }
        docsSaved += 1;
        noticeLines.push(
          `[用户附件：${sanitizeDocName(name)}（${docType.label}，${fmtBytes(size)}）已保存到 .xulux/attachments/${fname}，请用文件工具读取处理]`,
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
        `[用户附件：${sanitizeDocName(name)}（${docType.label}，${fmtBytes(bytes)}）已保存到 .xulux/attachments/${fname}，请用文件工具读取处理]`,
      );
      continue;
    }

    noticeLines.push(
      `[${name} 已省略：仅支持图片（PNG/JPEG/GIF/WebP）或文档（PDF/Word/Excel/PPT/TXT/MD/CSV）]`,
    );
  }
  return { images, noticeLines };
}
