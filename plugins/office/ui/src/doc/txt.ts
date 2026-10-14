/**
 * 文档快照 → 纯文本（纯函数）。dataStream 以 \r 作段落分隔（文档模型约定），
 * 导出统一转 \n；样式/标题级别等富信息 v1 不进 TXT（用户要排版就留工作区档）。
 */

export type TextDocBody = { dataStream?: string } | undefined;

export function docToText(snapshot: { body?: TextDocBody }): string {
  const stream = snapshot.body?.dataStream ?? "";
  return stream.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}
