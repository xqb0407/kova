/**
 * 提交图谱车道分配（GitHub Desktop / GitKraken 风格）：把拓扑序提交列表映射为
 * 每行的画线指令。纯函数、无副作用，方便单测。子在上、父在下；每条"车道"持有
 * 一个待命哈希（下一行将到达的提交），行处理时按父子关系续道/借道/分道。
 *
 * 颜色不跟车道号走，而是跟"血缘"走：车道持有待命哈希时同时持有色号，父提交
 * 续道沿用子提交色号，新开道才取下一个色号。这样分支换道时不会突然变色，
 * 行边界上下两截线的颜色也永远对得上。
 */
import type { GitGraphEntry } from "./git";

export const GRAPH_ROW_H = 32;
export const GRAPH_LANE_W = 16;

/** 车道配色：冷暖交替、明暗主题都不刺眼（近似 GitHub 图的色相分布） */
export const GRAPH_COLORS = [
  "#4b8bf5",
  "#3fb950",
  "#d29922",
  "#a371f7",
  "#2bb3c0",
  "#f85149",
  "#db61a2",
  "#84cc16",
  "#b0724b",
  "#8b949e",
];

/** 一段线：落在哪条车道、用什么色号 */
export type GraphLane = { lane: number; color: number };

export type GraphRow = {
  entry: GitGraphEntry;
  /** 本提交圆点所在车道 */
  lane: number;
  /** 本提交的血缘色号 */
  color: number;
  /** 顶边到圆点之间有线（该提交有已在上方绘制的子边） */
  above: boolean;
  /** 第一父：===lane 画垂直线，≠lane 画曲线 */
  below: GraphLane | null;
  /** 额外父的车道（圆点→底边曲线） */
  curves: GraphLane[];
  /** 直穿本行的其他活跃车道（顶→底垂直线） */
  passThrough: GraphLane[];
  /** 在本行圆点处终结的其他车道（顶→圆点垂直线） */
  terminates: GraphLane[];
  /** 本行之后的总车道数（含终结列，用于画布宽度） */
  lanes: number;
};

type Pending = { hash: string; color: number } | null;

export function layoutGraph(entries: GitGraphEntry[]): GraphRow[] {
  const present = new Set(entries.map((e) => e.hash));
  const lanes: Pending[] = [];
  const rows: GraphRow[] = [];
  let nextColor = 0;

  for (const entry of entries) {
    const found = lanes.findIndex((l) => l?.hash === entry.hash);
    const above = found >= 0; // 多分支头（--branches --remotes）：新开道，上方无线
    const lane = above ? found : lanes.length;
    const color = above ? lanes[found]!.color : nextColor++;
    if (!above) lanes.push(null);
    lanes[lane] = null; // 消费本提交在车道的待命项

    // 分配父边之前的活跃快照：只有此前就在流淌的道才算直穿
    const before = lanes.slice();
    const parents = entry.parents.filter((p) => present.has(p));
    let below: GraphLane | null = null;
    const curves: GraphLane[] = [];

    parents.forEach((p, i) => {
      const t0 = lanes.findIndex((l) => l?.hash === p);
      if (i === 0) {
        const t = t0 < 0 ? lane : t0; // 第一父默认续道
        // 同车道续道沿用本提交色号；并入别的车道则用那条车道已有的色号
        const c = t === lane ? color : lanes[t]!.color;
        lanes[t] = { hash: p, color: c };
        below = { lane: t, color: c };
      } else if (t0 < 0) {
        const t = lanes.length; // 合并父新开道
        lanes.push({ hash: p, color: nextColor++ });
        curves.push({ lane: t, color: lanes[t]!.color });
      } else {
        lanes[t0] = { hash: p, color: lanes[t0]!.color }; // 借既有活跃道
        curves.push({ lane: t0, color: lanes[t0]!.color });
      }
    });

    // 其他也在等本提交的道（多子的父：曲线目标道）终结于圆点
    const terminates: GraphLane[] = [];
    for (let j = 0; j < lanes.length; j++) {
      const l = lanes[j];
      if (j !== lane && l?.hash === entry.hash) {
        terminates.push({ lane: j, color: l.color });
        lanes[j] = null;
      }
    }

    // 除本道外，本行之前就有待命哈希且之后仍待命的道直穿
    // （含曲线目标道：它的入边来自更上方的子）
    const passThrough: GraphLane[] = [];
    for (let j = 0; j < lanes.length; j++) {
      const l = lanes[j];
      if (j !== lane && l && before[j] != null)
        passThrough.push({ lane: j, color: l.color });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      entry,
      lane,
      color,
      above,
      below,
      curves,
      passThrough,
      terminates,
      lanes: Math.max(lanes.length, lane + 1),
    });
  }
  return rows;
}
