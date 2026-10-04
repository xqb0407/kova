/**
 * MCP server 协议测试：真实启动 stdio 子进程（bun 运行时 + BUN_BE_BUN=1，
 * 与 sidecar 生产启动形态一致），走 initialize → tools/list → tools/call 全链路。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDesignDoc } from "../../ui/src/doc";

const SERVER = fileURLToPath(new URL("../server.ts", import.meta.url));

let ws = "";
let proc: ChildProcess;
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function request(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin!.write(`${line}\n`);
  });
}

beforeAll(() => {
  ws = mkdtempSync(path.join(tmpdir(), "ui-design-mcp-srv-"));
  proc = spawn(process.execPath, ["run", SERVER], {
    env: { ...process.env, KOVA_WORKSPACE: ws, BUN_BE_BUN: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr!.on("data", () => {});
  const rl = createInterface({ input: proc.stdout!, terminal: false });
  rl.on("line", (line) => {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const cb = msg && msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  });
});

afterAll(() => {
  proc?.kill();
  rmSync(ws, { recursive: true, force: true });
});

describe("MCP stdio 协议", () => {
  test("initialize 回协议版本 / tools 能力 / serverInfo", async () => {
    const res = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    });
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect(res.result.serverInfo.name).toBe("ui-design");
    expect(res.result.capabilities.tools).toBeDefined();
    // 通知（无 id）不应答——写一行 initialized，后续请求照常工作
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  });

  test("tools/list：全部工具带 description 与 object schema", async () => {
    const res = await request("tools/list");
    const tools = res.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    const names = tools.map((t) => t.name);
    for (const want of ["list_docs", "read_doc", "create_doc", "add_nodes", "update_nodes", "delete_nodes", "group_nodes", "ungroup_nodes", "align_nodes", "stack_nodes", "reorder_nodes", "edit_pages", "screenshot_doc", "export_doc", "list_icons", "apply_layout"]) {
      expect(names).toContain(want);
    }
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema?.type).toBe("object");
    }
  });

  test("tools/call：create_doc + add_nodes 真落盘（与面板同一份文档模型）", async () => {
    const created = await request("tools/call", {
      name: "create_doc",
      arguments: { path: "srv.uidesign.json", name: "协议测试", preset: "ios-390" },
    });
    expect(created.result.isError).toBeUndefined();
    const payload = JSON.parse(created.result.content[0].text as string);
    const frameId = payload.frames[0].id as string;

    const added = await request("tools/call", {
      name: "add_nodes",
      arguments: {
        path: "srv.uidesign.json",
        parent: frameId,
        nodes: [{ type: "rect", name: "按钮", x: 24, y: 700, w: 342, h: 48, fill: "#0d99ff", radius: 24 }],
      },
    });
    expect(added.result.isError).toBeUndefined();
    const doc = parseDesignDoc(readFileSync(path.join(ws, "srv.uidesign.json"), "utf8")).doc;
    const frame = doc.pages[0]!.nodes[0]!;
    expect(frame.type).toBe("frame");
    expect("children" in frame ? frame.children.length : 0).toBe(1);
  });

  test("tools/call screenshot_doc：mcpContent 原样透传成 result.content 的 text+image 块", async () => {
    const shot = await request("tools/call", { name: "screenshot_doc", arguments: { path: "srv.uidesign.json" } });
    expect(shot.result.isError).toBeUndefined();
    const blocks = shot.result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("画布截图");
    expect(blocks[1].type).toBe("image");
    expect(blocks[1].mimeType).toBe("image/png");
    const png = Buffer.from(blocks[1].data!, "base64");
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  test("未知工具 → JSON-RPC 错误；工具内部错误 → isError 文本", async () => {
    const bad = await request("tools/call", { name: "nope", arguments: {} });
    expect(bad.error?.code).toBe(-32602);

    const fail = await request("tools/call", { name: "read_doc", arguments: { path: "ghost.uidesign.json" } });
    expect(fail.result.isError).toBe(true);
    expect(fail.result.content[0].text as string).toContain("不存在");
  });

  test("tools/call export_doc：真落盘多文件目录包并回报静态文件清单", async () => {
    const res = await request("tools/call", { name: "export_doc", arguments: { path: "srv.uidesign.json" } });
    expect(res.result.isError).toBeUndefined();
    const payload = JSON.parse(res.result.content[0].text as string);
    expect(payload.dir).toBe("srv-export");
    expect(payload.files.some((f: { kind: string }) => f.kind === "manifest")).toBe(true);
    expect(payload.files.some((f: { kind: string }) => f.kind === "png")).toBe(true);
    expect(payload.hint).toContain("srv-export/");
    const manifest = JSON.parse(readFileSync(path.join(ws, "srv-export", "manifest.json"), "utf8"));
    expect(manifest.generator).toBe("ui-design/export");
    expect(manifest.screens.length).toBe(1);
    for (const f of manifest.files) {
      expect(readFileSync(path.join(ws, f.path)).byteLength).toBe(f.bytes);
    }
  });
});
