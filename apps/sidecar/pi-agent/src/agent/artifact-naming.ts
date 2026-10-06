/**
 * 产物文件的命名纪律：计划文件与目标产物共用同一套清洗与时间戳。
 *
 * 为什么单独成一个模块：这两个函数原本是 modes.ts 的私有的，目标产物要用就得从
 * 那里导出——而 modes.ts 依赖 goal/goal.ts，goal/goal.ts 又要调产物落盘，
 * 直接互相 import 会绕成一个环（ESM 能跑，但模块初始化顺序一变就是难查的
 * undefined）。抽到这里，两边都只依赖这个零依赖的小模块。
 */

/**
 * 文件名清洗：任何非文字/数字串（空白、破折号、全角标点、Windows 非法字符等）
 * 折叠为单个连字符，去掉首尾连接符，限长 60。
 * 如 “PRD WiFi 化 — 门店入口” → PRD-WiFi-化-门店入口
 */
export function sanitizeFileName(input: string): string {
  return input
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** 时间戳：YYYYMMDD-HHmmss */
export function fileTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
