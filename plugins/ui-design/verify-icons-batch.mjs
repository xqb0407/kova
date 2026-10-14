// 临时脚本：经 stdio 起 ui-design MCP server，用 list_icons 校验一批图标名是否存在
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const SERVER = path.join(import.meta.dir, "mcp/server.ts");
const proc = spawn("bun", ["run", SERVER], {
  env: { ...process.env, KOVA_WORKSPACE: import.meta.dir, BUN_BE_BUN: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
proc.stderr.on("data", () => {});
const rl = createInterface({ input: proc.stdout, terminal: false });
let nextId = 1;
const pending = new Map();
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function req(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
    pending.set(id, (msg) => { clearTimeout(t); res(msg); });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
}
const call = async (name, args) => {
  const r = await req("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return r.result.content.map((c) => c.text ?? "").join("");
};

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e", version: "0" } });
proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const names = ["signal", "wifi", "battery", "flame", "timer", "dumbbell", "moon", "home", "compass", "user", "chevron", "play", "pause", "heart"];
for (const q of names) {
  const out = await call("list_icons", { query: q });
  const hit = (m) => m[1];
  const exact = out.split(/[\s,，、|]+/).includes(q);
  console.log(`[${q}] exact=${exact} :: ${out.slice(0, 180).replace(/\n/g, " ")}`);
}
proc.kill();
