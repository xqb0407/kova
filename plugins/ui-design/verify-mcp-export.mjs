/**
 * 端到端验证：ui-design MCP 的 export_doc 把设计档落盘成**静态文件目录包**
 * （不是单一产物）——源档副本 + 逐画板 PNG + 外链 assets/ + index.html 原型 +
 * manifest.json，并回报全部文件路径；顺带验证 screenshot_doc 的 saveTo 单图落盘。
 * 真实 stdio 子进程（bun + BUN_BE_BUN=1，与 sidecar 生产启动一致）。
 * 用法：cd plugins/ui-design && bun run verify-mcp-export.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const PLUGIN = import.meta.dir;
const SERVER = path.join(PLUGIN, "mcp/server.ts");
const ws = mkdtempSync(path.join(tmpdir(), "ui-design-export-e2e-"));

const magenta = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e5046c"/><circle cx="80" cy="80" r="48" fill="#ffd166"/></svg>`,
).render();
mkdirSync(path.join(ws, "app-assets"), { recursive: true });
writeFileSync(path.join(ws, "app-assets", "logo.png"), magenta.asPng());

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
const ihdr = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const tools = (await req("tools/list")).result.tools.map((t) => t.name);
if (!tools.includes("export_doc")) throw new Error("tools/list 缺 export_doc");
ok(`tools/list 含 export_doc（共 ${tools.length} 个工具）`);

// 两块画板 + 热点跳转 + 位图资产 + 一个隐藏画板（应被包排除）
const created = await call("create_doc", {
  path: "shop.uidesign.json",
  name: "商店验收",
  frames: [
    { name: "首页", w: 375, h: 600 },
    { name: "详情", w: 375, h: 600 },
    { name: "废稿", w: 375, h: 600 },
  ],
});
const frames = JSON.parse(created.content[0].text).frames;
const [home, detail] = frames;
await call("add_nodes", {
  path: "shop.uidesign.json",
  parent: home.id,
  nodes: [
    { type: "rect", name: "头图", x: 0, y: 0, w: 375, h: 150, fills: [{ type: "linear", angle: 135, stops: [{ at: 0, color: "#ff6b6b" }, { at: 1, color: "#f7b733" }] }] },
    { type: "text", name: "标题", x: 20, y: 20, w: 335, h: 32, text: "今日推荐", size: 26, weight: 700, color: "#ffffff" },
    { type: "image", name: "logo", x: 20, y: 180, w: 80, h: 80, src: "app-assets/logo.png", radius: 16, fit: "cover", onTap: { to: detail.id } },
    { type: "text", name: "说明", x: 120, y: 180, w: 235, h: 80, text: "点 logo 跳详情页\n（原型 index.html 里可点）", size: 15, lineHeight: 1.5, color: "#111111" },
  ],
});
await call("add_nodes", {
  path: "shop.uidesign.json",
  parent: detail.id,
  nodes: [
    { type: "rect", name: "卡", x: 16, y: 16, w: 343, h: 220, radius: 16, fill: "#f4f4f5" },
    { type: "text", name: "详情", x: 32, y: 40, w: 300, h: 28, text: "商品详情", size: 22, weight: 600, color: "#111111" },
  ],
});
await call("update_nodes", { path: "shop.uidesign.json", updates: [{ id: frames[2].id, visible: false }] });
ok("搭好两可见画板 + 热点 + 位图，并隐藏一块废稿");

// —— export_doc 默认（png/html/source）——
const res = await call("export_doc", { path: "shop.uidesign.json" });
const sum = JSON.parse(res.content[0].text);
if (sum.dir !== "shop-export") throw new Error(`目录名不对：${sum.dir}`);
if (sum.missingAssets !== 0) throw new Error(`不该有缺失资产：${sum.missingAssets}`);
if (sum.screens.join(",") !== "首页,详情") throw new Error(`逐画板清单不对：${sum.screens}`);
ok(`返回 dir=shop-export、screens=[${sum.screens}]、files=${sum.files.length} 项`);

const abs = (rel) => path.join(ws, rel);
const must = (p) => {
  if (!existsSync(abs(p))) throw new Error(`缺文件：${p}`);
  return readFileSync(abs(p));
};
// 路径清单逐项验证真实存在且字节吻合
for (const f of sum.files) {
  const buf = must(f.path);
  if (buf.byteLength !== f.bytes) throw new Error(`字节不符：${f.path} ${buf.byteLength} vs ${f.bytes}`);
}
ok("files 清单逐项真实存在、字节吻合（静态路径可引用）");

// 关键件检查
must("shop-export/shop.uidesign.json");
const png1 = must("shop-export/screens/01-首页.png");
const png2 = must("shop-export/screens/02-详情.png");
if (!pngSig(png1) || !pngSig(png2)) throw new Error("screens PNG 非法");
const s1 = ihdr(png1);
if (s1.w !== 750 || s1.h !== 1200) throw new Error(`PNG 尺寸应 375×600×2=750×1200，实际 ${JSON.stringify(s1)}`);
ok(`逐画板 PNG 合法：01 ${s1.w}×${s1.h}（高清 2x，未受内联闸门压缩）`);
const asset = must("shop-export/assets/logo.png");
if (!pngSig(asset) || asset.byteLength < 100) throw new Error("assets/logo.png 复制异常");
const html = must("shop-export/index.html").toString("utf8");
if (!html.includes("assets/logo.png")) throw new Error("index.html 缺外链 assets/logo.png");
if (html.includes("data:image")) throw new Error("index.html 里不该有 dataURL 内联");
if (!html.includes("href=\"#s-")) throw new Error("index.html 缺热点跳转链接");
ok("index.html：位图外链 assets/、无 dataURL、含热点跳转");
const hidden = existsSync(abs("shop-export/screens/03-废稿.png"));
if (hidden) throw new Error("隐藏画板不该入包");
ok("隐藏画板被排除");

const manifest = JSON.parse(must("shop-export/manifest.json").toString("utf8"));
if (manifest.generator !== "ui-design/export" || manifest.doc !== "shop.uidesign.json") throw new Error("manifest 头不对");
if (manifest.files.length !== sum.files.length - 1) throw new Error("manifest 应列除自身外全部文件");
for (const f of manifest.files) must(f.path);
ok(`manifest.json 路径清单自洽（${manifest.files.length} 项，不含自身）`);
writeFileSync("/tmp/mcp-export-bundle.txt", JSON.stringify(sum.files, null, 2));

// —— 选项：format=svg + 自定义 dir + scale ——
const v = JSON.parse((await call("export_doc", { path: "shop.uidesign.json", dir: "dist/svg-kit", format: ["svg", "source"], scale: 1 })).content[0].text);
if (v.dir !== "dist/svg-kit") throw new Error(`自定义 dir 未生效：${v.dir}`);
const svg1 = must("dist/svg-kit/screens/01-首页.svg").toString("utf8");
if (!svg1.trimStart().startsWith("<svg") || !svg1.includes("data:image")) throw new Error("screen svg 应自包含");
ok("format=[svg,source]+自定义 dir：逐画板自包含矢量落盘");

// —— screenshot saveTo：单图顺带落盘 ——
const shot = await call("screenshot_doc", { path: "shop.uidesign.json", saveTo: "shots/首页预览.png", maxDim: 800 });
const txt = shot.content[0].text;
if (!txt.includes("已保存到 shots/首页预览.png")) throw new Error(`saveTo 未回报路径：${txt}`);
const saved = must("shots/首页预览.png");
if (!pngSig(saved)) throw new Error("saveTo 落盘 PNG 非法");
ok(`saveTo 单图落盘并回报：${txt.split("；").pop()}`);

// —— 错误路径 ——
let threw = false;
try {
  await call("export_doc", { path: "shop.uidesign.json", dir: "../outside" });
} catch (e) {
  threw = /越出工作区/.test(e.message);
}
if (!threw) throw new Error("越界 dir 应被拒绝");
ok("dir 越出工作区被拒绝");

console.log("\n—— 包目录树 ——");
const lines = [];
const go = (dir, pfx) => {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const isDir = statSync(full).isDirectory();
    lines.push(`${pfx}${name}${isDir ? "/" : ` (${statSync(full).size}B)`}`);
    if (isDir) go(full, pfx + "  ");
  }
};
go(abs("shop-export"), "  ");
console.log(lines.join("\n"));

proc.kill();
console.log(`\n  全部 ${step} 项通过 ✅  工作区保留供目检：${ws}`);
console.log(`  目检 PNG：${abs("shop-export/screens/01-首页.png")}`);
