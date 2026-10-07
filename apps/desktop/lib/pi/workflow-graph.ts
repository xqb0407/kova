import type { WorkflowStepView } from "@/lib/pi/pi-workflow";

/**
 * 工作流编排图的布局(纯函数,无 DOM):把 steps 的 dependsOn 关系算成
 * 「列(层级) × 行」的节点坐标 + 连线端点,卡片里用绝对定位 + SVG 画。
 *
 * 为什么自己算而不引图库:依赖关系是**最长路径分层**——一个纯 DAG 的确定性
 * 问题,十来行代码;引布局库(elk/dagre)会给桌面端塞进几百 KB,而这个图的规模
 * 上限是 100 步(MAX_STEPS_PER_RUN),不需要通用解。
 *
 * 约定:
 * - layer = 从源点出发的最长路径长度 → 所有边必然从左指向右(依赖先跑);
 * - 同层节点按剧本声明序排列(稳定,不因状态变化而跳动);
 * - 每列垂直居中(视觉平衡,避免长列与短列顶端对齐后右半边大片空白);
 * - 环防御:校验层已拒环,这里遇到环按 0 处理,绝不无限递归。
 */

/** 节点尺寸常量(评分标准:5 层 ≈ 1080px,桌面会话列宽内基本免横向滚动) */
export const GRAPH_NODE_W = 196;
export const GRAPH_COL_GAP = 34;
export const GRAPH_ROW_GAP = 14;
/** 基础高度(两行文字)+ gate 的命令行附加高度 */
export const GRAPH_BASE_H = 58;
export const GRAPH_GATE_EXTRA = 18;

export type GraphNode = {
  key: string;
  kind: string;
  phase: string;
  step: WorkflowStepView;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export type WorkflowGraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 相位(phase)按首次出现序:节点左侧色条与图例共用这个序做配色 */
  phases: string[];
  width: number;
  height: number;
  /** key -> node 的直查表(状态渲染按 key 找节点) */
  byKey: Map<string, GraphNode>;
};

export function layoutWorkflowGraph(steps: readonly WorkflowStepView[]): WorkflowGraphLayout {
  const declared = new Map(steps.map((s) => [s.key, s] as const));

  // 最长路径分层(带环防御)
  const depth = new Map<string, number>();
  const resolve = (key: string, stack: Set<string>): number => {
    const cached = depth.get(key);
    if (cached !== undefined) return cached;
    if (stack.has(key)) return 0;
    stack.add(key);
    const deps = (declared.get(key)?.dependsOn ?? []).filter((d) => d !== key && declared.has(d));
    const value = deps.length ? Math.max(...deps.map((d) => resolve(d, stack))) + 1 : 0;
    stack.delete(key);
    depth.set(key, value);
    return value;
  };
  for (const s of steps) resolve(s.key, new Set());

  // 同层按声明序堆叠
  const columns = new Map<number, WorkflowStepView[]>();
  for (const s of steps) {
    const d = depth.get(s.key) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), s]);
  }
  const maxLayer = Math.max(0, ...columns.keys());
  const heightOf = (s: WorkflowStepView) =>
    GRAPH_BASE_H + (s.gate ? GRAPH_GATE_EXTRA : 0) + (s.foreach ? 6 : 0);
  const columnHeight = (list: readonly WorkflowStepView[]) =>
    list.reduce((acc, s, i) => acc + heightOf(s) + (i > 0 ? GRAPH_ROW_GAP : 0), 0);
  const maxColumnH = Math.max(0, ...[...columns.values()].map(columnHeight));

  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();
  for (const [layer, list] of columns) {
    // 垂直居中:短列对长列居中,连线自然聚拢
    let y = Math.round((maxColumnH - columnHeight(list)) / 2);
    for (const step of list) {
      const node: GraphNode = {
        key: step.key,
        kind: step.kind,
        phase: step.phase || "执行",
        step,
        layer,
        x: layer * (GRAPH_NODE_W + GRAPH_COL_GAP),
        y,
        w: GRAPH_NODE_W,
        h: heightOf(step),
      };
      nodes.push(node);
      byKey.set(step.key, node);
      y += node.h + GRAPH_ROW_GAP;
    }
  }

  const edges: GraphEdge[] = [];
  for (const step of steps) {
    const to = byKey.get(step.key);
    if (!to) continue;
    for (const dep of step.dependsOn) {
      const from = byKey.get(dep);
      if (!from) continue;
      edges.push({
        from: dep,
        to: step.key,
        fromX: from.x + from.w,
        fromY: from.y + Math.round(from.h / 2),
        toX: to.x,
        toY: to.y + Math.round(to.h / 2),
      });
    }
  }

  const phases: string[] = [];
  for (const s of steps) {
    const phase = s.phase || "执行";
    if (!phases.includes(phase)) phases.push(phase);
  }

  return {
    nodes,
    edges,
    phases,
    byKey,
    width: (maxLayer + 1) * GRAPH_NODE_W + maxLayer * GRAPH_COL_GAP,
    height: maxColumnH,
  };
}

/** 相位配色(按首次出现序取模):左边条与图例色块成对定义,不各配一套色 */
export const GRAPH_PHASE_STYLES = [
  { accent: "border-l-sky-400", swatch: "bg-sky-400" },
  { accent: "border-l-violet-400", swatch: "bg-violet-400" },
  { accent: "border-l-amber-400", swatch: "bg-amber-400" },
  { accent: "border-l-emerald-400", swatch: "bg-emerald-400" },
  { accent: "border-l-rose-400", swatch: "bg-rose-400" },
  { accent: "border-l-cyan-400", swatch: "bg-cyan-400" },
] as const;

export function phaseStyle(
  phase: string,
  phases: readonly string[],
): (typeof GRAPH_PHASE_STYLES)[number] {
  const idx = Math.max(0, phases.indexOf(phase));
  return GRAPH_PHASE_STYLES[idx % GRAPH_PHASE_STYLES.length]!;
}
