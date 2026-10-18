/**
 * 从未完成的 JSON 对象里提取已经完整的顶层字段。
 *
 * 工具参数是流式 JSON（`{"file_path":"...","content":"...`）：在 toolcall_end
 * 之前整段不是合法 JSON，但前面的 `file_path`/`command` 往往已经完整。这里只
 * 解析到最后一个完整的顶层键值对，供 UI 在运行中先显示工具目标（文件路径、
 * 命令等），避免写入/编辑工具整行只剩一个工具名。
 *
 * 返回 null 表示还没有可用的完整字段（或输入不是 JSON 对象）。
 */
export function parsePartialJsonObject(
  text: string,
): Record<string, unknown> | null {
  const src = text.trim();
  if (!src.startsWith("{")) return null;

  const parseObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return Object.keys(value as Record<string, unknown>).length > 0
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const whole = parseObject(src);
  if (whole) return whole;

  // 扫描顶层：最后一个完整的顶层逗号，以及是否停在字符串/嵌套结构里。
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastComma = -1;
  for (let i = 1; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) lastComma = i;
  }

  if (lastComma > 0) {
    const prefix = parseObject(`${src.slice(0, lastComma)}}`);
    if (prefix) return prefix;
  }
  // 末尾字段可能已经完整、只是缺右括号（例如 `{"file_path":"/a/b"`）
  if (!inString && depth === 0) {
    const closed = parseObject(`${src}}`);
    if (closed) return closed;
  }
  return null;
}
