/**
 * 文本工具（跨子系统共用）：当前只有 UTF-8 安全截断。
 *
 * 截断必须按字节而不是按字符：技能正文/工具参数摘要的预算都是字节口径，
 * 按字符切会在多字节字符（中文、emoji）上把预算算少；按字节裸切又会切出
 * 半个字符。这里回退到 UTF-8 起始字节边界再解码。
 */

/** 按 UTF-8 字节上限截断；maxBytes ≤ 0 返回空串。不追加省略号，由调用方决定。 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  // 若末字节是续字节（10xxxxxx），说明最后一个字符跨过了切点：回退到它的起始字节
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}
