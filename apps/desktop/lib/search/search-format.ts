/** 搜索结果的展示格式化（纯函数，无 React / DOM 依赖）。 */

/**
 * 相对时间：与 thread-list.aui 的 formatElapsed 同口径（7 天内相对，
 * 跨期给短日期），保证侧栏会话行与搜索结果行的时间读法一致。
 */
export function formatRelativeTime(at: string | number): string | null {
  const ts = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const now = Date.now();
  const total = Math.floor((now - ts) / 1000);
  if (total < 60) return "刚刚";
  const min = Math.floor(total / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}天前`;
  const date = new Date(ts);
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 目录尾段当项目名；空 cwd（无目录会话）返回空串 */
export function projectNameOf(cwd: string): string {
  if (!cwd) return "";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "";
}

/** 查询词里需要高亮的部分（剥掉 `>` 命令前缀与空白） */
export function highlightNeedle(query: string): string {
  return query.replace(/^[>\s]+/, "").trim();
}
