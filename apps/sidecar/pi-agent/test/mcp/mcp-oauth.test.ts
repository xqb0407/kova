/**
 * MCP OAuth 2.1 流端到端：假「受保护 MCP 服务器」（401 + PRM/AS 元数据 + DCR +
 * PKCE token 端点）+ 注入的假浏览器（解析 authorize URL 后立即回跳 callback）。
 * 覆盖三条路径：未授权 → needsAuth；交互授权 → token 落盘并可用；过期 → 静默刷新。
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mcpManager } from "../../src/mcp/mcp-manager";
import { resetMcpCacheForTest } from "../../src/mcp/mcp-cache";
import { oauthStorePath, resetMcpOAuthForTest, setBrowserOpenerForTest } from "../../src/mcp/mcp-oauth";
import type { McpServerDef } from "../../src/mcp/mcp-config";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-mcp-oauth-"));
const prevOAuthPath = process.env.PI_MCP_OAUTH_PATH;
const prevCachePath = process.env.PI_MCP_CACHE_PATH;
const prevAuditPath = process.env.PI_MCP_AUDIT_PATH;

let srv: Server;
let base = ""; // http://127.0.0.1:<port>
let mcpUrl = ""; // <base>/mcp

const AUTH_CODE = "auth-code-1";

const fake = {
  /** 浏览器被拉起的次数（授权 URL 由测试桩消费） */
  browserOpens: 0,
  /** /authorize 带下来的 PKCE challenge（S256 原文） */
  challenge: null as string | null,
  validTokens: new Set<string>(["at-bootstrap-never-used"]),
  lastAuthHeader: null as string | null,
  dcrCount: 0,
  refreshCount: 0,
  /** 最近一次回跳拿到的落地页 HTML（呈现质量是验收面之一） */
  lastCallbackPage: "",
};

function resetFake() {
  fake.browserOpens = 0;
  fake.challenge = null;
  fake.validTokens = new Set<string>();
  fake.lastAuthHeader = null;
  fake.dcrCount = 0;
  fake.refreshCount = 0;
  fake.lastCallbackPage = "";
}

/** 假浏览器：模拟用户秒批准——解析 authorize URL，立刻带 code 回跳 callback */
async function fakeBrowser(url: string): Promise<boolean> {
  fake.browserOpens += 1;
  const u = new URL(url);
  const redirect = u.searchParams.get("redirect_uri");
  if (!redirect) return false;
  fake.challenge = u.searchParams.get("code_challenge");
  const cb = new URL(redirect);
  cb.searchParams.set("code", AUTH_CODE);
  const st = u.searchParams.get("state");
  if (st) cb.searchParams.set("state", st);
  const res = await fetch(cb.toString());
  fake.lastCallbackPage = await res.text();
  return true;
}

const b64url = (buf: Buffer) => buf.toString("base64url");
// 经函数读取：避免测试体内 `= null` 赋值触发 TS 控制流收窄（值由服务器回调更新）
const authHeader = () => fake.lastAuthHeader;

function json(res: { writeHead: Function; end: (b?: string) => void }, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  process.env.PI_MCP_OAUTH_PATH = path.join(tmp, "mcp-oauth.json");
  process.env.PI_MCP_CACHE_PATH = path.join(tmp, "cache.json");
  // authorize/revoke 会落审计事件：进临时文件，别脏真实的 ~/.kova/mcp-audit.jsonl
  process.env.PI_MCP_AUDIT_PATH = path.join(tmp, "audit.jsonl");
  srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const route = url.pathname;

      // ---- OAuth 元数据发现（RFC 9728 + RFC 8414） ----
      if (req.method === "GET" && route === "/.well-known/oauth-protected-resource/mcp") {
        json(res, 200, { resource: mcpUrl, authorization_servers: [base] });
        return;
      }
      if (req.method === "GET" && route === "/.well-known/oauth-authorization-server") {
        json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
        return;
      }

      // ---- 动态客户端注册 ----
      if (req.method === "POST" && route === "/register") {
        fake.dcrCount += 1;
        const meta = JSON.parse(raw || "{}");
        json(res, 201, {
          client_id: "kova-test-client",
          client_id_issued_at: Math.floor(Date.now() / 1000),
          ...(Array.isArray(meta.redirect_uris) ? { redirect_uris: meta.redirect_uris } : {}),
        });
        return;
      }

      // ---- 令牌端点（authorization_code 校 PKCE；refresh_token 发新对） ----
      if (req.method === "POST" && route === "/token") {
        const p = new URLSearchParams(raw);
        const grant = p.get("grant_type");
        if (grant === "authorization_code") {
          const verifier = p.get("code_verifier") ?? "";
          const ok =
            p.get("code") === AUTH_CODE &&
            fake.challenge === b64url(createHash("sha256").update(verifier).digest());
          if (!ok) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          fake.validTokens.add("at-1");
          json(res, 200, {
            access_token: "at-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt-1",
          });
          return;
        }
        if (grant === "refresh_token") {
          if (p.get("refresh_token") !== "rt-1") {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          fake.refreshCount += 1;
          fake.validTokens.add("at-2");
          json(res, 200, {
            access_token: "at-2",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt-2",
          });
          return;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      // ---- MCP 端点：只认 Bearer 短 token，否则 401 + resource_metadata ----
      if (req.method === "POST" && route === "/mcp") {
        fake.lastAuthHeader = req.headers.authorization ?? null;
        const bearer = fake.lastAuthHeader?.startsWith("Bearer ")
          ? fake.lastAuthHeader.slice(7)
          : null;
        if (!bearer || !fake.validTokens.has(bearer)) {
          res.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        let m: { id?: unknown; method?: string };
        try {
          m = JSON.parse(raw || "{}");
        } catch {
          m = {};
        }
        if (m.method === "initialize") {
          json(res, 200, {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-fake", version: "1" },
            },
          });
        } else if (m.method === "tools/list") {
          json(res, 200, {
            jsonrpc: "2.0",
            id: m.id,
            result: {
              tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }],
            },
          });
        } else if (m.id !== undefined) {
          json(res, 200, {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32601, message: "nope" },
          });
        } else {
          res.writeHead(202);
          res.end();
        }
        return;
      }

      json(res, 404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  mcpUrl = `${base}/mcp`;
});

afterAll(() => {
  setBrowserOpenerForTest(undefined);
  srv.closeAllConnections?.();
  srv.close();
  mcpManager.disposeAll();
  resetMcpCacheForTest();
  resetMcpOAuthForTest();
  if (prevOAuthPath === undefined) delete process.env.PI_MCP_OAUTH_PATH;
  else process.env.PI_MCP_OAUTH_PATH = prevOAuthPath;
  if (prevCachePath === undefined) delete process.env.PI_MCP_CACHE_PATH;
  else process.env.PI_MCP_CACHE_PATH = prevCachePath;
  if (prevAuditPath === undefined) delete process.env.PI_MCP_AUDIT_PATH;
  else process.env.PI_MCP_AUDIT_PATH = prevAuditPath;
});

beforeEach(() => {
  mcpManager.disposeAll();
  resetMcpCacheForTest();
  // 先清盘再清内存：否则上个测试写入的凭据会在 load() 时被读回
  writeFileSync(oauthStorePath(), "{}");
  resetMcpOAuthForTest();
  setBrowserOpenerForTest(undefined);
  resetFake();
});

const httpDef = (): McpServerDef => ({
  name: "oauthfake",
  transport: "http",
  url: mcpUrl,
  layer: "system",
  source: "",
});

describe("MCP OAuth 2.1 授权流", () => {
  test("未授权握手：401 判定 needsAuth，绝不弹浏览器", async () => {
    let opened = 0;
    setBrowserOpenerForTest(async () => {
      opened += 1;
      return true;
    });
    const def = httpDef();
    await expect(mcpManager.ensureConnected(def)).rejects.toThrow();
    const status = mcpManager.statusFor(def);
    expect(status.state).toBe("backoff");
    expect(status.needsAuth).toBe(true);
    expect(status.message).toContain("需要 OAuth 授权");
    expect(opened).toBe(0);
    // 失败进连接日志（弹窗可见）
    expect(mcpManager.logFor("oauthfake").some((l) => l.message.includes("握手失败"))).toBe(true);
  });

  test("authorize()：发现+DCR+PKCE 换 token、落盘、重连后静默复用", async () => {
    setBrowserOpenerForTest(fakeBrowser);
    const def = httpDef();
    const status = await mcpManager.authorize(def);
    expect(status.state).toBe("ready");
    expect(status.toolCount).toBe(1);
    expect(fake.browserOpens).toBe(1);
    expect(fake.dcrCount).toBe(1);
    expect(authHeader()).toBe("Bearer at-1");
    // 落地页：带品牌（kova + 内联 logo）的成功态卡片
    expect(fake.lastCallbackPage).toContain("授权完成");
    expect(fake.lastCallbackPage).toContain("kova");
    expect(fake.lastCallbackPage).toContain("<svg");
    expect(fake.lastCallbackPage).toContain(mcpUrl);
    // 深色覆写必须排在 .card 等基础规则之后，否则同优先级被盖、暗色下卡片仍是白的
    expect(fake.lastCallbackPage.indexOf("@media (prefers-color-scheme:dark)")).toBeGreaterThan(
      fake.lastCallbackPage.indexOf(".card{"),
    );
    // token 持久化（按服务器 URL 键控，含 refresh_token）
    const store = JSON.parse(readFileSync(oauthStorePath(), "utf8")) as Record<
      string,
      { tokens?: { access_token?: string; refresh_token?: string } }
    >;
    expect(store[mcpUrl]?.tokens?.access_token).toBe("at-1");
    expect(store[mcpUrl]?.tokens?.refresh_token).toBe("rt-1");

    // 断开重连：走已存凭据的静默路径，不再开浏览器、不再 DCR
    mcpManager.disconnect(def.name);
    fake.lastAuthHeader = null;
    fake.browserOpens = 0;
    setBrowserOpenerForTest(async () => {
      fake.browserOpens += 1;
      return true;
    });
    const tools = await mcpManager.ensureConnected(def);
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    expect(fake.browserOpens).toBe(0);
    expect(fake.dcrCount).toBe(1);
    expect(authHeader()).toBe("Bearer at-1");
  });

  test("access_token 被服务端吊销：重连经 refresh_token 静默续期", async () => {
    setBrowserOpenerForTest(fakeBrowser);
    const def = httpDef();
    await mcpManager.authorize(def);
    mcpManager.disconnect(def.name);
    // 吊销 at-1（模拟过期）；只有 at-2（refresh 后的新 token）有效
    fake.validTokens.delete("at-1");

    const tools = await mcpManager.ensureConnected(def);
    expect(tools).toHaveLength(1);
    expect(fake.refreshCount).toBe(1);
    expect(authHeader()).toBe("Bearer at-2");
    const status = mcpManager.statusFor(def);
    expect(status.state).toBe("ready");
    expect(status.needsAuth).toBeFalsy();
  });

  test("配置里残留的旧 Authorization 头不覆盖 OAuth token", async () => {
    // 真实事故路径复现：kaneo 条目带着失效 API-key 作 Bearer 头。SDK 的
    // header 合并是 requestInit 优先，若不剥掉，授权换来的 token 会被顶掉，
    // 重连永远 401（Kaneo 无 refresh_token 时表现为反复弹浏览器 + Unauthorized）
    setBrowserOpenerForTest(fakeBrowser);
    const def: McpServerDef = {
      ...httpDef(),
      headers: { Authorization: "Bearer stale-api-key", "X-Custom": "keep-me" },
    };
    const status = await mcpManager.authorize(def);
    expect(status.state).toBe("ready");
    expect(authHeader()).toBe("Bearer at-1");
  });

  test("用户拒绝授权：authorize() 以明确错误失败", async () => {
    setBrowserOpenerForTest(async (url) => {
      fake.browserOpens += 1;
      const u = new URL(url);
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("error", "access_denied");
      const res = await fetch(cb.toString());
      fake.lastCallbackPage = await res.text();
      return true;
    });
    const def = httpDef();
    await expect(mcpManager.authorize(def)).rejects.toThrow(/授权未通过/);
    expect(mcpManager.statusFor(def).state).toBe("backoff");
    // 落地页失败态：呈现拒绝原因，不留裸文本
    expect(fake.lastCallbackPage).toContain("授权失败");
    expect(fake.lastCallbackPage).toContain("access_denied");
  });

  test("回调 state 失配：落地页与实际结算一致（不得显示成功）", async () => {
    setBrowserOpenerForTest(async (url) => {
      fake.browserOpens += 1;
      const u = new URL(url);
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", AUTH_CODE);
      cb.searchParams.set("state", "wrong-state");
      const res = await fetch(cb.toString());
      fake.lastCallbackPage = await res.text();
      return true;
    });
    const def = httpDef();
    await expect(mcpManager.authorize(def)).rejects.toThrow(/state 校验失败/);
    expect(fake.lastCallbackPage).toContain("授权失败");
    expect(fake.lastCallbackPage).not.toContain("授权完成");
  });

  test("取消授权：凭据清空、状态复位，重连回到 needsAuth 且不再静默复用", async () => {
    setBrowserOpenerForTest(fakeBrowser);
    const def = httpDef();
    await mcpManager.authorize(def);
    expect(mcpManager.statusFor(def).oauthAuthorized).toBe(true);

    mcpManager.revokeAuth(def);
    // 凭据文件里该 URL 条目整体消失；状态不再报「已授权」
    const store = JSON.parse(readFileSync(oauthStorePath(), "utf8")) as Record<string, unknown>;
    expect(store[mcpUrl]).toBeUndefined();
    expect(mcpManager.statusFor(def).oauthAuthorized).toBeUndefined();

    // 重连：无凭据可静默复用 → 裸 401 → needsAuth；绝不弹浏览器
    fake.browserOpens = 0;
    await expect(mcpManager.ensureConnected(def)).rejects.toThrow();
    const s = mcpManager.statusFor(def);
    expect(s.needsAuth).toBe(true);
    expect(s.oauthAuthorized).toBeUndefined();
    expect(fake.browserOpens).toBe(0);
  });
});
