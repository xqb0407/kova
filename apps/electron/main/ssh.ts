/**
 * SSH 主机管理（远程项目的前置）：主机的增删改查 + 连接测试。
 *
 * 存储：kv 表 `ssh.hosts`（JSON 数组）。密码/口令等秘密字段用 secret.ts 的
 * encrypt() 加密后内嵌（`aes:v1:` 前缀口径与 remote token 一致）；list 命令
 * 永远不把秘密值回传渲染层。v1 认证只支持密钥/agent（ssh CLI 直读 ~/.ssh/），
 * password 档位仅保存、执行侧在阶段 E（ssh2）才启用。
 *
 * 连接测试与执行共用同一组 ssh 基础参数（accept-new 免首次交互确认，
 * keepalive 对齐 ZCode sshAuth 的 15s×3 口径）；真正的工具执行在 sidecar
 * 侧（tools/remote/ssh-exec.ts），本模块只管配置与可达性。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kvGet, kvSet, kvDelete } from "./store";
import { logInfo, logWarn } from "./logging";
import { decrypt, encrypt } from "./secret";

const HOSTS_KEY = "ssh.hosts";
const TEST_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;

export type SshHost = {
  id: string;
  /** 显示名（默认取 alias || hostname） */
  name: string;
  /** ~/.ssh/config 别名：设置后执行侧可直接 `ssh <alias>`，配置随 ssh 走 */
  alias?: string;
  hostname: string;
  port?: number;
  username?: string;
  authType: "agent" | "key" | "password";
  privateKeyPath?: string;
  /** 加密存储（aes:v1: 前缀）；仅 password 档位，阶段 E 启用 */
  passwordEnc?: string;
  enabled: boolean;
  createdAt: string;
};

/** 渲染层可见形状：无秘密字段 */
type SshHostPublic = Omit<SshHost, "passwordEnc">;

function readHosts(): SshHost[] {
  const raw = kvGet(HOSTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SshHost[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    logWarn("[ssh] hosts kv corrupt, resetting");
    return [];
  }
}

function writeHosts(hosts: SshHost[]): void {
  kvSet(HOSTS_KEY, JSON.stringify(hosts));
}

function toPublic(host: SshHost): SshHostPublic {
  const { passwordEnc: _passwordEnc, ...rest } = host;
  return rest;
}

/** 执行侧（含测试）共用的 ssh 连接参数：非交互、免首次 host key 确认、保活 */
export function sshBaseOptions(): string[] {
  return [
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_MS / 1000}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
  ];
}

function authOptions(host: SshHost): string[] {
  const opts: string[] = [];
  if (host.authType === "key" && host.privateKeyPath?.trim()) {
    opts.push("-i", host.privateKeyPath.trim());
    opts.push("-o", "IdentitiesOnly=yes");
  }
  if (host.username?.trim()) {
    // user@host 形式在 target 拼接处处理，这里只记录用户名
  }
  return opts;
}

/** `user@host`（或 alias）；alias 存在时优先用 alias——端口/用户名/密钥随 ssh config */
function targetOf(host: SshHost): string {
  if (host.alias?.trim()) return host.alias.trim();
  const user = host.username?.trim();
  return user ? `${user}@${host.hostname.trim()}` : host.hostname.trim();
}

function portOptions(host: SshHost): string[] {
  // alias 直连时端口交给 ssh config；显式 host 才传 -p
  if (host.alias?.trim()) return [];
  return host.port && host.port !== 22 ? ["-p", String(host.port)] : [];
}

function testConnection(host: SshHost): Promise<{ ok: boolean; message: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const args = [
      ...sshBaseOptions(),
      ...portOptions(host),
      ...authOptions(host),
      targetOf(host),
      "--",
      "printf __kova_ssh_ok__",
    ];
    let settled = false;
    let stderr = "";
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, message: `连接超时（${TEST_TIMEOUT_MS / 1000}s）`, ms: Date.now() - started });
    }, TEST_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (chunk.toString("utf8").includes("__kova_ssh_ok__")) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve({ ok: true, message: "连接成功", ms: Date.now() - started });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: `ssh 启动失败: ${error.message}`, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `连接失败（exit ${code}）: ${stderr.trim().split("\n").slice(-3).join(" ") || "无诊断输出"}`,
        ms: Date.now() - started,
      });
    });
  });
}

/**
 * 扫描 ~/.ssh/config 的 Host 别名（含 Include 一层展开），供添加主机时下拉。
 * 不做 ssh -G 精化（Match 块/通配场景可能失真）——别名只作为「连接目标」保存，
 * 解析永远发生在 ssh 自身，失真不影响连通性。
 */
function scanConfigAliases(): { alias: string }[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string, depth: number): void => {
    const normalized = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
    if (seen.has(normalized) || depth > 4) return;
    seen.add(normalized);
    let content = "";
    try {
      content = readFileSync(normalized, "utf8");
    } catch {
      return;
    }
    let pendingIncludes: string[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.split("#")[0].trim();
      if (!line) continue;
      const m = /^(Host|Include)\s+(.+)$/i.exec(line);
      if (!m) continue;
      if (m[1].toLowerCase() === "include") {
        pendingIncludes = m[2].trim().split(/\s+/);
        continue;
      }
      for (const pattern of m[2].trim().split(/\s+/)) {
        // 通配/取反模式不可直连；仅收集具体别名
        if (pattern === "*" || pattern.startsWith("!") || /[*?]/.test(pattern)) continue;
        out.add(pattern);
      }
      // Include 常跟在 Host 段内/外，展开一次即可（相对路径按 ~/.ssh/ 解）
      for (const inc of pendingIncludes) {
        const incPath = /^\.\//.test(inc) ? join(normalized, "..", inc) : join(homedir(), ".ssh", inc);
        visit(incPath, depth + 1);
      }
      pendingIncludes = [];
    }
  };
  visit(join(homedir(), ".ssh", "config"), 0);
  return [...out].sort().map((alias) => ({ alias }));
}

/* ------------------------------ 命令注册 ------------------------------ */

export function setupSshCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("ssh_host_list", () => readHosts().map(toPublic));

  register("ssh_host_save", (a) => {
    const input = a?.host;
    if (!input || typeof input !== "object") throw new Error("host payload required");
    const hosts = readHosts();
    const id = typeof input.id === "string" && input.id ? input.id : randomUUID();
    const authType = input.authType === "key" || input.authType === "password" ? input.authType : "agent";
    const hostname = String(input.hostname ?? "").trim();
    if (!hostname && !String(input.alias ?? "").trim()) {
      throw new Error("hostname 或 alias 至少填一个");
    }
    const existing = hosts.find((h) => h.id === id);
    const next: SshHost = {
      id,
      name: String(input.name ?? "").trim() || String(input.alias ?? "").trim() || hostname,
      alias: typeof input.alias === "string" && input.alias.trim() ? input.alias.trim() : undefined,
      hostname,
      port: Number.isInteger(input.port) && input.port > 0 && input.port <= 65535 ? input.port : undefined,
      username: typeof input.username === "string" && input.username.trim() ? input.username.trim() : undefined,
      authType,
      privateKeyPath:
        authType === "key" && typeof input.privateKeyPath === "string" && input.privateKeyPath.trim()
          ? input.privateKeyPath.trim()
          : undefined,
      // 未回传密码（list 已脱敏）时保留旧值；显式空串 = 清除
      passwordEnc:
        authType === "password"
          ? typeof input.password === "string" && input.password.length > 0
            ? encrypt(input.password)
            : existing?.passwordEnc
          : undefined,
      enabled: input.enabled !== false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx >= 0) hosts[idx] = next;
    else hosts.push(next);
    writeHosts(hosts);
    logInfo(`[ssh] host saved: ${next.name}`);
    return toPublic(next);
  });

  register("ssh_host_delete", (a) => {
    const id = String(a?.id ?? "");
    if (!id) throw new Error("id required");
    const hosts = readHosts();
    const next = hosts.filter((h) => h.id !== id);
    if (next.length === hosts.length) throw new Error(`host not found: ${id}`);
    writeHosts(next);
    logInfo(`[ssh] host deleted: ${id}`);
    return null;
  });

  register("ssh_host_test", async (a) => {
    const id = String(a?.id ?? "");
    const host = readHosts().find((h) => h.id === id);
    if (!host) throw new Error(`host not found: ${id}`);
    return testConnection(host);
  });

  register("ssh_host_scan_config", () => scanConfigAliases());

  /** 远端目录存在性校验（新建远程项目时保存前确认，避免会话里才炸） */
  register("ssh_host_check_dir", async (a) => {
    const id = String(a?.hostId ?? "");
    const dir = String(a?.path ?? "").trim();
    if (!dir.startsWith("/")) throw new Error("path must be absolute");
    const host = readHosts().find((h) => h.id === id);
    if (!host) throw new Error(`host not found: ${id}`);
    const started = Date.now();
    const args = [
      ...sshBaseOptions(),
      ...portOptions(host),
      ...authOptions(host),
      targetOf(host),
      "--",
      `test -d '${dir.replaceAll("'", `'\\''`)}'`,
    ];
    return await new Promise<{ exists: boolean; message: string; ms: number }>((resolve) => {
      const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ exists: false, message: "校验超时", ms: Date.now() - started });
      }, TEST_TIMEOUT_MS);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exists: false, message: `ssh 启动失败: ${error.message}`, ms: Date.now() - started });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exists: code === 0,
          message: code === 0 ? "目录存在" : `目录不存在或不可访问: ${stderr.trim().slice(0, 200)}`,
          ms: Date.now() - started,
        });
      });
    });
  });
}
