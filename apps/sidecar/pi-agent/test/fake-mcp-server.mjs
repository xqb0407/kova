// 测试夹具：最小 stdio MCP 服务器（NDJSON over stdin/stdout）。
// 覆盖 manager 集成测试所需的行为面：分页 tools/list、文本回显、isError、
// 环境变量可见性检查、以及按参数自杀（onclose 重连路径）。
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const ELICIT_ENABLED = process.env.MCP_FAKE_ELICIT === "1";
const APP_ENABLED = process.env.MCP_FAKE_APP === "1";

const baseTools = [
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

const TASK_ENABLED = process.env.MCP_FAKE_TASK === "1";

const taskTools = TASK_ENABLED
  ? [
      {
        name: "longjob",
        description: "start a long-running job (task-augmented)",
        inputSchema: { type: "object", properties: {} },
        execution: { taskSupport: "required" },
      },
    ]
  : [];

const appTools = APP_ENABLED
  ? [
      {
        name: "app_echo",
        description: "tool with an MCP App UI",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        _meta: {
          ui: { resourceUri: "ui://fake/app.html", visibility: ["model", "app"] },
        },
      },
      {
        name: "app_refresh",
        description: "app-only refresh action",
        inputSchema: { type: "object", properties: {} },
        _meta: {
          ui: { resourceUri: "ui://fake/app.html", visibility: ["app"] },
        },
      },
    ]
  : [];

const tools = [
  ...(ELICIT_ENABLED
    ? [
        ...baseTools,
        {
          name: "elicit",
          description: "ask the client for structured input",
          inputSchema: { type: "object", properties: {} },
        },
      ]
    : baseTools),
  ...appTools,
  ...taskTools,
];

// task 台账：taskId → { tool, done, resultText, cancelled }
const tasks = new Map();

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

// resources/list 分两页；templates 单页。URL 里刻意带 query，测审计 URI 去敏。
const resourcesPage1 = [
  {
    uri: "file:///fake/readme.md?token=secret",
    name: "readme",
    title: "Fake README",
    description: "project readme",
    mimeType: "text/markdown",
    size: 18,
  },
];
const resourcesPage2 = [
  {
    uri: "file:///fake/config.json",
    name: "config",
    description: "project config",
    mimeType: "application/json",
  },
];
const resourceTemplates = [
  {
    uriTemplate: "file:///fake/{path}",
    name: "fake-file",
    description: "any fake file",
    mimeType: "text/plain",
  },
];

// prompts/list 分两页；参数声明覆盖 required/optional。
const promptsPage1 = [
  {
    name: "summarize",
    title: "Summarize",
    description: "summarize a topic",
    arguments: [{ name: "topic", description: "topic to summarize", required: true }],
  },
];
const promptsPage2 = [
  {
    name: "review",
    description: "review a file",
    arguments: [{ name: "file", description: "file path" }],
  },
];

const rl = createInterface({ input: process.stdin, terminal: false });
/** elicit 工具发出的 server→client 请求 id；客户端回包时用它结算原工具调用 */
let pendingElicitCallId = null;
rl.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || m.id === undefined) return; // notifications 不应答
  // elicitation/create 的客户端回包（无 method，带 result/error）
  if (m.id === "srv-elicit-1" && m.method === undefined && pendingElicitCallId !== null) {
    const result = m.error
      ? { content: [{ type: "text", text: `elicit-error:${m.error.message ?? "unknown"}` }], isError: true }
      : {
          content: [
            {
              type: "text",
              text: JSON.stringify(m.result ?? { action: "cancel" }),
            },
          ],
        };
    send({ jsonrpc: "2.0", id: pendingElicitCallId, result });
    pendingElicitCallId = null;
    return;
  }
  switch (m.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            ...(TASK_ENABLED
              ? { tasks: { requests: { tools: { call: {} } } } }
              : {}),
          },
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
    case "resources/list":
      if (m.params?.cursor === "r2") {
        send({ jsonrpc: "2.0", id: m.id, result: { resources: resourcesPage2 } });
      } else {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: { resources: resourcesPage1, nextCursor: "r2" },
        });
      }
      break;
    case "resources/templates/list":
      send({ jsonrpc: "2.0", id: m.id, result: { resourceTemplates } });
      break;
    case "resources/read": {
      const uri = m.params?.uri;
      if (uri === "file:///fake/readme.md?token=secret") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: "# Fake\nhello",
              },
            ],
          },
        });
      } else if (uri === "file:///fake/config.json") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: '{"ok":true}',
              },
            ],
          },
        });
      } else if (uri === "ui://fake/app.html" && APP_ENABLED) {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            contents: [
              {
                uri,
                mimeType: "text/html;profile=mcp-app",
                text: "<!doctype html><html><body><h1>Fake MCP App</h1></body></html>",
                _meta: {
                  ui: {
                    prefersBorder: true,
                    csp: { connectDomains: ["https://api.example.com"] },
                  },
                },
              },
            ],
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32602, message: "unknown resource" },
        });
      }
      break;
    }
    case "prompts/list":
      if (m.params?.cursor === "p2") {
        send({ jsonrpc: "2.0", id: m.id, result: { prompts: promptsPage2 } });
      } else {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: { prompts: promptsPage1, nextCursor: "p2" },
        });
      }
      break;
    case "prompts/get": {
      const name = m.params?.name;
      const args = m.params?.arguments ?? {};
      if (name === "summarize") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            description: "summarize a topic",
            messages: [
              {
                role: "user",
                content: { type: "text", text: `Summarize ${args.topic ?? "(missing)"}` },
              },
            ],
          },
        });
      } else if (name === "review") {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            messages: [
              {
                role: "user",
                content: { type: "text", text: `Review ${args.file ?? "(missing)"}` },
              },
            ],
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32602, message: "unknown prompt" },
        });
      }
      break;
    }
    case "tools/call": {
      const name = m.params?.name;
      const args = m.params?.arguments ?? {};
      if (name === "echo") {
        // 特例 IMG：附带合法 1×1 PNG image 块，测 MCP 图片透传（工具数不变）
        if (args.text === "IMG") {
          send({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              content: [
                { type: "text", text: "echo:IMG" },
                {
                  type: "image",
                  mimeType: "image/png",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              ],
            },
          });
          break;
        }
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
      } else if (name === "app_echo" && APP_ENABLED) {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            content: [{ type: "text", text: `app:${args.text ?? ""}` }],
            structuredContent: { text: args.text ?? "", count: 1 },
          },
        });
      } else if (name === "app_refresh" && APP_ENABLED) {
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            content: [{ type: "text", text: "refreshed" }],
            structuredContent: { refreshed: true },
          },
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
                  cwd: process.cwd(),
                  pluginRoot: process.env.PLUGIN_ROOT ?? null,
                  pluginData: process.env.PLUGIN_DATA ?? null,
                  passthrough: process.env.MCP_FAKE_PASSTHROUGH ?? null,
                }),
              },
            ],
          },
        });
      } else if (name === "elicit" && ELICIT_ENABLED) {
        pendingElicitCallId = m.id;
        send({
          jsonrpc: "2.0",
          id: "srv-elicit-1",
          method: "elicitation/create",
          params: {
            message: "Need input",
            requestedSchema: {
              type: "object",
              properties: {
                name: { type: "string", title: "Name", description: "Your name" },
                confirm: { type: "boolean", title: "Confirm" },
              },
              required: ["name", "confirm"],
            },
          },
        });
      } else if (name === "longjob" && TASK_ENABLED) {
        const taskId = `task-${Object.keys(tasks).length + 1}`;
        tasks.set(taskId, { tool: "longjob", done: args.mode !== "hang", resultText: `job:${args.mode ?? "ok"}`, cancelled: false });
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            task: {
              taskId,
              status: args.mode === "hang" ? "working" : "completed",
              ttl: 600000,
              createdAt: new Date().toISOString(),
              lastUpdatedAt: new Date().toISOString(),
              ...(args.mode !== "hang" ? { statusMessage: "job finished" } : {}),
            },
          },
        });
      } else if (name === "crash") {
        process.exit(1);
      } else {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } });
      }
      break;
    }
    case "tasks/get": {
      const t = tasks.get(m.params?.taskId);
      if (!t) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "task not found" } });
        break;
      }
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          taskId: m.params.taskId,
          status: t.cancelled ? "cancelled" : t.done ? "completed" : "working",
          ttl: 600000,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          ...(t.done && !t.cancelled ? { statusMessage: "job finished" } : {}),
        },
      });
      break;
    }
    case "tasks/result": {
      const t = tasks.get(m.params?.taskId);
      if (!t || !t.done || t.cancelled) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "task not completed" } });
        break;
      }
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: { content: [{ type: "text", text: t.resultText }] },
      });
      break;
    }
    case "tasks/cancel": {
      const t = tasks.get(m.params?.taskId);
      if (!t) {
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "task not found" } });
        break;
      }
      t.cancelled = true;
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          taskId: m.params.taskId,
          status: "cancelled",
          ttl: 600000,
          createdAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
        },
      });
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
