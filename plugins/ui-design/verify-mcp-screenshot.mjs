/**
 * 端到端验证：ui-design MCP 的 screenshot_doc 把「画布内容」渲染成 PNG 图像块。
 * 真实 stdio 子进程（bun + BUN_BE_BUN=1，与 sidecar 生产启动一致），
 * 走 initialize → create_doc/add_nodes 搭一张有渐变/中文/按钮/图片的卡 →
 * screenshot_doc，把返回的 image 块解码存盘供目检。
 * 用法：cd plugins/ui-design && bun run verify-mcp-screenshot.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const PLUGIN = import.meta.dir;
const SERVER = path.join(PLUGIN, "mcp/server.ts");
const ws = mkdtempSync(path.join(tmpdir(), "ui-design-shot-e2e-"));

// 真实位图资产（工作区相对路径），验证 image 节点内嵌
const magenta = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#e5046c"/><circle cx="100" cy="100" r="60" fill="#ffd166"/></svg>`,
).render();
writeFileSync(path.join(ws, "pic.png"), magenta.asPng());

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
  return r.result;
};
const pngSig = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const ihdr = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const tools = (await req("tools/list")).result.tools.map((t) => t.name);
if (!tools.includes("screenshot_doc")) throw new Error("tools/list 缺 screenshot_doc");
ok(`tools/list 含 screenshot_doc（共 ${tools.length} 个工具）`);

// 搭一张卡片
const created = await call("create_doc", { path: "e2e.uidesign.json", name: "截图验收", frames: [{ name: "首页", w: 390, h: 520 }] });
const frameId = JSON.parse(created.content[0].text).frames[0].id;
await call("add_nodes", {
  path: "e2e.uidesign.json",
  parent: frameId,
  nodes: [
    { type: "rect", name: "头图", x: 0, y: 0, w: 390, h: 160, fills: [{ type: "linear", angle: 135, stops: [{ at: 0, color: "#7a5cff" }, { at: 1, color: "#0d99ff" }] }] },
    { type: "text", name: "标题", x: 24, y: 40, w: 342, h: 34, text: "视觉自检", size: 28, weight: 700, color: "#ffffff" },
    { type: "text", name: "副标题", x: 24, y: 92, w: 342, h: 24, text: "MCP 把画布内容渲染成图给你看", size: 15, color: "rgba(255,255,255,0.85)" },
    { type: "image", name: "徽标", x: 24, y: 190, w: 96, h: 96, src: "pic.png", radius: 20, fit: "cover" },
    { type: "text", name: "正文", x: 140, y: 190, w: 226, h: 96, text: "渐变 / 中文 / 圆角 / 位图\n都会如实反映在截图里。", size: 15, lineHeight: 1.5, color: "#111111" },
    { type: "ellipse", name: "点", x: 24, y: 310, w: 16, h: 16, fill: "#22c55e" },
    { type: "arrow", name: "箭头", x: 200, y: 300, w: 120, h: 40, dir: 0, stroke: { color: "#f59e0b", width: 3 } },
    { type: "rect", name: "按钮", x: 24, y: 440, w: 342, h: 48, radius: 24, fill: "#0d99ff" },
    { type: "text", name: "按钮字", x: 24, y: 440, w: 342, h: 48, text: "开始自检", size: 16, weight: 700, color: "#ffffff", align: "center", vAlign: "middle" },
  ],
});
ok("搭好含渐变/中文/位图/形状/按钮的卡片");

// 全页截图（默认当前页全部可见顶层节点）
const full = await call("screenshot_doc", { path: "e2e.uidesign.json", scale: 2, maxDim: 1200 });
const [t0, img0] = full.content;
if (t0.type !== "text" || img0.type !== "image" || img0.mimeType !== "image/png") throw new Error(`返回块结构不对：${JSON.stringify(full.content).slice(0, 120)}`);
const png = Buffer.from(img0.data, "base64");
if (!pngSig(png)) throw new Error("PNG 签名不符");
const size = ihdr(png);
if (size.w > 1201 || size.h > 1201) throw new Error(`超出 maxDim：${JSON.stringify(size)}`);
writeFileSync("/tmp/mcp-shot-full.png", png);
ok(`全页截图合法 PNG ${size.w}×${size.h}（${(png.byteLength / 1024).toFixed(0)}KB）：${t0.text}`);
if (png.byteLength >= 2 * 1024 * 1024) throw new Error("超 2MiB 闸门");
ok("体积在 2MiB 内联闸门内");

// 只截头图区（子节点）：ids 过滤 + 画幅应小于全页
const sub = await call("screenshot_doc", { path: "e2e.uidesign.json", ids: [frameId], maxDim: 800 });
const subPng = Buffer.from(sub.content[1].data, "base64");
const subSize = ihdr(subPng);
if (subSize.h >= size.h) throw new Error(`子截图未更小：${subSize.h} vs ${size.h}`);
writeFileSync("/tmp/mcp-shot-dim.png", subPng);
ok(`降尺寸 maxDim 800 → ${subSize.w}×${subSize.h}`);

// 透明底
const tr = await call("screenshot_doc", { path: "e2e.uidesign.json", background: "transparent", maxDim: 400 });
if (!pngSig(Buffer.from(tr.content[1].data, "base64"))) throw new Error("透明底 PNG 非法");
ok("background:transparent 出合法 PNG");

proc.kill();
rmSync(ws, { recursive: true, force: true });
console.log(`\n全部 ${step} 步通过 🎉  目检图：/tmp/mcp-shot-full.png`);
