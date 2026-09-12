/**
 * 提交图谱车道分配（IDEA 风格）：把拓扑序提交列表映射为每行的画线指令。
 * 纯函数、无副作用，方便单测。子在上、父在下；每条"车道"持有一个
 * 待命哈希（下一行将到达的提交），行处理时按父子关系续道/借道/分道。
 */
import type { GitGraphEntry } from "./git";

export const GRAPH_ROW_H = 26;
export const GRAPH_LANE_W = 14;

/** IDEA 近似配色：按车道索引取色 */
export const GRAPH_COLORS = [
  "#4c8fdf",
  "#5aa85a",
  "#d18a3f",
  "#a678c9",
  "#47b3ad",
  "#cf5f66",
  "#8fae3f",
  "#6f7fe0",
  "#c96fae",
  "#3fa9cf",
];

export type GraphRow = {
  entry: GitGraphEntry;
  /** 本提交圆点所在车道 */
  lane: number;
  /** 顶边到圆点之间有线（该提交有已在上方绘制的子边） */
  above: boolean;
  /** 第一父的车道：===lane 画垂直线，≠lane 画曲线 */
  below: number | null;
  /** 额外父的车道（圆点→底边曲线） */
  curves: number[];
  /** 直穿本行的其他活跃车道（顶→底垂直线） */
  passThrough: number[];
  /** 在本行圆点处终结的其他车道（顶→圆点垂直线） */
  terminates: number[];
  /** 本行之后的总车道数（含终结列，用于画布宽度） */
  lanes: number;
};

export function layoutGraph(entries: GitGraphEntry[]): GraphRow[] {
  const present = new Set(entries.map((e) => e.hash));
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  const allocLane = (): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const entry of entries) {
    let lane = lanes.indexOf(entry.hash);
    const above = lane >= 0;
    if (!above) lane = allocLane(); // 多分支头（--branches --remotes）：新开道，上方无线
    lanes[lane] = null; // 消费本提交在车道的待命项

    // 分配父边之前的活跃快照：只有此前就在流淌的道才算直穿
    const before = lanes.slice();
    const parents = entry.parents.filter((p) => present.has(p));
    let below: number | null = null;
    const curves: number[] = [];
    parents.forEach((p, i) => {
      let t = lanes.indexOf(p);
      if (i === 0) {
        if (t < 0) t = lane; // 第一父默认续道
        lanes[t] = p;
        below = t;
      } else {
        if (t < 0) t = allocLane(); // 合并借既有活跃道，否则新开道
        lanes[t] = p;
        curves.push(t);
      }
    });

    // 其他也在等本提交的道（多子的父：曲线目标道）终结于圆点
    const terminates: number[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] === entry.hash) {
        lanes[j] = null;
        terminates.push(j);
      }
    }

    // 除本道外，本行之前就有待命哈希且之后仍待命的道直穿
    // （含曲线目标道：它的入边来自更上方的子）
    const passThrough: number[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && before[j] != null && lanes[j] != null) passThrough.push(j);
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      entry,
      lane,
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
