/**
 * Inbox 展示文本的安全构造：所有 title/summary/detail 文本都过这里。
 * 目标：单行、可读、不泄露密钥/长 base64；不追求语义摘要（v1 不额外调模型）。
 */

/** 摘要硬上限（协议注释承诺 ≤240 字符） */
export const INBOX_SUMMARY_LIMIT = 240;

/** 长 base64 / data URL 的粗判：连续 80+ 个 base64 字符视为二进制块 */
const LONG_BASE64_RE = /[A-Za-z0-9+/=_-]{80,}/g;

/**
 * 压空白、去控制字符、打码常见密钥形状，再按字符数截断。
 * 不改变 JSON 结构（调用方只传文本）。
 */
export function safePreview(value: unknown, limit = INBOX_SUMMARY_LIMIT): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : stringifyUnknown(value);
  const flat = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = flat
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox*-***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]")
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer ***")
    .replace(
      /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)\s*[:=]\s*[^\s"',}]+/gi,
      "$1=***",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[private-key]",
    )
    .replace(LONG_BASE64_RE, "[base64]");
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, Math.max(0, limit - 1))}…`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  // 工具输入最常见的可读字段优先；找不到再整包 JSON 截断
  for (const key of ["command", "file_path", "path", "url", "query", "pattern", "description"]) {
    const hit = record[key];
    if (typeof hit === "string" && hit.trim()) return hit;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** 计数文案：`3 项` / `3 项（另有 2 项已归档）`，避免 UI 各拼一套 */
export function countText(n: number): string {
  return `${n} 项`;
}
