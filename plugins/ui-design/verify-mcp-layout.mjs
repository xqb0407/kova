/**
 * 端到端验证（P0：自动布局 + 图片填充 + 蒙版）：
 * 真实 stdio MCP 起服务 → 搭一张含「自动布局导航栏（grow 撑开）+ 画板图片填充 +
 * 图片填充头像 + 蒙版裁剪」的稿 → 断言重排结果 → screenshot_doc 落盘目检。
 * 用法：cd plugins/ui-design && bun run verify-mcp-layout.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const PLUGIN = import.meta.dir;
const SERVER = path.join(PLUGIN, "mcp/server.ts");
const ws = mkdtempSync(path.join(tmpdir(), "ui-design-layout-e2e-"));

// 资产：彩色头像 + 卡片底图
mkdirSync(path.join(ws, "my-assets"), { recursive: true });
const face = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#7a5cff"/><circle cx="48" cy="38" r="16" fill="#ffd166"/><ellipse cx="48" cy="78" rx="24" ry="16" fill="#ffd166"/></svg>`,
).render();
writeFileSync(path.join(ws, "my-assets", "face.png"), face.asPng());
const photo = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140"><rect width="200" height="140" fill="#0d99ff"/><circle cx="40" cy="40" r="28" fill="#ff6b6b"/><rect x="90" y="60" width="90" height="60" fill="#22c55e"/></svg>`,
).render();
writeFileSync(path.join(ws, "my-assets", "photo.png"), photo.asPng());

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

const tools = (await req("tools/list")).result.tools.map((t) => t.name);
if (!tools.includes("apply_layout")) throw new Error("tools/list 缺 apply_layout");
ok(`tools/list 含 apply_layout（共 ${tools.length} 个工具）`);

const created = await call("create_doc", { path: "app.uidesign.json", name: "布局验收", frames: [{ name: "首页", w: 390, h: 600 }] });
const homeId = json(created).frames[0].id;

// 导航栏：自动布局 between + 交叉居中，子项含 grow 撑开与图片填充头像
await call("add_nodes", {
  path: "app.uidesign.json",
  parent: homeId,
  nodes: [
    {
      id: "nav", type: "frame", name: "导航栏", x: 0, y: 0, w: 390, h: 56,
      fill: "#ffffff",
      layout: { mode: "h", main: "between", cross: "center", padding: [12, 16, 12, 16] },
    },
  ],
});
const added = json(await call("add_nodes", {
  path: "app.uidesign.json",
  parent: "nav",
  nodes: [
    { id: "menu", type: "icon", name: "菜单", icon: "menu", w: 24, h: 24, color: "#111111" },
    { id: "title", type: "text", name: "标题", text: "布局验收", w: 160, h: 24, fontSize: 18, weight: 600, color: "#111111" },
    { id: "spacer", type: "rect", name: "撑", w: 10, h: 8, grow: 1 },
    { id: "avatar", type: "ellipse", name: "头像", w: 32, h: 32, fills: [{ type: "image", src: "my-assets/face.png" }] },
  ],
}));
if (added.reflowed !== true) throw new Error("add_nodes 未自动重排");
ok("导航栏（layout h + between + grow）建好，add_nodes 自动重排");

// 重排断言：between 下 avatar 贴右缘（390-16-32=342），spacer 拿剩余
const nav = json(await call("read_doc", { path: "app.uidesign.json", nodeId: "nav" })).node;
const kids = nav.children;
const avatar = kids.find((k) => k.id === "avatar");
const spacer = kids.find((k) => k.id === "spacer");
if (avatar.x !== 342) throw new Error(`avatar.x 应 342，实际 ${avatar.x}`);
if (spacer.w <= 10) throw new Error(`grow spacer 未撑开：w=${spacer.w}`);
if (kids[0].x !== 16) throw new Error(`首项 x 应 16（padding-left），实际 ${kids[0].x}`);
ok(`重排正确：avatar.x=342 贴右缘、spacer 撑到 ${spacer.w}、首项 x=16`);

// 卡片：画板图片填充
await call("add_nodes", {
  path: "app.uidesign.json",
  parent: homeId,
  nodes: [{ id: "card", type: "frame", name: "卡片", x: 24, y: 80, w: 342, h: 160, radius: 16, fills: [{ type: "image", src: "my-assets/photo.png" }] }],
});
ok("卡片画板用图片填充（radius 16 圆角内裁）");

// 蒙版：圆形蒙版 + 照片（照片在蒙版上方，被裁成圆）
await call("add_nodes", {
  path: "app.uidesign.json",
  parent: homeId,
  nodes: [
    { id: "cmask", type: "ellipse", name: "圆蒙版", x: 24, y: 270, w: 120, h: 120, mask: true, fills: [{ type: "solid", color: "#ffffff" }] },
    { id: "cphoto", type: "rect", name: "照片", x: 60, y: 290, w: 180, h: 100, fills: [{ type: "image", src: "my-assets/photo.png" }] },
  ],
});
const grp = json(await call("group_nodes", { path: "app.uidesign.json", ids: ["cmask", "cphoto"], name: "圆形头像组" }));
if (!grp.groupId) throw new Error("group_nodes 未成组");
ok("蒙版 + 照片成组（照片被圆蒙版裁剪）");

// 截图目检
const shot = await call("screenshot_doc", { path: "app.uidesign.json", saveTo: "shots/layout.png", scale: 2 });
const png = Buffer.from(shot.content[1].data, "base64");
if (!pngSig(png)) throw new Error("PNG 非法");
writeFileSync("/tmp/mcp-layout.png", png);
ok(`截图合法（${(png.byteLength / 1024).toFixed(0)}KB）：${shot.content[0].text.split("；")[0]}`);

// 手动挪乱后 apply_layout 恢复
await call("update_nodes", { path: "app.uidesign.json", reflow: false, updates: [{ id: "menu", x: 200 }] });
const before = json(await call("read_doc", { path: "app.uidesign.json", nodeId: "nav" })).node;
if (before.children.find((k) => k.id === "menu").x === 16) throw new Error("挪动未生效？");
const rel = json(await call("apply_layout", { path: "app.uidesign.json", id: "nav" }));
if (!rel.changed) throw new Error("apply_layout 未产生改动");
const after = json(await call("read_doc", { path: "app.uidesign.json", nodeId: "nav" })).node;
if (after.children.find((k) => k.id === "menu").x !== 16) throw new Error(`apply_layout 未恢复：${after.children.find((k) => k.id === "menu").x}`);
ok("apply_layout 把挪乱的子项恢复到布局位");

// 导出工程包也走同一渲染（图片填充/蒙版进 PNG/SVG）
const exp = json(await call("export_doc", { path: "app.uidesign.json", dir: "dist/pack", format: ["png", "source"] }));
if (!exp.files.some((f) => f.kind === "png")) throw new Error("导出缺 PNG");
ok(`export_doc 工程包正常（files=${exp.files.length}）`);

proc.kill();
console.log(`\n  全部 ${step} 项通过 ✅  目检图：/tmp/mcp-layout.png`);
