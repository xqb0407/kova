/**
 * Cloudflare 快速隧道监管（对齐 tunnel.rs 全契约）：
 * 二进制解析（kv tunnel.binary → PATH → 常见位置 → appData/bin）→
 * spawn `cloudflared tunnel --url http://127.0.0.1:<网关端口> --no-autoupdate` →
 * stderr 抓 `.trycloudflare.com` 公网地址 → 状态机 stopped/starting/running/error +
 * 日志尾巴（40 行 × 400 字）→ 一键下载（GitHub Releases + sha256 digest 校验，
 * 校验不过一律不落盘）→ 退出/网关停时同步收进程组，绝不留孤儿。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appDataDir } from "./paths";
import { kvGet, kvSet, kvDelete } from "./store";
import { emitToWindows } from "./ipc";
import { logInfo, logWarn } from "./logging";
import { killTree } from "./tool-exec";

/** 惰性取网关端口：避免与 remote.ts 形成静态循环依赖（remote 静态引本模块的 stopNow） */
function currentPort(): number | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("./remote") as typeof import("./remote");
  return mod.currentPort();
}

const LOG_CAP = 40;
const LOG_LINE_MAX = 400;
const BINARY_KV_KEY = "tunnel.binary";
const QUICK_HOST_SUFFIX = ".trycloudflare.com";
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const PROGRESS_MIN_INTERVAL_MS = 150;

const SOURCE_CUSTOM = "custom";
const SOURCE_PATH = "path";
const SOURCE_COMMON = "common";
const SOURCE_APP_DATA = "app-data";

/* ------------------------------ 状态 ------------------------------ */

const inner: {
  child: ChildProcess | null;
  pid: number | null;
  state: string;
  url: string | null;
  port: number | null;
  error: string | null;
  log: string[];
  generation: number;
} = { child: null, pid: null, state: "stopped", url: null, port: null, error: null, log: [], generation: 0 };

function setState(s: string): void {
  inner.state = s;
}

function pushLog(line: string): void {
  const clipped = Array.from((line ?? "").trim()).slice(0, LOG_LINE_MAX).join("");
  if (!clipped) return;
  inner.log.push(clipped);
  while (inner.log.length > LOG_CAP) inner.log.shift();
}

/* ------------------------------ 二进制解析 ------------------------------ */

function binaryFileName(): string {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function searchInPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    const cand = join(dir, name);
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* next */
    }
  }
  return null;
}

function commonLocations(): string[] {
  if (process.platform === "win32") {
    return ["C:\\Program Files\\cloudflared\\cloudflared.exe", "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"];
  }
  return ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
}

function appDataBinary(): string {
  return join(appDataDir(), "bin", binaryFileName());
}

interface ResolvedBinary {
  path: string;
  source: string;
  exists: boolean;
}

/** 解析顺序：用户指定（不存在也直接返回）→ PATH → 常见位置 → appData */
function resolveBinary(): ResolvedBinary {
  const custom = kvGet(BINARY_KV_KEY);
  if (custom && custom.trim().length > 0) {
    let exists = false;
    try {
      exists = statSync(custom).isFile();
    } catch {
      exists = false;
    }
    return { path: custom, source: SOURCE_CUSTOM, exists };
  }
  const name = binaryFileName();
  const inPath = searchInPath(name);
  if (inPath) return { path: inPath, source: SOURCE_PATH, exists: true };
  for (const p of commonLocations()) {
    try {
      if (statSync(p).isFile()) return { path: p, source: SOURCE_COMMON, exists: true };
    } catch {
      /* next */
    }
  }
  const appData = appDataBinary();
  let exists = false;
  try {
    exists = statSync(appData).isFile();
  } catch {
    exists = false;
  }
  return { path: appData, source: SOURCE_APP_DATA, exists };
}

/* ------------------------------ 地址解析 ------------------------------ */

/** 从 cloudflared 输出行抓快速隧道地址（逐 token、剥框线、校验主机后缀） */
export function extractTunnelUrl(line: string): string | null {
  for (const tokenRaw of (line ?? "").split(/\s+/)) {
    const t = tokenRaw.replace(/^[|"'<>(),;]+/, "").replace(/[|"'<>(),;]+$/, "");
    const idx = t.indexOf("https://");
    if (idx < 0) continue;
    const rest = t.slice(idx + "https://".length);
    const host = rest.split(/[/?#]/)[0] ?? "";
    if (host.length > QUICK_HOST_SUFFIX.length && host.endsWith(QUICK_HOST_SUFFIX)) {
      return `https://${host}`;
    }
  }
  return null;
}

/* ------------------------------ 进程监管 ------------------------------ */

function pipeReader(stream: NodeJS.ReadableStream, generation: number): void {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (inner.generation !== generation) return;
      pushLog(line);
      if (inner.url === null) {
        const url = extractTunnelUrl(line);
        if (url && inner.generation === generation) {
          inner.url = url;
          setState("running");
          logInfo(`[tunnel] quick tunnel ready: ${url}`);
        }
      }
    }
  });
  stream.on("end", () => {
    if (buf) pushLog(buf);
  });
}

function stopInner(): void {
  inner.generation += 1; // 代数先走：旧读/监控线程立即失效
  const pid = inner.pid;
  inner.pid = null;
  inner.child = null;
  if (pid !== null) killTree(pid);
  inner.url = null;
  inner.port = null;
  inner.error = null;
  setState("stopped");
}

function startInner(port: number): void {
  stopInner(); // 重启语义：已有实例先收掉（幂等）
  const bin = resolveBinary();
  if (!bin.exists) {
    throw new Error(
      `cloudflared not found at ${bin.path}. Download it in Settings → Remote access, or install it manually (brew install cloudflared / winget install --id Cloudflare.cloudflared).`,
    );
  }
  inner.log = [];
  const generation = ++inner.generation;

  const child = spawn(bin.path, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32", // 自成进程组：停止时整树收
    windowsHide: true,
  });
  inner.child = child;
  inner.pid = child.pid ?? null;
  inner.port = port;
  inner.error = null;
  setState("starting");
  logInfo(`[tunnel] cloudflared started (pid=${child.pid}, port=${port}, bin=${bin.path}, source=${bin.source})`);

  if (child.stderr) pipeReader(child.stderr, generation);
  if (child.stdout) pipeReader(child.stdout, generation);

  child.on("error", (e) => {
    if (inner.generation !== generation) return;
    inner.error = `cloudflared process error: ${e.message}`;
    inner.url = null;
    inner.pid = null;
    inner.child = null;
    setState("error");
    logWarn(`[tunnel] ${inner.error}`);
  });

  child.on("exit", (code, signal) => {
    // 读线程可能还在把最后几行写进尾巴：稍等再定错误文案
    setTimeout(() => {
      if (inner.generation !== generation) return; // 主动停止：状态已由 stopInner 处理
      const last = [...inner.log].reverse().find((l) => l.trim().length > 0) ?? "";
      const base =
        code !== null ? `cloudflared exited unexpectedly (exit status: ${code})` : `cloudflared exited unexpectedly (signal: ${signal})`;
      const msg = last ? `${base}: ${last}` : base;
      inner.error = msg;
      inner.url = null;
      inner.pid = null;
      inner.child = null;
      setState("error");
      logWarn(`[tunnel] ${msg}`);
    }, 150);
  });
}

function buildStatus(): any {
  const bin = resolveBinary();
  return {
    state: inner.state,
    url: inner.url,
    port: inner.port,
    binaryPath: bin.path,
    binarySource: bin.source,
    binaryExists: bin.exists,
    error: inner.error,
    logTail: [...inner.log],
  };
}

/* ------------------------------ 一键下载 ------------------------------ */

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function emitProgress(phase: string, done: number, total: number, message: string): void {
  emitToWindows("tunnel:download", { phase, done, total, message });
}

function platformAsset(): { asset: string; needsExtract: boolean } {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? { asset: "cloudflared-darwin-arm64.tgz", needsExtract: true }
      : { asset: "cloudflared-darwin-amd64.tgz", needsExtract: true };
  }
  if (process.platform === "win32") {
    return { asset: "cloudflared-windows-amd64.exe", needsExtract: false };
  }
  throw new Error("automatic download is only supported on macOS and Windows; install cloudflared manually on this platform");
}

async function downloadAndInstallInner(): Promise<void> {
  const { asset, needsExtract } = platformAsset();
  emitProgress("resolve", 0, 0, "正在获取下载地址");
  const api = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
  const relResp = await fetch(api, {
    redirect: "follow",
    headers: { "user-agent": "kova-desktop-cloudflared-installer", accept: "application/vnd.github+json" },
  });
  if (!relResp.ok) throw new Error(`GitHub API error: ${relResp.status}`);
  const rel: any = await relResp.json();
  const entry = (rel?.assets ?? []).find((a: any) => a?.name === asset);
  if (!entry) throw new Error(`release asset ${asset} not found`);
  const url = typeof entry.browser_download_url === "string" ? entry.browser_download_url : "";
  if (!url) throw new Error("asset has no download url");
  const digest = typeof entry.digest === "string" ? entry.digest : "";
  const expected = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
  if (!expected) {
    throw new Error(
      "GitHub did not provide a sha256 digest for this asset; refusing an unverified download — install cloudflared manually instead",
    );
  }

  // 流式下载 + 节流进度
  const resp = await fetch(url, { redirect: "follow", headers: { "user-agent": "kova-desktop-cloudflared-installer" } });
  if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
  const total = Number(resp.headers.get("content-length") ?? 0);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("download failed: no body");
  const chunks: Buffer[] = [];
  let received = 0;
  let lastEmit = 0;
  emitProgress("download", 0, total, "开始下载 cloudflared");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(Buffer.from(value));
      received += value.length;
      if (received > MAX_DOWNLOAD_BYTES) throw new Error(`download too large (> ${MAX_DOWNLOAD_BYTES} bytes)`);
      if (Date.now() - lastEmit >= PROGRESS_MIN_INTERVAL_MS) {
        const totalLabel = total > 0 ? fmtMb(total) : "?";
        emitProgress("download", received, total, `${fmtMb(received)} / ${totalLabel}`);
        lastEmit = Date.now();
      }
    }
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new Error("download returned no data");
  emitProgress("download", bytes.length, Math.max(total, bytes.length), fmtMb(bytes.length));

  emitProgress("verify", 0, 0, "正在校验文件");
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `cloudflared download failed checksum verification (expected ${expected}, got ${got}); nothing was installed`,
    );
  }

  emitProgress("install", 0, 0, "正在安装 cloudflared");
  const dir = join(appDataDir(), "bin");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, binaryFileName());
  const tmp = join(dir, `${binaryFileName()}.download`);

  try {
    if (needsExtract) {
      // 发布包是 .tgz：落盘后解出其中的 cloudflared（系统 tar，与 Rust 版解包语义一致）
      const tgz = join(dir, `${binaryFileName()}.download.tgz`);
      writeFileSync(tgz, bytes);
      const ex = spawnSync("tar", ["-xzf", tgz, "-C", dir], { windowsHide: true });
      rmSync(tgz, { force: true });
      if (ex.status !== 0) {
        throw new Error(`failed to read release archive: ${ex.stderr?.toString().trim() || `tar exit ${ex.status}`}`);
      }
      const extracted = join(dir, "cloudflared");
      if (!existsSync(extracted)) {
        throw new Error("cloudflared binary not found inside the release archive");
      }
      renameSync(extracted, tmp);
    } else {
      writeFileSync(tmp, bytes);
    }
    if (process.platform !== "win32") chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  // 冒烟：能跑起来才算装好（下载产物损坏/Gatekeeper 拦截都在这里暴露）
  const probe = spawnSync(target, ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.status === 0) {
    logInfo(`[tunnel] cloudflared installed: ${target} (${(probe.stdout ?? "").trim()})`);
    return;
  }
  if (probe.error) {
    throw new Error(`downloaded cloudflared failed to run (${probe.error.message}); kept at ${target} for inspection`);
  }
  throw new Error(`downloaded cloudflared exited with ${probe.status} on --version; kept at ${target} for inspection`);
}

async function downloadAndInstall(): Promise<void> {
  try {
    await downloadAndInstallInner();
    emitProgress("done", 0, 0, "下载完成");
  } catch (e: any) {
    emitProgress("error", 0, 0, String(e?.message ?? e));
    throw e;
  }
}

/* ------------------------------ 命令注册 ------------------------------ */

export function setupTunnelCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("pi_tunnel_status", async () => buildStatus());
  register("pi_tunnel_start", async () => {
    const port = currentPort();
    if (port === null) throw new Error("remote gateway is not running; start the gateway first");
    startInner(port);
    return buildStatus();
  });
  register("pi_tunnel_stop", async () => {
    stopInner();
    logInfo("[tunnel] stopped");
    return buildStatus();
  });
  register("pi_tunnel_set_binary", async (a) => {
    const p = typeof a?.path === "string" ? a.path.trim() : "";
    if (p.length > 0) {
      let isFile = false;
      try {
        isFile = statSync(p).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new Error(`${p} is not a file`);
      kvSet(BINARY_KV_KEY, p);
    } else {
      kvDelete(BINARY_KV_KEY);
    }
    return buildStatus();
  });
  register("pi_tunnel_download", async () => {
    await downloadAndInstall();
    return buildStatus();
  });
}

/** 同步停止（网关停止/重启、应用退出时调用；幂等，未运行无害） */
export function stopNow(): void {
  try {
    stopInner();
  } catch {
    /* ignore */
  }
}
