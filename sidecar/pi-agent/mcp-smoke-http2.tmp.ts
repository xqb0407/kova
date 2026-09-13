import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const log = (s: string) => console.log(new Date().toISOString().slice(11, 19), s);
const srv = createServer((req, res) => {
  log(`srv: ${req.method} ${req.url}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log(`srv: body=${body.slice(0, 120)}`);
    const m = JSON.parse(body || "{}");
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    };
    if (m.method === "initialize") reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }] });
    else if (m.method === "tools/call") reply({ content: [{ type: "text", text: "pong" }] });
    else if (m.method === "notifications/initialized") { res.writeHead(202); res.end(); }
    else if (m.id !== undefined) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } })); }
    else { res.writeHead(202); res.end(); }
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as { port: number }).port;
log(`listening ${port}`);
const c = new Client({ name: "smoke", version: "1" });
log("connecting...");
const timeout = setTimeout(() => { log("TIMEOUT — killing"); process.exit(2); }, 15000);
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
log("connected");
const tools = await c.listTools();
log(`tools: ${tools.tools.map((x) => x.name).join(",")}`);
const r = await c.callTool({ name: "ping", arguments: {} });
log(`call: ${(r.content as Array<{ text?: string }>)?.[0]?.text}`);
clearTimeout(timeout);
await c.close().catch(() => {});
srv.closeAllConnections?.(); srv.close();
process.exit(0);
