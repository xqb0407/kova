/**
 * MCP OAuth 2.1 客户端（Streamable HTTP 服务器的授权流）。
 *
 * 实现 SDK 的 OAuthClientProvider，把 401 → 受保护资源元数据发现 → 授权服务器
 * 元数据 → 动态客户端注册（DCR）→ PKCE 浏览器授权 → localhost 回调取 code →
 * 换 token 这整条链路的状态持久化下来：
 * - 存储：~/.kova/mcp-oauth.json（PI_MCP_OAUTH_PATH 可覆盖），按服务器 URL 键控，
 *   文件 0600（内含 access/refresh token，策略与 ~/.kova/mcp.json 明文 headers 一致）
 * - 回调：http://127.0.0.1:<port>/callback 一次性本地服务，只在授权进行时存在；
 *   端口随 DCR 结果记录，重连时优先复用（否则注册的 redirect_uri 对不上要重新 DCR）
 * - 浏览器：有宿主时经 host_query open_external（桌面 Electron shell.openExternal），
 *   独立跑时退回本机打开器（darwin open / Windows rundll32 / xdg-open；测试可注入替换）。
 *   **Windows 绝不经 cmd.exe**：URL 里的 & 会被 cmd 当命令分隔符切掉——旧实现
 *   `cmd /c start "" <url>` 只把第一个 & 之前的部分交给浏览器（Atlassian 授权页
 *   据此报「链接不完整」），且 stdio ignore 把 cmd 的报错全吞了，用户侧只看到
 *   180s 超时。见 spawnOpener 注释。
 *
 * 两种模式：
 * - silent（握手懒连时）：仅在已有凭据时挂 provider——access_token 过期由 SDK
 *   用 refresh_token 静默续期；换不动则失败上抛，管理器按 401/UnauthorizedError
 *   置 needsAuth，等用户在设置页点「授权」。绝不静默弹浏览器。
 * - interactive（authorize_mcp_server 命令）：起回调服务、真开浏览器、等 code。
 *   两段式交付：urlReady 在授权链接生成后立即兑现（命令据此马上应答、把链接
 *   交给前端），等用户在浏览器批准的长时间等待走 completed，不占请求配对。
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { logErr } from "../log";
import { getTransport } from "../storage/hostdb/transport";
import { isLocalStorage } from "../storage/hostdb/local";

/** 等待用户在浏览器完成授权的上限（比握手超时宽得多） */
export const MCP_OAUTH_CALLBACK_TIMEOUT_MS = 180_000;

export type OAuthEntry = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  /** DCR 注册时的回调端口；端口变了旧注册作废（重新注册） */
  redirectPort?: number;
};

const entries = new Map<string, OAuthEntry>();
let loaded = false;

export function oauthStorePath(): string {
  return process.env.PI_MCP_OAUTH_PATH ?? join(homedir(), ".kova", "mcp-oauth.json");
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(oauthStorePath(), "utf8")) as Record<string, OAuthEntry>;
    for (const [url, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === "object") entries.set(url, entry);
    }
  } catch {
    /* 首次使用/文件损坏 = 空存储 */
  }
}

function persist(): void {
  const path = oauthStorePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(entries), null, 2), { mode: 0o600 });
  } catch (err) {
    logErr("mcp-oauth: 写入凭据文件失败:", err);
  }
}

/** 测试 teardown 用：丢弃内存态，下次从当前 PI_MCP_OAUTH_PATH 重载 */
export function resetMcpOAuthForTest(): void {
  entries.clear();
  loaded = false;
}

/**
 * 浏览器拉起钩子：测试注入假 opener 避免真弹窗。
 * 返回 false 表示没拉起来（调用方把授权 URL 交给用户手动打开）。
 */
let browserOpener: ((url: string) => Promise<boolean>) | undefined;
export function setBrowserOpenerForTest(fn: ((url: string) => Promise<boolean>) | undefined): void {
  browserOpener = fn;
}

/** 宿主代开 RPC 的等待上限（宿主侧只是 shell.openExternal，正常毫秒级） */
const OPEN_VIA_HOST_TIMEOUT_MS = 10_000;
/** 本机打开器的失败探测窗口：spawn 的成败是异步事件（ENOENT / 立即非零退出），
 *  等一小会再下结论，别把「命令不存在」当成功——旧实现 spawn 成功即 return true，
 *  浏览器根本没打开却一路静默到 180s 超时。 */
const OPENER_PROBE_MS = 1500;

type OpenerOutcome = { ok: boolean; detail?: string };

/**
 * 拉起一个分离的打开器进程并给出结论。**绝不经过 cmd.exe**：
 * - URL 里没有空白字符时，Node/Bun 的 spawn 不会给参数加引号（libuv 只在含
 *   空格/制表符/引号/反斜杠时才引），而 cmd.exe 会把裸 & 当命令分隔符——
 *   `cmd /c start "" <url>` 交给浏览器的只有第一个 & 之前的部分。
 * - cmd 的报错（'client_id' 不是内部或外部命令）在 stdio ignore 下全丢。
 * 这里对 stderr 留尾（诊断用）并按需看退出码：explorer.exe 成功打开也会返回
 * 非零码，所以它只按「能不能跑起来」判。
 */
function spawnOpener(cmd: string, args: string[], judgeExitCode: boolean): Promise<OpenerOutcome> {
  return new Promise<OpenerOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    } catch (err) {
      resolve({ ok: false, detail: `拉起 ${cmd} 失败：${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let stderrTail = "";
    child.stderr?.on("data", (buf: Buffer) => {
      if (stderrTail.length < 2000) stderrTail += buf.toString("utf8");
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: OpenerOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stderr?.destroy();
      child.unref();
      resolve(outcome);
    };
    timer = setTimeout(() => finish({ ok: true }), OPENER_PROBE_MS);
    child.once("error", (err) => finish({ ok: false, detail: `拉起 ${cmd} 失败：${err.message}` }));
    child.once("exit", (code) => {
      if (!judgeExitCode || code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        detail: `${cmd} 以退出码 ${code} 结束${stderrTail.trim() ? `：${stderrTail.trim().slice(0, 500)}` : ""}`,
      });
    });
  });
}

/** 无宿主时的本机打开器（Windows 刻意绕开 cmd，见 spawnOpener 注释） */
async function openLocally(url: string): Promise<boolean> {
  const candidates: { cmd: string; args: string[]; judgeExitCode: boolean }[] =
    process.platform === "darwin"
      ? [{ cmd: "open", args: [url], judgeExitCode: true }]
      : process.platform === "win32"
        ? [
            // rundll32 的 FileProtocolHandler 即 ShellExecute 入口，参数直传不经 cmd
            { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url], judgeExitCode: true },
            { cmd: "explorer.exe", args: [url], judgeExitCode: false },
          ]
        : [{ cmd: "xdg-open", args: [url], judgeExitCode: true }];
  let detail: string | undefined;
  for (const candidate of candidates) {
    const outcome = await spawnOpener(candidate.cmd, candidate.args, candidate.judgeExitCode);
    if (outcome.ok) return true;
    detail = outcome.detail ?? detail;
  }
  logErr(`mcp-oauth: 未能打开浏览器${detail ? `（${detail}）` : ""}；请手动访问授权链接`);
  return false;
}

/**
 * 宿主代开（桌面 Electron：shell.openExternal，不经 cmd、& 安全、且能拿到真实成败）。
 * 返回 undefined = 没有宿主 / 宿主通道本身坏了 → 调用方退回本机打开器；
 * 返回 false = 宿主明确拒绝了这次打开，不再重复尝试。
 */
async function openViaHost(url: string): Promise<boolean | undefined> {
  if (isLocalStorage()) return undefined; // 冒烟/直跑：没有宿主
  const transport = getTransport();
  if (!transport) return undefined;
  try {
    const reply = (await transport("open_external", { url }, { timeoutMs: OPEN_VIA_HOST_TIMEOUT_MS })) as
      | { ok?: unknown }
      | null;
    if (reply?.ok === true) return true;
    logErr("mcp-oauth: 宿主拒绝打开授权链接");
    return false;
  } catch (err) {
    logErr("mcp-oauth: 宿主打开授权链接失败，退回本机打开：", err);
    return undefined;
  }
}

async function openInBrowser(url: string): Promise<boolean> {
  if (browserOpener) {
    try {
      return await browserOpener(url);
    } catch (err) {
      logErr("mcp-oauth: 测试 opener 抛错:", err);
      return false;
    }
  }
  const viaHost = await openViaHost(url);
  return viaHost ?? (await openLocally(url));
}

export class FileOAuthProvider implements OAuthClientProvider {
  /** 最近一次交给用户的授权 URL（opener 拉起失败时进超时消息） */
  lastAuthorizationUrl?: string;
  /** 浏览器是否成功拉起（false = 授权链接要靠用户手动打开） */
  browserOpened?: boolean;
  /** 授权 URL 生成 + 拉起尝试完毕后的钩子（beginInteractiveOAuth 挂载，供两段式交付） */
  onAuthorizationUrl?: (url: string, browserOpened: boolean) => void;
  private verifier?: string;
  private stateValue?: string;

  constructor(
    private readonly entry: OAuthEntry,
    private readonly interactive: boolean,
    private readonly port: number,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "kova",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.stateValue ??= randomUUID();
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // 回调端口与注册时不一致 ⇒ 旧的 redirect_uri 注册已不可用，重新 DCR
    if (this.entry.redirectPort !== this.port) return undefined;
    return this.entry.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.entry.clientInformation = info;
    this.entry.redirectPort = this.port;
    persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.entry.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.entry.tokens = tokens;
    persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.entry.discovery;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.entry.discovery = state;
    persist();
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier ?? "";
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.lastAuthorizationUrl = url.toString();
    // 静默模式不开浏览器：auth() 随即返回 REDIRECT → 上层抛 UnauthorizedError，
    // 由 UI 引导用户点「授权」走交互模式
    if (!this.interactive) return;
    this.browserOpened = await openInBrowser(this.lastAuthorizationUrl);
    if (!this.browserOpened) {
      logErr("mcp-oauth: 浏览器未能自动打开，需用户手动访问授权链接");
    }
    // 两段式：命令侧据此立刻把 authUrl（与拉起成败）交付前端，别等用户批准
    this.onAuthorizationUrl?.(this.lastAuthorizationUrl, this.browserOpened);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") delete this.entry.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.entry.tokens;
    if (scope === "all" || scope === "discovery") delete this.entry.discovery;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    persist();
  }
}

/**
 * 静默 provider：仅在该 URL 已有凭据时返回（过期 token 由 SDK 静默刷新）。
 * 无凭据返回 undefined——不挂 provider。刻意的：SDK 只在挂了 provider 且拿到
 * 凭据（DCR 结果）时才走 auth 分支，全新未授权服务器没有真实回调端口可用，
 * 静默 DCR 会注册出无效的 redirect_uri；让它裸 401，由管理器按状态码判 needsAuth。
 */
export function silentOAuthProvider(serverUrl: string): FileOAuthProvider | undefined {
  load();
  const entry = entries.get(serverUrl);
  if (!entry?.tokens && !entry?.clientInformation) return undefined;
  return new FileOAuthProvider(entry ?? {}, false, entry?.redirectPort ?? 0);
}

/** 该 URL 是否已存 access token（设置页据此呈现「取消授权」入口） */
export function hasOAuthTokens(serverUrl: string): boolean {
  load();
  return Boolean(entries.get(serverUrl)?.tokens);
}

/** 清空该 URL 的全部凭据（client/tokens/discovery），下次连接必须重新授权；返回是否清掉了东西 */
export function clearOAuthForServer(serverUrl: string): boolean {
  load();
  const had = entries.delete(serverUrl);
  if (had) persist();
  return had;
}

export type InteractiveOAuthSession = {
  provider: FileOAuthProvider;
  /** 授权 URL 生成（浏览器拉起已尝试）时兑现；握手在拿到 URL 之前就失败则 reject。
   *  两段式的第一阶段交付点：命令等它拿 authUrl 立刻应答，不再等用户在浏览器批准。 */
  urlReady: Promise<{ url: string; browserOpened: boolean }>;
  /** 等浏览器授权回跳拿到 code（用户拒绝/超时则抛，附手动打开的授权 URL） */
  waitForCode: () => Promise<string>;
  /** 关掉本地回调服务 */
  finish: () => Promise<void>;
  /** 主动放弃本次授权：关回调服务，在飞的等待立即以 reason 失败（别留 180s 空转） */
  abort: (reason: string) => void;
};

async function listenCallbackServer(preferredPort?: number): Promise<{ server: Server; port: number }> {
  // 优先复用注册过的端口（保住 DCR 的 redirect_uri）；占不住退回随机端口（触发重新注册）
  const candidates = preferredPort ? [preferredPort, 0] : [0];
  for (const port of candidates) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      const addr = server.address();
      if (addr && typeof addr === "object") return { server, port: addr.port };
      throw new Error("callback server has no port");
    } catch {
      server.close();
    }
  }
  throw new Error("无法启动本地授权回调服务（127.0.0.1）");
}

/**
 * 回调落地页：整页自包含（内联样式 + 内联 logo），sidecar 是编译二进制，
 * 浏览器里没有可引用的静态资源。favicon 用同一份 SVG 的 data URI。
 */
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round">' +
  '<path d="M22 65c5-22 17-34 31-34 12 0 20 8 25 22 3 8 5 11 10 11"/>' +
  '<path d="M22 65c5-9 12-14 21-14 12 0 18 9 20 18 2 7 7 10 15 10" stroke-width="4" opacity=".35"/>' +
  '<circle cx="22" cy="65" r="6" fill="currentColor" stroke="none"/>' +
  '<circle cx="88" cy="64" r="6" fill="currentColor" stroke="none"/>' +
  "</svg>";

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
const CROSS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function callbackPage(opts: {
  ok: boolean;
  title: string;
  message: string;
  serverUrl: string;
}): string {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>kova · ${escHtml(opts.title)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}">
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box;margin:0}
 body{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
 background:radial-gradient(1200px 800px at 20% -10%,#eef2ff,transparent),radial-gradient(1000px 700px at 110% 110%,#ecfdf5,transparent),#f6f7f9;
 color:#17181c}
.card{width:100%;max-width:420px;text-align:center;background:#fff;border:1px solid #e6e8ec;
 border-radius:24px;padding:40px 36px 32px;box-shadow:0 24px 60px rgba(23,24,28,.08);
 animation:rise .45s cubic-bezier(.2,.8,.2,1)}
@keyframes rise{from{opacity:0;transform:translateY(12px)}}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:15px;letter-spacing:.02em}
.brand svg{width:26px;height:26px}
.badge{width:72px;height:72px;margin:26px auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.badge svg{width:34px;height:34px}
.badge.ok{background:rgba(22,163,74,.12);color:#16a34a}
.badge.err{background:rgba(220,38,38,.12);color:#dc2626}
.badge svg path{stroke-dasharray:40;stroke-dashoffset:40;animation:draw .5s .25s ease forwards}
@keyframes draw{to{stroke-dashoffset:0}}
h1{font-size:21px;font-weight:700;margin-bottom:10px}
.msg{font-size:14px;line-height:1.65;color:#6b7280;margin-bottom:22px;overflow-wrap:break-word}
.server{display:flex;flex-direction:column;gap:4px;background:#f3f4f6;border-radius:12px;padding:10px 14px;font-size:12px;color:#9ca3af;text-align:left}
.server code{font-size:12px;color:#374151;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* 深色覆写必须在基础规则之后：同优先级下媒体查询块放前面会被后写的 .card 等盖掉 */
@media (prefers-color-scheme:dark){
 body{background:radial-gradient(1200px 800px at 20% -10%,#1d2333,transparent),radial-gradient(1000px 700px at 110% 110%,#14251f,transparent),#0d0f13;color:#e8eaee}
 .card{background:#16181d;border-color:#26292f;box-shadow:0 24px 60px rgba(0,0,0,.45)}
 .msg{color:#9aa0aa}.server{background:#1d2026}.server code{color:#c6cad2}
}
</style></head>
<body><main class="card">
<div class="brand">${LOGO_SVG}<span>kova</span></div>
<div class="badge ${opts.ok ? "ok" : "err"}">${opts.ok ? CHECK_SVG : CROSS_SVG}</div>
<h1>${escHtml(opts.title)}</h1>
<p class="msg">${escHtml(opts.message)}</p>
<div class="server"><span>MCP 服务器</span><code>${escHtml(opts.serverUrl)}</code></div>
</main></body></html>`;
}

/** 起交互式授权会话：先占好回调端口，provider 的 redirectUrl 由此而定 */
export async function beginInteractiveOAuth(serverUrl: string): Promise<InteractiveOAuthSession> {
  load();
  let entry = entries.get(serverUrl);
  if (!entry) {
    entry = {};
    entries.set(serverUrl, entry);
  }
  const { server, port } = await listenCallbackServer(entry.redirectPort);
  const provider = new FileOAuthProvider(entry, true, port);

  // 两段式第一阶段：授权链接生成、浏览器拉起尝试完毕时兑现
  let resolveUrl!: (v: { url: string; browserOpened: boolean }) => void;
  let rejectUrl!: (e: Error) => void;
  const urlReady = new Promise<{ url: string; browserOpened: boolean }>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  // 兜一个处理器：调用方可能只订阅后续阶段，别让早期的失败变成未处理拒绝
  urlReady.catch(() => {});
  provider.onAuthorizationUrl = (url, browserOpened) => resolveUrl({ url, browserOpened });

  let pending: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  // 回调可能先于 waitForCode() 到达（自动批准的 IdP / 测试桩）：先缓冲，后到即取
  let settled: { code: string } | { err: Error } | undefined;

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      // 手动撞进回调端口的杂项请求：也给张卡片页，不抛裸文本
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(
        callbackPage({
          ok: false,
          title: "页面不存在",
          message: "这里只是 kova 接收 MCP 授权回调的临时服务，没有更多内容。请回到 kova 继续操作。",
          serverUrl,
        }),
      );
      return;
    }
    const code = url.searchParams.get("code");
    const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    // 先算结论再出页面：落地页展示的必须与实际结算一致（state 失配不能显示成功）
    let result: { code: string } | { err: Error };
    if (code && url.searchParams.get("state") === provider.state()) {
      result = { code };
    } else if (code) {
      result = { err: new Error("授权回调 state 校验失败，请在 kova 中重新发起授权") };
    } else {
      result = { err: new Error(`授权未通过：${failure ?? "回调未携带 code"}`) };
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "code" in result
        ? callbackPage({
            ok: true,
            title: "授权完成",
            message: "kova 正在用授权码换取凭据并建立连接。可以关闭此页面，回到应用。",
            serverUrl,
          })
        : callbackPage({
            ok: false,
            title: "授权失败",
            message: result.err.message,
            serverUrl,
          }),
    );
    if (pending) {
      const waiter = pending;
      pending = undefined;
      if ("code" in result) waiter.resolve(result.code);
      else waiter.reject(result.err);
    } else {
      settled ??= result;
    }
  });

  return {
    provider,
    urlReady,
    abort: (reason: string) => {
      const err = new Error(reason);
      // 先失败 urlReady（命令侧若还在等链接，立刻拿到原因），再结清在飞等待
      rejectUrl(err);
      if (pending) {
        const waiter = pending;
        pending = undefined;
        waiter.reject(err);
      } else {
        settled ??= { err };
      }
      try {
        server.closeAllConnections?.();
        server.close();
      } catch {
        /* 关闭失败不影响「放弃」语义 */
      }
    },
    waitForCode: () =>
      new Promise<string>((resolve, reject) => {
        if (settled) {
          const done = settled;
          settled = undefined;
          if ("code" in done) resolve(done.code);
          else reject(done.err);
          return;
        }
        const timer = setTimeout(() => {
          pending = undefined;
          // 授权链接进日志（排查用）；用户侧文案不再背那 900 字符的 URL——
          // 设置页的「等待授权」卡片始终带着可复制/可重开的链接，超时提示指过去即可
          if (provider.lastAuthorizationUrl) {
            logErr("mcp-oauth: 等待浏览器授权超时；授权链接：", provider.lastAuthorizationUrl);
          }
          reject(
            new Error(
              `等待浏览器授权超时（${MCP_OAUTH_CALLBACK_TIMEOUT_MS / 1000}s）：` +
                "请在设置页的「等待授权」卡片里重新打开授权链接，或重新点「授权」",
            ),
          );
        }, MCP_OAUTH_CALLBACK_TIMEOUT_MS);
        timer.unref?.();
        pending = {
          resolve: (code) => {
            clearTimeout(timer);
            resolve(code);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
      }),
    finish: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
