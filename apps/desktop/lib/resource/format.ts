/**
 * 资源管理器的展示格式化：只放纯函数，便于单测。
 *
 * 字节格式化直接复用 `lib/panels/artifacts` 的实现（B/KB/MB/GB/TB，1024 进制，
 * 一位小数）——仓库里已有四份各自实现的 formatBytes，不再添第五份。
 */

export { formatBytes } from "@/lib/panels/artifacts";

/** 百分比：统一一位小数，供 CPU 与内存两页的表格与磁贴共用 */
export function formatPct(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0%";
  // 极小但非零的占用显示成 0.1% 而不是 0.0%：表格里"有进程但全 0.0%"看着像坏了
  if (value < 0.1) return "0.1%";
  return `${value.toFixed(1)}%`;
}

/** 时刻（"上次计算 21:06"） */
export function formatClock(tsMs: number): string {
  if (!tsMs) return "-";
  return new Date(tsMs).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 某个类目占应用总量的百分比（存储表里每行那根小条的宽度） */
export function sharePct(bytes: number, total: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0 || total <= 0) return 0;
  return Math.min(100, (bytes / total) * 100);
}

/**
 * 把绝对路径里的用户主目录缩成 `~`：存储表要横排一列路径，`/Users/<名字>/`
 * 这 15 个字符每行都重复出现，纯属占地方（真实值仍在 tooltip 里给全）。
 */
export function shortenHome(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

/** 卷占用：已用 / 总量（0 表示取不到，调用方按"未知"展示） */
export function diskUsedPct(disk: { total: number; free: number }): number {
  if (disk.total <= 0) return 0;
  const used = disk.total - disk.free;
  return Math.min(100, Math.max(0, (used / disk.total) * 100));
}
