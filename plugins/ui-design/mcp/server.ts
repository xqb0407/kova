/**
 * UI 设计画布 MCP server（stdio，NDJSON JSON-RPC 2.0）。
 *
 * 由本插件的 .mcp.json 声明，sidecar 用应用内置 JS/TS 运行时启动
 * （`${BUN}` + `BUN_BE_BUN=1`：开发态是 bun，打包态是 pi-agent 二进制本身，
 * 用户机器无需预装 node/bun；见 sidecar src/mcp/mcp-config.ts 的插件层展开）。
 *
 * 只实现 MCP 的 tools 面：initialize / notifications.initialized / ping /
 * tools/list / tools/call。stdout 只写协议行，日志一律走 stderr。
 * 工作区根经环境变量 KOVA_WORKSPACE 传入（.mcp.json 里 `${WORKSPACE}` 展开）。
 */
import { createInterface } from "node:readline";
import { TOOL_DEFS, type ToolCtx } from "./tools";

const SERVER_NAME = "ui-design";
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
  process.stderr.write(`[ui-design-mcp] ${text}\n`);
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
    const message2 = err instanceof Error ? err.message : String(err);
    log(`处理失败：${err instanceof Error ? err.stack ?? message2 : message2}`);
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
          "UI 设计画布（*.uidesign.json）控制面：先 list_docs / read_doc 了解现状拿 id，" +
          "再用 add_nodes / update_nodes / stack_nodes / align_nodes / group_nodes 等结构化修改。" +
          "改动直接落盘，打开的面板约半秒内自动刷新。\n" +
          "重复结构（列表行/卡片网格/导航项/表格行）用 run_design_script：写一段 JS，用 " +
          "I(parentId, spec)/U(id, patch) 记录操作，支持循环——比手写 N 段近似 JSON 稳得多。\n" +
          "收尾闭环：lint_doc 拿到带 nodeId 与 suggestion 的问题清单（对比度、AI 三卡套路、满屏圆角卡片、" +
          "紫渐变光晕、触控区过小、内容被裁…）改到 error/warning 归零，再用 screenshot_doc 把画布渲成 PNG " +
          "直接看效果做视觉自检（非屏幕截图，截的是文档内容；saveTo 可顺带落盘）。" +
          "lint 管「有毛病」，截图管「不好看」，两者配套。\n" +
          "定稿交付用 export_doc 导出多文件工程包（源档副本 + 逐画板 PNG/SVG + 外链 assets/ + " +
          "index.html 原型 + manifest.json），返回全部静态文件路径清单。",
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
        // run 可返回 Promise（run_design_script 要等沙箱 worker），必须 await 后再判形态
        const payload = await tool.run(args, ctx);
        // 截图类工具返回 { mcpContent }：text/image 内容块原样透传
        // （image 块经 sidecar 摘图与 2MiB/白名单闸门上屏，其余工具仍是 JSON 文本）
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          Array.isArray((payload as { mcpContent?: unknown }).mcpContent)
        ) {
          reply(id, { content: (payload as { mcpContent: unknown[] }).mcpContent });
          return;
        }
        reply(id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply(id, { content: [{ type: "text", text: `错误：${message}` }], isError: true });
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
