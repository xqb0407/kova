/**
 * MCP 输出防护：第三方服务器的返回不设防地进上下文会打爆窗口/烧 token
 * （一次 search 就能吐 1MB）。三级控制，哲学与 read 的 64KB / grep 的 200 条一致：
 * 模型拿到的是「有界 + 可续取」的结果。
 *
 * - 文本：8KB / 1000 行截断；超限溢写临时文件，截断通知附完整路径
 *   （模型可用 read 分页取回，用户可直接打开）——截断是降级不是丢弃。
 * - 非文本块：image/audio/resource 不进文本通道，给一行占位说明（P0 不做落盘渲染）。
 * - 整体：CallToolResult 序列化超过 16KB 时 details 换成结构化摘要
 *   （块计数 + 逐块字节预览），保证 details 元数据本身不会反向膨胀。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MCP_OUTPUT_MAX_BYTES = 8 * 1024;
export const MCP_OUTPUT_MAX_LINES = 1000;
/** details 摘要触发阈值（CallToolResult 序列化字节数） */
export const MCP_DETAILS_MAX_BYTES = 16 * 1024;
/** 单行超长折叠长度 */
const MAX_LINE_BYTES = 2000;

/** SDK CallToolResult 的 content 块（形状按需放宽） */
export type McpContentBlock = {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: unknown;
  uri?: string;
  name?: string;
};

export type McpCallResult = {
  content?: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
};

export type GuardedOutput = {
  /** 进模型上下文的最终文本 */
  text: string;
  truncated: boolean;
  originalBytes: number;
  /** 溢写文件绝对路径（未截断为 undefined） */
  fullOutputPath?: string;
};

const overflowDir = (): string => join(tmpdir(), `xulux-mcp-output-${randomUUID().slice(0, 8)}`);

function foldLongLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES
        ? `${line.slice(0, MAX_LINE_BYTES)}…[line truncated]`
        : line,
    )
    .join("\n");
}

/** spill-to-file：把完整输出写临时文件，返回路径；失败返回 undefined（仍给截断文本） */
export function spillToTempFile(text: string, ext = "txt"): string | undefined {
  try {
    const dir = overflowDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `output.${ext}`);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/**
 * 文本通道输出防护：8KB/1000 行内原样返回；超限截断 + 溢写。
 * 返回文本永不抛错——输出防护失败不能反噬工具调用本身。
 */
export function guardMcpText(text: string): GuardedOutput {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const withinBytes = originalBytes <= MCP_OUTPUT_MAX_BYTES;
  const lines = text.split("\n");
  const withinLines = lines.length <= MCP_OUTPUT_MAX_LINES;
  if (withinBytes && withinLines) {
    return { text: foldLongLines(text), truncated: false, originalBytes };
  }
  const path = spillToTempFile(text);
  const kept = withinLines
    ? text
    : lines.slice(0, MCP_OUTPUT_MAX_LINES).join("\n");
  // 行裁剪后再按字节裁（保守逐字节回退，避免劈开多字节字符）
  let body = kept;
  while (Buffer.byteLength(body, "utf8") > MCP_OUTPUT_MAX_BYTES && body.length > 0) {
    body = body.slice(0, Math.floor(body.length * 0.9));
  }
  const notice =
    `\n[MCP 输出已截断：原始 ${lines.length} 行 / ${originalBytes} 字节，` +
    (path ? `完整内容已存到 ${path}（可用 read 工具分页读取）` : "完整内容写入临时文件失败") + "]";
  return { text: body + notice, truncated: true, originalBytes, fullOutputPath: path };
}

/** 非文本块的占位说明（P0 不落盘渲染图像/资源） */
function describeBlock(block: McpContentBlock): string | null {
  const type = String(block.type ?? "unknown");
  if (type === "text" && typeof block.text === "string") return block.text;
  const sizeHint = typeof block.data === "string" ? Math.round(block.data.length * 0.75) : 0;
  const label = type === "resource" ? `resource ${block.uri ?? block.name ?? ""}`.trim() : `${type} 块`;
  return `[${label}${block.mimeType ? ` · ${block.mimeType}` : ""}${sizeHint ? ` · ~${sizeHint}B` : ""}：二进制内容未进文本通道]`;
}

/** content 块 → 防护后的文本（text 通道只收 text，其余占位） */
export function formatMcpContent(content: unknown): string {
  if (typeof content === "string") return guardMcpText(content).text;
  if (!Array.isArray(content)) return "";
  const parts = (content as McpContentBlock[])
    .map(describeBlock)
    .filter((s): s is string => s !== null && s.length > 0);
  return guardMcpText(parts.join("\n")).text;
}

export type McpResultSummary = {
  /** true = details 被摘要替换 */
  summarized: true;
  reason: string;
  contentBlocks: number;
  contentPreview: Array<{
    type: string;
    bytes?: number;
    lines?: number;
    omitted?: boolean;
  }>;
  structuredContentBytes: number;
  rawResultBytes: number;
};

/**
 * details 侧护栏：CallToolResult 序列化 ≤16KB 原样返回；超限出结构化摘要。
 * （文本正文已经过 guardMcpText，这里防的是巨型 structuredContent / 图片 base64
 * 之类的附带元数据把 details、进而把转录和 UI 撑爆。）
 */
export function boundMcpResult(
  result: McpCallResult | null,
): { summary: McpResultSummary | null; result: McpCallResult | null } {
  if (!result || typeof result !== "object") return { summary: null, result };
  const rawBytes = Buffer.byteLength(JSON.stringify(result ?? null), "utf8");
  if (rawBytes <= MCP_DETAILS_MAX_BYTES) return { summary: null, result };
  const blocks = Array.isArray(result.content) ? result.content : [];
  const contentPreview: McpResultSummary["contentPreview"] = blocks
    .slice(0, 20)
    .map((b) => {
      const type = String(b.type ?? "unknown");
      if (type === "text" && typeof b.text === "string") {
        const lines = b.text.split("\n").length;
        return { type, bytes: Buffer.byteLength(b.text, "utf8"), lines };
      }
      const bytes =
        typeof b.data === "string" ? Math.round(b.data.length * 0.75) : undefined;
      return { type, bytes };
    });
  if (blocks.length > 20) {
    contentPreview.push({ type: "omitted", omitted: true });
  }
  return {
    summary: {
      summarized: true,
      reason: `CallToolResult 序列化 ${rawBytes} 字节，超过 ${MCP_DETAILS_MAX_BYTES}，details 换为摘要`,
      contentBlocks: blocks.length,
      contentPreview,
      structuredContentBytes: result.structuredContent
        ? Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")
        : 0,
      rawResultBytes: rawBytes,
    },
    // 摘要替换后给模型正文的 content 仍在（文本通道有独立护栏），只裁 structuredContent
    result: {
      ...result,
      structuredContent: undefined,
    },
  };
}
