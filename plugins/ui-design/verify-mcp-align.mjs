/**
 * 端到端验证（对齐第一批：混合模式 + 翻转 + wrap + HUG + Dev Mode code 导出）。
 * 用法：cd plugins/ui-design && bun run verify-mcp-align.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PLUGIN = import.meta.dir;
const SERVER = path.join(PLUGIN, "mcp/server.ts");
const ws = mkdtempSync(path.join(tmpdir(), "ui-design-align-e2e-"));

let nextId = 1;
const pending = new Map();
const proc = spawn(process.execPath, ["run", SERVER], {
  env: { ...process.env, KOVA_WORKSPACE: ws, BUN_BE_BUN: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.on("data", () => {});
const rl = createInterface({ input: proc.stdout, terminal: false });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m && m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

function req(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 30000);
    pending.set(id, (msg) => {
      clearTimeout(t);
      res(msg);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
}

let step = 0;
const ok = (s) => console.log(`  ✅ ${++step}. ${s}`);
const call = async (name, args) => {
  const r = await req("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name} 协议错误：${r.error.message}`);
  if (r.result.isError) throw new Error(`${name} 工具错误：${r.result.content[0].text}`);
  return r.result;
};
const json = (res) => JSON.parse(res.content[0].text);
const pngSig = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const created = await call("create_doc", { path: "a.uidesign.json", name: "对齐验收", frames: [{ name: "首页", w: 400, h: 420 }] });
const homeId = json(created).frames[0].id;

// ① 混合模式：两圆叠加，上层 multiply
await call("add_nodes", {
  path: "a.uidesign.json",
  parent: homeId,
  nodes: [
    { id: "c1", type: "ellipse", name: "底圆", x: 24, y: 24, w: 120, h: 120, fill: "#22c55e" },
    { id: "c2", type: "ellipse", name: "顶圆", x: 100, y: 60, w: 120, h: 120, fill: "#3b82f6", blendMode: "multiply" },
  ],
});
const c2 = json(await call("read_doc", { path: "a.uidesign.json", nodeId: "c2" })).node;
if (c2.blendMode !== "multiply") throw new Error(`blendMode 未落库：${c2.blendMode}`);
ok("混合模式 multiply 落库（read_doc 可见）");

// ② 翻转：箭头 flipX（不对称形状，翻转可见）
await call("add_nodes", {
  path: "a.uidesign.json",
  parent: homeId,
  nodes: [{ id: "arr", type: "arrow", name: "箭头", x: 260, y: 40, w: 110, h: 60, dir: 0, strokes: [{ color: "#f59e0b", width: 4 }] }],
});
await call("update_nodes", { path: "a.uidesign.json", updates: [{ id: "arr", flipX: true }] });
const arr = json(await call("read_doc", { path: "a.uidesign.json", nodeId: "arr" })).node;
if (!arr.flipX) throw new Error("flipX 未落库");
ok("箭头 flipX 落库");

// ③ wrap + HUG：标签流（220 宽放不下 3 个 90 宽标签 → 折行；画板随内容收缩）
await call("add_nodes", {
  path: "a.uidesign.json",
  parent: homeId,
  nodes: [{
    id: "chips", type: "frame", name: "标签流", x: 24, y: 210, w: 220, h: 40,
    fill: "#f4f4f5", radius: 12,
    layout: { mode: "h", gap: 8, padding: 8, wrap: true, hug: "both" },
  }],
});
await call("add_nodes", {
  path: "a.uidesign.json",
  parent: "chips",
  nodes: [
    { type: "rect", name: "标签1", w: 90, h: 28, radius: 14, fill: "#0d99ff" },
    { type: "rect", name: "标签2", w: 90, h: 28, radius: 14, fill: "#22c55e" },
    { type: "rect", name: "标签3", w: 90, h: 28, radius: 14, fill: "#f59e0b" },
  ],
});
const chips = json(await call("read_doc", { path: "a.uidesign.json", nodeId: "chips" })).node;
if (chips.w !== 220) throw new Error(`wrap 下 hug 主轴失效，宽应保持 220：${chips.w}`);
if (chips.h !== 80) throw new Error(`hug 交叉轴高应 80（8+28+8+28+8+8）实际 `);
const k2 = chips.children[2];
if (k2.x !== 8 || k2.y !== 44) throw new Error(`折行位置不对：${k2.x},${k2.y}（应 8,44）`);
ok(`wrap+HUG：宽固定 220，高随内容收缩 ${chips.h}，第三个标签折到第二行 (8,44)`);

// 截图目检（混合叠色 + 翻转箭头 + 标签流）
const shot = await call("screenshot_doc", { path: "a.uidesign.json", saveTo: "shots/align.png", scale: 2 });
const png = Buffer.from(shot.content[1].data, "base64");
if (!pngSig(png)) throw new Error("PNG 非法");
writeFileSync("/tmp/mcp-align.png", png);
ok(`截图合法（${(png.byteLength / 1024).toFixed(0)}KB）`);

// ④ Dev Mode：代码导出 + 检查器同源生成
const exp = json(await call("export_doc", { path: "a.uidesign.json", dir: "dist/dev", format: ["code", "png"] }));
const codeFile = exp.files.find((f) => f.kind === "code");
if (!codeFile) throw new Error("code 导出缺文件");
const css = readFileSync(path.join(ws, codeFile.path), "utf8");
if (!css.includes("mix-blend-mode: multiply")) throw new Error("CSS 标注缺混合模式");
if (!css.includes("scaleX(-1)")) throw new Error("CSS 标注缺翻转");
ok(`Dev Mode：${codeFile.path}（含 mix-blend-mode / scaleX(-1)）`);

// ⑤ 错误路径：非法混合模式
let threw = false;
try {
  await call("update_nodes", { path: "a.uidesign.json", updates: [{ id: "c1", blendMode: "nope" }] });
} catch (e) {
  threw = /blendMode/.test(e.message);
}
if (!threw) throw new Error("非法 blendMode 未拒绝");
ok("非法 blendMode 被拒绝并提示可用值");

proc.kill();
console.log(`\n  全部 ${step} 项通过 ✅  目检图：/tmp/mcp-align.png`);
