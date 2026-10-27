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
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { kvGet, kvSet } from "./store";
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

/** 渲染层可见形状：无秘密字段（hasPassword 只报告是否已保存） */
type SshHostPublic = Omit<SshHost, "passwordEnc"> & { hasPassword: boolean };

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
  const { passwordEnc, ...rest } = host;
  return { ...rest, hasPassword: typeof passwordEnc === "string" && passwordEnc.length > 0 };
}

/** 连接目标（含解密后的密码）：只在本进程与 sidecar 之间流转，绝不回渲染层 */
function authTarget(host: SshHost, withPassword: boolean): Record<string, unknown> {
  // 目标选择必须按 authType 而非调用方意图：
  // - 密码认证走 ssh2（不解析 ~/.ssh/config），只能显式 hostname；
  // - 其余（agent/私钥）保留 alias 直连，端口/用户名/密钥交给 ssh config。
  // 之前按 withPassword 分支，给别名主机（hostname 为空）注入出空 host，
  // 侧车直接拒绝——所有别名方式的远程会话都会挂。
  const passwordAuth = host.authType === "password";
  const target: Record<string, unknown> = {
    host: passwordAuth ? host.hostname.trim() : host.alias?.trim() || host.hostname.trim(),
  };
  if (!host.alias?.trim() || passwordAuth) {
    if (host.port && host.port !== 22) target.port = host.port;
    if (host.username?.trim()) target.username = host.username.trim();
    if (host.authType === "key" && host.privateKeyPath?.trim()) {
      target.privateKeyPath = host.privateKeyPath.trim();
    }
  }
  if (withPassword && passwordAuth && host.passwordEnc) {
    const dec = decrypt(host.passwordEnc);
    if (dec.ok && dec.value) target.password = dec.value;
  }
  return target;
}

/** 需要注入远程凭据的载荷类型（其余类型原样透传） */
const REMOTE_ENRICH_TYPES = new Set([
  "new_session",
  "prompt",
  "remote_fs_list",
  "remote_fs_read",
  "remote_fs_read_base64",
  "remote_fs_write",
  "remote_fs_mkdir",
  "remote_fs_touch",
  "remote_fs_rename",
  "remote_fs_delete",
  "remote_fs_move",
]);

/**
 * 远程绑定载荷的密码注入（pi-agent 的 piRequest 转发前调用）：
 * 渲染层只携带 hostId 引用，密码在这里解密注入——密码永不进入
 * 渲染层内存/日志；恢复会话时每次请求都会重新注入，天然无「重启丢密码」。
 * 非 new_session/prompt 或不带 hostId 的载荷原样透传（顺带剥掉 hostId）。
 */
export function enrichRemotePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as { type?: unknown; remote?: unknown };
  // 只有携带 remote 绑定语义的载荷需要注入（会话创建/每轮 prompt +
  // 右侧面板的 remote_fs_* 文件通道）
  if (!REMOTE_ENRICH_TYPES.has(String(p.type ?? ""))) return payload;
  const remote = p.remote;
  if (!remote || typeof remote !== "object") return payload;
  const r = remote as Record<string, unknown> & { hostId?: unknown };
  const { hostId: _hostId, ...rest } = r;
  if (typeof r.hostId !== "string" || !r.hostId) {
    return { ...p, remote: rest };
  }
  const host = readHosts().find((h) => h.id === r.hostId);
  if (!host) return { ...p, remote: rest };
  const target = authTarget(host, true);
  // 渲染层给的目标字段可能滞后（主机改过端口等）：以 main 的事实源为准，
  // 同时保留 hostId 之外的扩展字段语义（目前没有，保守合并）
  return { ...p, remote: { ...rest, ...target } };
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

/** Include 条目 → 绝对路径候选：带 `*` 的按同目录展开（ssh 只认基础 glob） */
function expandIncludeGlob(inc: string): string[] {
  const expanded = inc.startsWith("/") ? inc : join(homedir(), ".ssh", inc);
  if (!expanded.includes("*")) return [expanded];
  const dir = dirname(expanded);
  const pattern = basename(expanded);
  // glob 元字符转正则（只处理 * 与 ?，ssh Include 本身也只支持这些）
  const re = new RegExp(
    `^${pattern.replaceAll(/[.*?]/g, (c) => (c === "*" ? "(.*)" : c === "?" ? "(.)" : "\\."))}$`,
  );
  try {
    return readdirSync(dir)
      .filter((name) => re.test(name))
      .map((name) => join(dir, name));
  } catch {
    // 目录不可读/不存在：按空集合处理，不阻塞整体扫描
    return [];
  }
}

/** 通过 sidecar 的 ssh2 通道做连通/目录探测（密码只在 main→sidecar 管道内） */
async function probeViaSidecar(
  target: Record<string, unknown>,
  path: string | undefined,
): Promise<{ ok: boolean; message: string; ms: number }> {
  const { piRequest } = await import("./pi-agent");
  const line = await piRequest({
    payload: { type: "ssh_probe", target, ...(path ? { path } : {}) },
    timeoutMs: 15_000,
  });
  const res = JSON.parse(line) as { ok?: boolean; message?: string; ms?: number };
  return {
    ok: res.ok === true,
    message: typeof res.message === "string" ? res.message : "",
    ms: typeof res.ms === "number" ? res.ms : 0,
  };
}

/**
 * 扫描 ~/.ssh/config 的 Host 别名（含 Include 一层展开），供添加主机时下拉。
 * 不做 ssh -G 精化（Match 块/通配场景可能失真）——别名只作为「连接目标」保存，
 * 解析永远发生在 ssh 自身，失真不影响连通性。
 */function scanConfigAliases(): { alias: string }[] {
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
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.split("#")[0].trim();
      if (!line) continue;
      const m = /^(Host|Include)\s+(.+)$/i.exec(line);
      if (!m) continue;
      if (m[1].toLowerCase() === "include") {
        // Include 即遇即展开：放 pending 缓冲会漏掉「文件末尾的 Include」
        // 与连续 Include（ssh 语义里它在出现处生效）。带 glob 的 Include
        // （config.d/*.conf 常见）按目录展开，展开失败按空集合处理
        for (const inc of m[2].trim().split(/\s+/)) {
          for (const target of expandIncludeGlob(inc)) visit(target, depth + 1);
        }
        continue;
      }
      for (const pattern of m[2].trim().split(/\s+/)) {
        // 通配/取反模式不可直连；仅收集具体别名
        if (pattern === "*" || pattern.startsWith("!") || /[*?]/.test(pattern)) continue;
        out.add(pattern);
      }
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
    // 密码主机：ssh CLI 无法非交互输密码，探测器在 sidecar（ssh2）。
    // 密码在本进程解密直送 sidecar，不回渲染层。
    if (host.authType === "password") {
      const target = authTarget(host, true);
      if (!target.password) {
        return { ok: false, message: "未保存密码：请勾选「记住密码」后重试", ms: 0 };
      }
      return probeViaSidecar(target, undefined);
    }
    return testConnection(host);
  });

  register("ssh_host_scan_config", () => scanConfigAliases());

  /**
   * 保存前测试（未落库的草稿配置）：设置页/添加对话框点「保存」前先探通。
   * 密码主机经 sidecar ssh2 探针（密码取草稿明文，或按 id 复用已存密码）；
   * 密钥/agent 及别名主机走 CLI 探针。测试不写任何状态。
   */
  register("ssh_host_test_draft", async (a) => {
    const d = (a?.draft ?? {}) as {
      id?: unknown;
      alias?: unknown;
      hostname?: unknown;
      port?: unknown;
      username?: unknown;
      authType?: unknown;
      privateKeyPath?: unknown;
      password?: unknown;
    };
    const authType =
      d.authType === "key" || d.authType === "password" ? d.authType : "agent";
    const alias = typeof d.alias === "string" && d.alias.trim() ? d.alias.trim() : undefined;
    const hostname = typeof d.hostname === "string" ? d.hostname.trim() : "";
    if (!alias && !hostname) return { ok: false, message: "请填写主机地址", ms: 0 };
    const existing =
      typeof d.id === "string" && d.id ? readHosts().find((h) => h.id === d.id) : undefined;
    const draftHost: SshHost = {
      id: typeof d.id === "string" && d.id ? d.id : "__draft__",
      name: "",
      alias,
      hostname,
      port:
        typeof d.port === "number" && Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535
          ? d.port
          : undefined,
      username: typeof d.username === "string" && d.username.trim() ? d.username.trim() : undefined,
      authType,
      privateKeyPath:
        typeof d.privateKeyPath === "string" && d.privateKeyPath.trim()
          ? d.privateKeyPath.trim()
          : undefined,
      passwordEnc:
        authType === "password"
          ? typeof d.password === "string" && d.password
            ? encrypt(d.password)
            : existing?.passwordEnc
          : undefined,
      enabled: true,
      createdAt: "",
    };
    if (authType === "password") {
      if (!draftHost.hostname) {
        return { ok: false, message: "密码认证需要填写显式主机地址", ms: 0 };
      }
      const target = authTarget(draftHost, true);
      if (!target.password) {
        return { ok: false, message: "请填写 SSH 密码", ms: 0 };
      }
      return probeViaSidecar(target, undefined);
    }
    return testConnection(draftHost);
  });

  /** 远端目录浏览（新建远程项目选源文件夹）：列指定目录下的子目录 */
  register("ssh_host_list_dirs", async (a) => {
    const id = String(a?.hostId ?? "");
    const dir = String(a?.path ?? "/").trim() || "/";
    if (!dir.startsWith("/")) throw new Error("path must be absolute");
    const host = readHosts().find((h) => h.id === id);
    if (!host) throw new Error(`host not found: ${id}`);
    if (host.authType === "password") {
      const target = authTarget(host, true);
      if (!target.password) {
        return { ok: false, message: "未保存密码：请勾选「记住密码」后重试", dirs: [] };
      }
      const { piRequest } = await import("./pi-agent");
      const line = await piRequest({
        payload: { type: "ssh_list_dirs", target, path: dir },
        timeoutMs: 20_000,
      });
      const res = JSON.parse(line) as {
        ok?: boolean;
        path?: string;
        dirs?: string[];
        message?: string;
      };
      return {
        ok: res.ok === true,
        path: res.path ?? dir,
        dirs: Array.isArray(res.dirs) ? res.dirs : [],
        message: res.message ?? "",
      };
    }
    // 密钥/agent/别名：CLI 直接列（cd 后 pwd + ls -1p）
    const script =
      `cd '${dir.replaceAll("'", `'\\''`)}' 2>/dev/null && pwd && ls -1p`;
    const args = [
      ...sshBaseOptions(),
      ...portOptions(host),
      ...authOptions(host),
      targetOf(host),
      "--",
      `/bin/sh -c '${script.replaceAll("'", `'\\''`)}'`,
    ];
    return await new Promise((resolve) => {
      const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, dirs: [], message: "目录读取超时" });
      }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, dirs: [], message: `ssh 启动失败: ${error.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve({
            ok: false,
            dirs: [],
            message: stderr.trim().slice(0, 200) || "目录不可访问",
          });
          return;
        }
        const lines = stdout.split(/\r?\n/);
        const resolved = (lines[0] ?? dir).trim() || dir;
        const dirs = lines
          .slice(1)
          .map((line) => line.trim())
          .filter((line) => line.endsWith("/") && !line.startsWith("."))
          .map((line) => line.replace(/\/+$/, ""))
          .filter(Boolean)
          .sort((x, y) => x.localeCompare(y));
        resolve({ ok: true, path: resolved, dirs, message: "" });
      });
    });
  });

  /** 远端目录存在性校验（新建远程项目时保存前确认，避免会话里才炸） */
  register("ssh_host_check_dir", async (a) => {
    const id = String(a?.hostId ?? "");
    const dir = String(a?.path ?? "").trim();
    if (!dir.startsWith("/")) throw new Error("path must be absolute");
    const host = readHosts().find((h) => h.id === id);
    if (!host) throw new Error(`host not found: ${id}`);
    if (host.authType === "password") {
      const target = authTarget(host, true);
      if (!target.password) {
        return { exists: false, message: "未保存密码：请勾选「记住密码」后重试", ms: 0 };
      }
      const probe = await probeViaSidecar(target, dir);
      return { exists: probe.ok, message: probe.message, ms: probe.ms };
    }
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
