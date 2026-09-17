// Streamable HTTP 冒烟:起一个最小 HTTP MCP 端点,SDK StreamableHTTPClientTransport 连接
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const m = JSON.parse(body || "{}");
    const reply = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
    if (m.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "smoke-http", version: "1" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }] });
    else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "pong" }] });
    else if (m.id !== undefined) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } })); }
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as { port: number }).port;
const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const tools = await c.listTools();
const r = await c.callTool({ name: "ping", arguments: {} });
console.log("http tools:", tools.tools.map((x) => x.name).join(","), "call:", (r.content as Array<{ text?: string }>)?.[0]?.text);
await c.close(); srv.close();
console.log("HTTP_SMOKE_OK");

process.exit(0);
