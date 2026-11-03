/**
 * Office 文档 MCP server（stdio，NDJSON JSON-RPC 2.0）。
 *
 * 由本插件根级 .mcp.json 声明，sidecar 用应用内置 JS/TS 运行时启动
 * （`${BUN}` + BUN_BE_BUN=1：用户机器无需预装 node/bun）。只实现 MCP 的 tools 面：
 * initialize / notifications.initialized / ping / tools/list / tools/call。
 * stdout 只写协议行，日志一律走 stderr。工作区根经 KOVA_WORKSPACE 传入。
 */
import { createInterface } from "node:readline";
import { TOOL_DEFS, type ToolCtx } from "./tools";

const SERVER_NAME = "office";
const SERVER_VERSION = "0.1.0";
const FALLBACK_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);

const workspace = process.env.KOVA_WORKSPACE?.trim() || process.cwd();
const ctx: ToolCtx = { workspace };

const log = (text: string): void => {
  process.stderr.write(`[office-mcp] ${text}\n`);
};

const send = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const reply = (id: unknown, result: unknown): void => {
  send({ jsonrpc: "2.0", id, result });
};

const replyError = (id: unknown, code: number, message: string): void => {
  send({ jsonrpc: "2.0", id, error: { code, message } });
};

function handle(message: Record<string, unknown>): void {
  void handleAsync(message).catch((err) => {
    const text = err instanceof Error ? err.message : String(err);
    log(`处理失败：${err instanceof Error ? err.stack ?? text : text}`);
  });
}

async function handleAsync(message: Record<string, unknown>): Promise<void> {
  const { id, method, params } = message;
  // 通知（无 id）：initialized / cancelled 等一律静默
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize": {
      const p = (params ?? {}) as Record<string, unknown>;
      const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      reply(id, {
        protocolVersion: KNOWN_PROTOCOLS.has(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Office 文档协作（幻灯片 .deck.canvas.json / 表格 .sheet.univer.json / 文档 .doc.univer.json）。\n" +
          "标准流程：list_docs / create_doc 建档 → read_doc 拿摘要（deck=页框与元素 id；sheet 可 view:cells 拿单元格矩阵；doc=段落列表）→ " +
          "局部写入优先用 patch_deck（元素/页级）、patch_sheet（A1 写值/公式）、patch_doc（段落级）、patch_chart（图表数据样式）；" +
          "整档结构大改才用 write_doc（先 read 再增量改，别凭空重写丢掉用户编辑）。\n" +
          "实时同步：watch_doc 长轮询等用户在面板上的编辑落盘后返回变更摘要；把上一步拿到的 version 传 since，循环调用即可持续跟随。\n" +
          "写入是原子落盘，宿主会立刻刷新已打开的面板；面板保存的 sheet/doc 快照是全量 Univer 格式，整档写入时必须原样保留。\n" +
          "图表类型：bar/barH/line/area/combo/scatter/bubble/pie/doughnut/radar/funnel/treemap/heatmap/gantt；" +
          "数据形状统一 labels + series（散点/气泡用 series.points，甘特用 tasks，热力图 series 名即 y 轴类目）。",
      });
      return;
    }
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case "tools/call": {
      const p = (params ?? {}) as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      const tool = TOOL_DEFS.find((t) => t.name === name);
      if (!tool) {
        replyError(id, -32602, `未知工具 "${name}"；可用：${TOOL_DEFS.map((t) => t.name).join(", ")}`);
        return;
      }
      const args =
        p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
          ? (p.arguments as Record<string, unknown>)
          : {};
      try {
        const payload = await tool.run(args, ctx);
        reply(id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        reply(id, { content: [{ type: "text", text: `错误：${text}` }], isError: true });
      }
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${String(method)}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    log("忽略无法解析的输入行");
    return;
  }
  if (!message || typeof message !== "object") return;
  handle(message as Record<string, unknown>);
});
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
