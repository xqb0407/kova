/**
 * Office MCP 工具测试：用临时工作区验证发现/读取/图表补丁/整档写入/长轮询。
 * 这些工具是 agent 与面板之间的文件协议，改动会直接影响协作闭环，故保留回归网。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_DEFS, type ToolCtx } from "../../mcp/tools";

const workspace = mkdtempSync(path.join(tmpdir(), "office-mcp-"));
const ctx: ToolCtx = { workspace };

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function call(name: string, args: Record<string, unknown>): unknown {
  const tool = TOOL_DEFS.find((t) => t.name === name)!;
  return tool.run(args, ctx);
}
async function callAsync(name: string, args: Record<string, unknown>): Promise<unknown> {
  return await (call(name, args) as Promise<unknown>);
}

const DECK = "季度复盘.deck.canvas.json";

function seedDeck(): void {
  const chart = {
    kind: "chart",
    id: "ch1",
    x: 640,
    y: 160,
    w: 560,
    h: 420,
    chart: "bar",
    labels: ["一月", "二月"],
    series: [
      { name: "销量", data: [12, 19] },
      { name: "退货", data: [2, 3] },
    ],
  };
  writeFileSync(
    path.join(workspace, DECK),
    JSON.stringify(
      {
        version: 2,
        meta: { name: "季度复盘", pagePreset: "16:9", kind: "deck" },
        objects: [],
        frames: [
          { id: "s1", w: 1280, h: 720, type: "slide", name: "第 1 页", elements: [{ kind: "text", id: "t1", x: 80, y: 80, w: 600, h: 80, runs: [{ text: "季度经营复盘" }] }, chart] },
          { id: "s2", w: 1280, h: 720, type: "slide", name: "第 2 页", elements: [] },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("office MCP：发现与读取", () => {
  seedDeck();

  test("list_docs：按后缀识别 deck，带版本与图表数", () => {
    const r = call("list_docs", {}) as { docs: Array<Record<string, unknown>> };
    const hit = r.docs.find((d) => String(d.path).endsWith(DECK));
    expect(hit?.kind).toBe("deck");
    expect(hit?.name).toBe("季度复盘");
    expect(hit?.frames).toBe(2);
    expect(hit?.charts).toBe(1);
    expect(typeof hit?.version).toBe("string");
  });

  test("read_doc 摘要：页框 + 元素 id/文字/图表系列名", () => {
    const r = call("read_doc", { path: DECK }) as {
      kind: string;
      frames: Array<{ id: string; elements: Array<Record<string, unknown>> }>;
    };
    expect(r.kind).toBe("deck");
    expect(r.frames.map((f) => f.id)).toEqual(["s1", "s2"]);
    const els = r.frames[0]!.elements;
    expect(els.find((e) => e.id === "t1")?.text).toBe("季度经营复盘");
    const chart = els.find((e) => e.id === "ch1") as { chart: { chart: string; series: Array<{ name: string }> } };
    expect(chart.chart.chart).toBe("bar");
    expect(chart.chart.series.map((s) => s.name)).toEqual(["销量", "退货"]);
  });

  test("read_doc view:chart：完整 ChartSpec；elementId 只取该元素", () => {
    const charts = call("read_doc", { path: DECK, view: "chart" }) as { charts: Array<Record<string, unknown>> };
    expect(charts.charts).toHaveLength(1);
    expect(charts.charts[0]?.labels).toEqual(["一月", "二月"]);
    const one = call("read_doc", { path: DECK, elementId: "ch1" }) as { element: { id: string } };
    expect(one.element.id).toBe("ch1");
  });

  test("扩展名不对 → 可操作报错", () => {
    expect(() => call("read_doc", { path: "随便.md" })).toThrow(/扩展名约定/);
  });
});

describe("office MCP：图表补丁", () => {
  seedDeck();

  test("patch_chart：更新类目/系列/堆叠变体，落盘可回读", () => {
    const r = call("patch_chart", {
      path: DECK,
      elementId: "ch1",
      labels: ["Q1", "Q2", "Q3"],
      series: [
        { name: "营收", data: [120, 156, 148] },
        { name: "成本", data: [80, 92, 88] },
      ],
      variant: "stacked",
      legend: { show: true, position: "top" },
      size: 14,
    }) as { version: string; chart: { labels: unknown } };
    expect(r.chart.labels).toEqual(["Q1", "Q2", "Q3"]);
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    const el = onDisk.frames[0].elements.find((e: { id: string }) => e.id === "ch1");
    expect(el.variant).toBe("stacked");
    expect(el.series[0].data).toEqual([120, 156, 148]);
    expect(el.legend).toEqual({ show: true, position: "top" });
    expect(el.size).toBe(14);
  });

  test("patch_chart 切散点：series.data 自动转 points（与面板同规则）", () => {
    call("patch_chart", {
      path: DECK,
      elementId: "ch1",
      chart: "scatter",
      series: [{ name: "营收", data: [3, 5] }],
    });
    const onDisk = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    const el = onDisk.frames[0].elements.find((e: { id: string }) => e.id === "ch1");
    expect(el.chart).toBe("scatter");
    expect(el.series[0].data).toEqual([]);
    expect(el.series[0].points).toEqual([{ x: 1, y: 3 }, { x: 2, y: 5 }]);
  });

  test("不再支持的类型/超限数据 → 拒绝且不改文件", () => {
    const before = readFileSync(path.join(workspace, DECK), "utf8");
    expect(() => call("patch_chart", { path: DECK, elementId: "ch1", chart: "pyramid" })).toThrow(/chart 类型不支持/);
    expect(() =>
      call("patch_chart", {
        path: DECK,
        elementId: "ch1",
        series: Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, data: [1] })),
      }),
    ).toThrow(/最多 10 个/);
    expect(readFileSync(path.join(workspace, DECK), "utf8")).toBe(before);
  });

  test("元素 id 不存在 → 提示先读取", () => {
    expect(() => call("patch_chart", { path: DECK, elementId: "nope", labels: ["x"] })).toThrow(/图表元素不存在/);
  });
});

describe("office MCP：整档写入与长轮询", () => {
  test("write_doc：sheet 需保留 sheets；写后可读摘要", () => {
    const sheet = {
      name: "预算",
      sheetOrder: ["s1"],
      sheets: { s1: { id: "s1", name: "汇总", rowCount: 4, columnCount: 3, cellData: { "0": { "0": { v: "科目" }, "1": { v: "Q2" } }, "1": { "0": { v: "营收" }, "1": { v: 120 } } } } },
    };
    call("write_doc", { path: "预算.sheet.univer.json", doc: sheet });
    const r = call("read_doc", { path: "预算.sheet.univer.json" }) as {
      kind: string;
      sheets: Array<{ id: string; name: string; filledCells: number }>;
    };
    expect(r.kind).toBe("sheet");
    expect(r.sheets[0]?.name).toBe("汇总");
    expect(r.sheets[0]?.filledCells).toBe(4);
    expect(() => call("write_doc", { path: "坏.sheet.univer.json", doc: { name: "x" } })).toThrow(/sheets/);
  });

  test("watch_doc：since 过期 → 立即返回当前摘要；无变更 → 超时", async () => {
    const r = (await callAsync("watch_doc", { path: DECK, since: "stale", timeoutMs: 2000 })) as {
      changed: boolean;
      version: string;
    };
    expect(r.changed).toBe(true);
    expect(typeof r.version).toBe("string");
    const idle = (await callAsync("watch_doc", { path: DECK, since: r.version, timeoutMs: 1200 })) as {
      changed: boolean;
      timedOut?: boolean;
    };
    expect(idle.changed).toBe(false);
    expect(idle.timedOut).toBe(true);
  });

  test("watch_doc：写盘后返回变更（面板 → agent 通道）", async () => {
    const first = call("read_doc", { path: DECK }) as { version: string };
    const pending = callAsync("watch_doc", { path: DECK, since: first.version, timeoutMs: 5000 }) as Promise<{
      changed: boolean;
      version: string;
      frames: unknown[];
    }>;
    await new Promise((r) => setTimeout(r, 500));
    const doc = JSON.parse(readFileSync(path.join(workspace, DECK), "utf8"));
    doc.meta.name = "季度复盘 · 修订";
    writeFileSync(path.join(workspace, DECK), JSON.stringify(doc, null, 2), "utf8");
    const r = await pending;
    expect(r.changed).toBe(true);
    expect(r.version).not.toBe(first.version);
    expect(r.frames).toHaveLength(2);
  });
});
