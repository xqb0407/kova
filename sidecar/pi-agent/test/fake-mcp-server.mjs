// 测试夹具：最小 stdio MCP 服务器（NDJSON over stdin/stdout）。
// 覆盖 manager 集成测试所需的行为面：分页 tools/list、文本回显、isError、
// 环境变量可见性检查、以及按参数自杀（onclose 重连路径）。
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const tools = [
  {
    name: "echo",
    description: "echo back the text argument",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  {
    name: "fail",
    description: "always returns isError",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "env_check",
    description: "report selected env visibility inside the child process",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crash",
    description: "exit the server process (transport death)",
    inputSchema: { type: "object", properties: {} },
  },
];

const page2Tools = [
  {
    name: "page2_a",
    description: "second page tool A",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "page2_b",
    description: "second page tool B",
    inputSchema: { type: "object", properties: {} },
  },
];

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || m.id === undefined) return; // notifications 不应答
  switch (m.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1" },
        },
      });
      break;
    case "tools/list":
      if (m.params?.cursor === "p2") {
        send({ jsonrpc: "2.0", id: m.id, result: { tools: page2Tools } });
      } else {
        send({ jsonrpc: "2.0", id: m.id, result: { tools, nextCursor: "p2" } });
      }
      break;
    case "tools/call": {
      const name = m.params?.name;
      const args = m.params?.arguments ?? {};
      if (name === "echo") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] },
        });
      } else if (name === "fail") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: { content: [{ type: "text", text: "boom" }], isError: true },
        });
      } else if (name === "env_check") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  declared: process.env.MCP_FAKE_DECLARED ?? null,
                  secret: process.env.PI_MCP_TEST_SECRET ?? null,
                  pathPresent: typeof process.env.PATH === "string",
                }),
              },
            ],
          },
        });
      } else if (name === "crash") {
        process.exit(1);
      } else {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } });
      }
      break;
    }
    case "ping":
      // MCP_FAKE_NO_PING=1 模拟不支持 ping 的老服务器（-32601，探测豁免路径）；
      // MCP_FAKE_PING_ERROR=1 模拟 ping 明确报错（非 -32601，探测失败断开路径）
      if (process.env.MCP_FAKE_NO_PING) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not supported" } });
      } else if (process.env.MCP_FAKE_PING_ERROR) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "ping rejected" } });
      } else {
        send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32601, message: "method not supported" },
      });
  }
});
