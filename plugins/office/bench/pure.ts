/**
 * Office 性能基准（纯函数层）：用合成大档量出「打开/渲染准备/换肤/MCP 读写」的耗时。
 *
 * 用法：bun bench/pure.mjs            （默认 200 页 deck + 5 万格 sheet）
 *       PAGES=500 CELLS=200000 bun bench/pure.mjs
 *
 * 数字用于横向对比优化前后（同一台机器、同一版本依赖下），不是绝对性能承诺。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDoc, serializeDoc } from "../ui/src/doc.ts";
import { buildSlideScene } from "../ui/src/leafer/scene.ts";
import { rethemeDoc } from "../ui/src/editor/retheme.ts";
import { sanitizeSheetSnapshot } from "../ui/src/sheet/sanitize.ts";
import { TEMPLATE_THEMES } from "../ui/src/templates.ts";
import { TOOL_DEFS } from "../mcp/tools.ts";

const PAGES = Number(process.env.PAGES ?? 200);
const ROWS = Number(process.env.ROWS ?? 200);
const COLS = Number(process.env.COLS ?? 250);

const now = () => performance.now();
const ms = (v) => `${v.toFixed(1)}ms`;
function bench(label, fn, runs = 5) {
  fn(); // warmup
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    fn();
    times.push(now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  console.log(`  ${label.padEnd(42)} median ${ms(med).padStart(9)}  (min ${ms(times[0])}, max ${ms(times[times.length - 1])})`);
  return med;
}

/* ---------------- 合成 200 页 deck ---------------- */

function makeDeck() {
  const frames = [];
  for (let p = 0; p < PAGES; p++) {
    const els = [];
    // 标题
    els.push({
      kind: "text", id: `t${p}a`, x: 80, y: 60, w: 900, h: 70,
      runs: [
        { text: `第 ${p + 1} 页标题`, bold: true, size: 40, color: "#111827" },
        { text: " · 副标题", size: 24, color: "#6b7280" },
      ],
      align: "left", vAlign: "middle", lineHeight: 1.2,
    });
    // 四段正文
    for (let i = 0; i < 4; i++) {
      els.push({
        kind: "text", id: `t${p}b${i}`, x: 80, y: 170 + i * 110, w: 700, h: 90,
        runs: [{ text: `要点 ${i + 1}：这是用于性能基准的合成正文，包含中英文混排 Data ${p}-${i}，长度约八十个字符，用于触发行内排版与换行计算。`, size: 20, color: "#374151" }],
        align: "left", vAlign: "top", lineHeight: 1.6,
      });
    }
    // 两个形状
    els.push({ kind: "shape", shape: "rect", id: `s${p}a`, x: 840, y: 170, w: 360, h: 200, fill: "#eef2ff", stroke: "#2563eb", strokeWidth: 2, radius: 12 });
    els.push({ kind: "shape", shape: "ellipse", id: `s${p}b`, x: 840, y: 410, w: 180, h: 180, fill: "#dcfce7", stroke: "#166534", strokeWidth: 2 });
    frames.push({
      id: `f${p}`, type: "slide", x: 0, y: p * 800, w: 1280, h: 720,
      background: p % 5 === 0 ? "#0b1526" : "#ffffff",
      notes: p % 3 === 0 ? "开场先讲结论。" : undefined,
      elements: els,
    });
  }
  return { version: 2, meta: { name: "bench", pagePreset: "16:9", kind: "deck", pageNumber: true, footer: "bench" }, objects: [], frames };
}

/* ---------------- 合成 5 万格 sheet ---------------- */

function makeSheet() {
  const cellData = {};
  for (let r = 0; r < ROWS; r++) {
    const row = {};
    row["0"] = { v: `行 ${r + 1}` };
    for (let c = 1; c < COLS; c++) {
      row[String(c)] = c % 7 === 0 ? { v: r * c } : { v: `值-${r}-${c}` };
    }
    cellData[String(r)] = row;
  }
  return {
    id: "wb-bench", name: "bench", sheetOrder: ["sh1"], styles: { s1: { bl: 1 } },
    sheets: { sh1: { id: "sh1", name: "数据", rowCount: ROWS + 50, columnCount: COLS + 10, cellData, freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 } } },
  };
}

const measure = (text, font) => ({ width: text.length * 10, ascent: 14, descent: 4 });
const sceneCtx = {
  measure,
  asset: () => ({ status: "missing" }),
  mermaid: () => ({ status: "error", message: "" }),
  svg: () => ({ status: "error", message: "" }),
  chrome: { stroke: "#e2e8f0", ink: "#1d1d1f", primary: "#166534", shadow: null },
  zoom: 0.65,
};

console.log(`\n== 合成档规模 ==`);
const deck = makeDeck();
const deckJson = serializeDoc(deck);
const sheet = makeSheet();
const sheetJson = JSON.stringify(sheet, null, 2);
console.log(`  deck: ${PAGES} 页 / ${deck.frames.reduce((n, f) => n + f.elements.length, 0)} 元素 / ${(deckJson.length / 1024).toFixed(0)} KB JSON`);
console.log(`  sheet: ${ROWS}×${COLS} = ${(ROWS * COLS / 1000).toFixed(0)}k 格 / ${(sheetJson.length / 1024 / 1024).toFixed(1)} MB JSON`);

console.log(`\n== deck 纯函数 ==`);
bench("serializeDoc（200 页）", () => serializeDoc(deck), 3);
bench("parseDoc（200 页整档载入）", () => parseDoc(JSON.parse(deckJson)), 3);
const pageSceneInput = { doc: deck, surface: "deck", positions: [{ frame: deck.frames[0], x: 0, y: 0 }], liveContainerId: null, ctx: sceneCtx };
bench("buildScene（当前页 7 元素）", () => buildSlideScene({ frame: deck.frames[0], x: 0, y: 0 }, sceneCtx, true), 20);
bench("buildScene 全档 200 页（概览最坏情况）", () => deck.frames.map((f, i) => buildSlideScene({ frame: f, x: 0, y: i * 800 }, sceneCtx, false)), 3);
bench("rethemeDoc（200 页换肤）", () => rethemeDoc(deck, TEMPLATE_THEMES[1].tokens), 3);
void buildSlideScene; void pageSceneInput;

console.log(`\n== sheet 纯函数 ==`);
bench("sanitizeSheetSnapshot（5 万格）", () => sanitizeSheetSnapshot(JSON.parse(sheetJson)), 3);
bench("JSON.stringify（面板每次落盘序列化）", () => JSON.stringify(sheet), 3);

/* ---------------- MCP 读写（真实临时工作区） ---------------- */
const ws = mkdtempSync(path.join(tmpdir(), "office-bench-"));
const ctx = { workspace: ws };
const call = (name, args) => TOOL_DEFS.find((t) => t.name === name).run(args, ctx);
writeFileSync(path.join(ws, "bench.deck.canvas.json"), deckJson);
writeFileSync(path.join(ws, "bench.sheet.univer.json"), sheetJson);
console.log(`\n== MCP（含 JSON 读写） ==`);
bench("read_doc deck summary", () => call("read_doc", { path: "bench.deck.canvas.json" }), 5);
bench("read_doc sheet summary", () => call("read_doc", { path: "bench.sheet.univer.json" }), 5);
bench("read_doc sheet view:cells A1:Z50", () => call("read_doc", { path: "bench.sheet.univer.json", view: "cells", range: "A1:Z50" }), 5);
bench("patch_sheet 单格（整档读+写）", () => call("patch_sheet", { path: "bench.sheet.univer.json", setCells: { A1: "基准" } }), 3);
bench("patch_deck element（整档读+写）", () => call("patch_deck", { path: "bench.deck.canvas.json", op: "element", elementId: "t0a", patch: { x: 81 } }), 3);
rmSync(ws, { recursive: true, force: true });
console.log("");
