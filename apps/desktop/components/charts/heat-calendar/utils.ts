/** 强度 0~4 各自的混色比例（%），颜色来自单一色相。 */
export const STEPS = [0, 24, 46, 70, 94] as const;

/** 空格子：前景色极淡的一层，深浅模式下都成立。 */
export const EMPTY = "color-mix(in srgb, var(--foreground) 6%, transparent)";

/** 格子边长与间隙；网格内所有位置和 tooltip 都由它们推导。
 *  18px 是本仓库调大的结果（上游 16px）：一屏能放下的周数因此变少，
 *  见 usage-heatmap 的 FLAT_WEEKS。 */
export const CELL = 18;

export const GAP = 4;

export const PITCH = CELL + GAP;

export const MONTH_ROW = 12;

export const DAYS = Array.from({ length: 7 }, (_, d) => ({ id: `d${d}`, d }));

/** 悬浮时本期格、相邻格、隔一格的抬升幅度。 */
export const LIFT = [1.3, 1.08, 1.03];

export const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

/** `d` 当天或之前最近的周一，于是每一列自上而下都是周一到周日。 */
export const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getUTCDay() + 6) % 7));

/** 网格内的日期一律按 UTC 取字段，显式传入 endDate 后渲染结果与运行时时区无关。 */
export const fmtDay = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "UTC",
  year: "numeric",
  month: "long",
  day: "numeric",
});

export const fmtMonth = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "long" });

export const fmtRange = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "long", day: "numeric" });
