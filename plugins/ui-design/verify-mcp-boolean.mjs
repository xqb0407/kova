/**
 * 端到端验证（布尔运算）：圆形与矩形 union 合并 → vector 节点 → 截图目检。
 * 用法：cd plugins/ui-design && bun run verify-mcp-boolean.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PLUGIN = import.meta.dir;
const SERVER = path.join(PLUGIN, "mcp/server.ts");
const ws = mkdtempSync(path.join(tmpdir(), "ui-design-bool-e2e-"));

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

const created = await call("create_doc", { path: "b.uidesign.json", name: "布尔验收", frames: [{ name: "首页", w: 400, h: 300 }] });
const homeId = json(created).frames[0].id;

await call("add_nodes", {
  path: "b.uidesign.json",
  parent: homeId,
  nodes: [
    { id: "rect1", type: "rect", name: "方块", x: 40, y: 40, w: 140, h: 140, radius: 20, fill: "#0d99ff" },
    { id: "circ1", type: "ellipse", name: "圆", x: 120, y: 100, w: 140, h: 140, fill: "#22c55e" },
  ],
});
ok("搭好圆角方块 + 圆（重叠）");

const union = json(await call("boolean_nodes", { path: "b.uidesign.json", ids: ["rect1", "circ1"], operation: "union" }));
if (union.operation !== "union" || !union.id) throw new Error(`union 返回异常：${JSON.stringify(union).slice(0, 120)}`);
ok(`union → vector 节点 ${union.id}（${union.w}×${union.h}）`);

// 合并后只剩一个节点，原两个消失
const home = json(await call("read_doc", { path: "b.uidesign.json", nodeId: homeId })).node;
if (home.children.length !== 1 || home.children[0].type !== "vector") throw new Error("合并后节点结构不对");
ok("原两形状被替换为单个 vector（底形样式继承）");

// subtract：从合并体挖掉一个洞
await call("add_nodes", {
  path: "b.uidesign.json",
  parent: homeId,
  nodes: [{ id: "hole", type: "ellipse", name: "挖孔", x: 90, y: 70, w: 80, h: 80, fill: "#ffffff" }],
});
const sub = json(await call("boolean_nodes", { path: "b.uidesign.json", ids: [home.children[0].id, "hole"], operation: "subtract" }));
if (!sub.id) throw new Error("subtract 失败");
ok(`subtract 在合并体上挖孔 → ${sub.id}`);

const shot = await call("screenshot_doc", { path: "b.uidesign.json", saveTo: "shots/bool.png", scale: 2 });
const png = Buffer.from(shot.content[1].data, "base64");
if (!pngSig(png)) throw new Error("PNG 非法");
writeFileSync("/tmp/mcp-bool.png", png);
ok(`截图合法（${(png.byteLength / 1024).toFixed(0)}KB）`);

proc.kill();
console.log(`\n  全部 ${step} 项通过 ✅  目检图：/tmp/mcp-bool.png`);
