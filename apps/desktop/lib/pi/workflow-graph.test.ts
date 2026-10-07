import { describe, expect, test } from "bun:test";
import type { WorkflowStepView } from "@/lib/pi/pi-workflow";
import {
  GRAPH_BASE_H,
  GRAPH_GATE_EXTRA,
  layoutWorkflowGraph,
} from "@/lib/pi/workflow-graph";

/**
 * 编排图布局(纯函数):最长路径分层 + 同层垂直堆叠 + 连线端点。
 * 这几条是「图不能画错」的底线:依赖必须先于被依赖者、同层不重叠、边都从左到右。
 */

const step = (key: string, dependsOn: string[] = [], extra: Partial<WorkflowStepView> = {}) =>
  ({ key, kind: "delegate", title: `步骤 ${key}`, dependsOn, ...extra }) as WorkflowStepView;

describe("工作流编排图布局", () => {
  test("链式依赖:逐层递增(0,1,2),边全部从左指向右", () => {
    const layout = layoutWorkflowGraph([step("a"), step("b", ["a"]), step("c", ["b"])]);
    const layer = (k: string) => layout.byKey.get(k)!.layer;
    expect([layer("a"), layer("b"), layer("c")]).toEqual([0, 1, 2]);
    for (const e of layout.edges) {
      expect(e.fromX).toBeLessThan(e.toX);
    }
  });

  test("菱形:两个分支同层并行,汇点取最长路径(不是最短)", () => {
    const layout = layoutWorkflowGraph([
      step("root"),
      step("left", ["root"]),
      step("right", ["root"]),
      step("join", ["left", "right"]),
    ]);
    const layer = (k: string) => layout.byKey.get(k)!.layer;
    expect(layer("left")).toBe(layer("right"));
    expect(layer("left")).toBe(1);
    expect(layer("join")).toBe(2);
  });

  test("同层节点垂直不重叠,且按声明序排列", () => {
    const layout = layoutWorkflowGraph([step("root"), step("a", ["root"]), step("b", ["root"]), step("c", ["root"])]);
    const column = layout.nodes.filter((n) => n.layer === 1);
    expect(column.map((n) => n.key)).toEqual(["a", "b", "c"]);
    for (let i = 1; i < column.length; i++) {
      const prev = column[i - 1]!;
      const cur = column[i]!;
      expect(cur.y).toBeGreaterThanOrEqual(prev.y + prev.h);
    }
  });

  test("gate 节点更高(带命令行),foreach 节点也高一档", () => {
    const layout = layoutWorkflowGraph([
      step("g", [], { kind: "gate", gate: { command: "pnpm", args: ["test"] } }),
      step("f", [], { foreach: { from: "g" } }),
    ]);
    expect(layout.byKey.get("g")!.h).toBe(GRAPH_BASE_H + GRAPH_GATE_EXTRA);
    expect(layout.byKey.get("f")!.h).toBe(GRAPH_BASE_H + 6);
    expect(layout.byKey.get("g")!.h).toBeGreaterThan(layout.byKey.get("f")!.h);
  });

  test("未知依赖被忽略(不生成悬空边);环不死循环", () => {
    const layout = layoutWorkflowGraph([step("a", ["nope"]), step("b", ["a"])]);
    expect(layout.edges).toHaveLength(1);
    const cyclic = layoutWorkflowGraph([step("x", ["y"]), step("y", ["x"])]);
    expect(cyclic.nodes).toHaveLength(2);
  });

  test("相位序:按首次出现去重,供色条与图例共用", () => {
    const layout = layoutWorkflowGraph([
      step("a", [], { phase: "调研" }),
      step("b", [], { phase: "质检" }),
      step("c", [], { phase: "调研" }),
    ]);
    expect(layout.phases).toEqual(["调研", "质检"]);
  });

  test("宽度随层数增长;空剧本不炸", () => {
    const one = layoutWorkflowGraph([step("a")]);
    const two = layoutWorkflowGraph([step("a"), step("b", ["a"])]);
    expect(two.width).toBeGreaterThan(one.width);
    expect(layoutWorkflowGraph([]).nodes).toHaveLength(0);
  });
});
