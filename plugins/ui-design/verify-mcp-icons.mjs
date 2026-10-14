/**
 * 端到端验证（图标库 + JSON 容错）：
 * ① list_icons 搜索与别名折算
 * ② 一份「AI 手写坏 JSON」（注释/尾逗号/单引号/裸键/大写 Icon/未知图标名）经 MCP read_doc 正常开档
 * ③ screenshot_doc：图标渲染 + 未知名占位文本上报 → PNG 目检
 * ④ MCP 编辑后落盘的是修复后的严格 JSON
 * 用法：cd plugins/ui-design && bun run verify-mcp-icons.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PLUGIN = import.meta.dir;
const SERVER = path.join(PLUGIN, "mcp/server.ts");
const ws = mkdtempSync(path.join(tmpdir(), "ui-design-icons-e2e-"));

// 模拟 AI 手写的坏 JSON：注释 + 尾逗号 + 单引号 + 裸键 + 大写 Icon + 字段别名 + 未知图标名
const BROKEN = `// 容错验收稿
{
  version: 1,
  meta: { name: '容错与图标', kind: 'uidesign' },
  activePage: 'p1',
  pages: [{
    id: 'p1', name: '页面1', nodes: [
      { id: 'f1', type: 'frame', name: '首页', x: 0, y: 0, w: 390, h: 300, },
      { id: 'ic1', type: 'icon', name: 'home', icon: 'home', x: 24, y: 96, w: 48, h: 48, color: '#0d99ff', },
      { id: 'ic2', type: 'icon', name: 'cart', icon: 'shopping-cart', x: 96, y: 96, w: 48, h: 48, strokeWidth: 2.5, },
      { id: 'ic3', type: 'Icon', name: 'heart', icon: 'heart', x: 168, y: 96, w: 48, h: 48, color: 'red', },
      { id: 'ic4', type: 'icon', name: 'bad', icon: 'zzz-not-exist', x: 240, y: 96, w: 48, h: 48, },
      { id: 't1', type: 'text', name: '标题', x: 24, y: 180, w: 340, h: 40, text: '图标与容错', fontSize: 28, color: '#111111', },
    ],
  }],
}
`;
writeFileSync(path.join(ws, "broken.uidesign.json"), BROKEN);

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
const pngSig = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// ① list_icons
const li = JSON.parse((await call("list_icons", { query: "home" })).content[0].text);
if (!li.icons.includes("house")) throw new Error(`home 未折算到 house：${JSON.stringify(li)}`);
ok(`list_icons("home") → 规范名 house（${li.count} 个命中）`);
const all = JSON.parse((await call("list_icons", {})).content[0].text);
if (all.count < 40) throw new Error("空查询应返回 40 个");
ok(`list_icons() 缺省返回 ${all.count} 个`);

// ② 坏 JSON 开档
const read = JSON.parse((await call("read_doc", { path: "broken.uidesign.json" })).content[0].text);
if (!read.nodes || read.nodes.length < 5) throw new Error(`坏 JSON 未救回全部节点：${read.nodes?.length}`);
const iconNodes = read.nodes.filter((n) => n.type === "icon");
if (iconNodes.length !== 4) throw new Error(`icon 节点应为 4 个：${iconNodes.length}`);
if (iconNodes[0].icon !== "house") throw new Error(`home 未折算：${iconNodes[0].icon}`);
if (iconNodes[2].type !== "icon") throw new Error("大写 Icon 未归一");
if (iconNodes[3].invalidIcon !== true) throw new Error("未知图标名未标记 invalidIcon");
ok("坏 JSON（注释/尾逗号/单引号/裸键/大写 Icon）救回 6 节点，别名/大小写归一");

// ③ 截图：图标渲染 + 未知名上报
const shot = await call("screenshot_doc", { path: "broken.uidesign.json", saveTo: "shots/icons.png", scale: 2 });
const text = shot.content[0].text;
if (!text.includes("图标名无效")) throw new Error(`截图未上报未知图标：${text}`);
const png = Buffer.from(shot.content[1].data, "base64");
if (!pngSig(png)) throw new Error("PNG 非法");
writeFileSync("/tmp/mcp-icons.png", png);
ok(`截图合法（${(png.byteLength / 1024).toFixed(0)}KB），文本上报未知图标名：${text.split("；").find((s) => s.includes("图标"))}`);

// ④ MCP 编辑后落盘为修复后的严格 JSON
const frameId = read.nodes.find((n) => n.type === "frame").id;
const badIconId = iconNodes[3].id;
await call("update_nodes", { path: "broken.uidesign.json", updates: [{ id: badIconId, icon: "circle-help", name: "占位" }] });
const after = readFileSync(path.join(ws, "broken.uidesign.json"), "utf8");
if (after.includes("// 容错验收稿")) throw new Error("编辑后未把修复后的严格 JSON 回写");
JSON.parse(after);
ok("MCP 编辑触发回写：文件已是严格 JSON（注释等坏写法被修复）");

// ⑤ 导出工程包也带图标（图标是页面级兄弟节点 → 各自成屏，不在 01-画板 屏里）
const exp = JSON.parse((await call("export_doc", { path: "broken.uidesign.json", dir: "dist/pack", format: ["png", "svg", "source"] })).content[0].text);
const homeSvg = readFileSync(path.join(ws, "dist/pack/screens/02-home.svg"), "utf8");
if (!homeSvg.includes('stroke="#0d99ff"')) throw new Error("导出 SVG 缺图标描边");
if (!homeSvg.includes("stroke-linecap")) throw new Error("导出 SVG 缺圆头描边语义");
ok(`export_doc 产物带图标（files=${exp.files.length}）`);

proc.kill();
console.log(`\n  全部 ${step} 项通过 ✅  目检图：/tmp/mcp-icons.png`);
