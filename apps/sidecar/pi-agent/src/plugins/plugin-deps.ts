/**
 * 插件依赖安装（Codex/Node 插件常见：package.json + node_modules 才能启动 MCP）。
 *
 * 只在用户显式点击「安装依赖」时执行：默认 `npm ci --omit=dev --ignore-scripts`
 * （无 lockfile 用 `npm install`），避免 postinstall 脚本扩大信任面。npm 不在
 * PATH 时回退内置 bun（`bun install --production --ignore-scripts`）。
 *
 * 并发按插件根去重：同一插件重复点击复用同一个 promise；不同插件可并行。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PluginDepsStatus = {
  hasPackageJson: boolean;
  hasLockfile: boolean;
  hasNodeModules: boolean;
  /** 可执行安装（有 package.json 且缺 node_modules） */
  installable: boolean;
  /** 依赖是否缺失（有 package.json 但没有 node_modules） */
  missing: boolean;
};

export type PluginDepsInstallResult = {
  ok: boolean;
  code: number | null;
  command: string;
  /** 末尾输出（已脱敏/截断），失败时给用户排查 */
  output: string;
};

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const inFlight = new Map<string, Promise<PluginDepsInstallResult>>();

/**
 * package.json 是否声明了运行期依赖。只有元数据、没有 dependencies 的包
 * `npm install --omit=dev` 不会创建 node_modules；若只看目录存在性，UI 会永远
 * 显示“依赖未安装”且点安装也不消失。devDependencies 不参与（安装命令 omit 掉）。
 */
function packageHasRuntimeDeps(root: string): boolean {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return true;
    const record = doc as Record<string, unknown>;
    return ["dependencies", "optionalDependencies", "peerDependencies"].some((key) => {
      const value = record[key];
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0
      );
    });
  } catch {
    // package.json 坏了：保留安装入口，让 npm 给出真实错误
    return true;
  }
}

export function pluginDepsStatus(pluginRoot: string): PluginDepsStatus {
  const root = resolve(pluginRoot);
  const hasPackageJson = existsSync(join(root, "package.json"));
  const hasLockfile =
    existsSync(join(root, "package-lock.json")) ||
    existsSync(join(root, "npm-shrinkwrap.json"));
  const hasNodeModules = existsSync(join(root, "node_modules"));
  const missing =
    hasPackageJson && !hasNodeModules && packageHasRuntimeDeps(root);
  return { hasPackageJson, hasLockfile, hasNodeModules, installable: missing, missing };
}

/** 简单脱敏：registry token / Authorization / URL userinfo */
function redact(text: string): string {
  return text
    .replace(/(_authToken\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@");
}

function tail(text: string): string {
  const buf = Buffer.from(text, "utf8");
  return buf.length > OUTPUT_TAIL_BYTES
    ? `…${buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8")}`
    : text;
}

function runInstall(root: string): Promise<PluginDepsInstallResult> {
  const status = pluginDepsStatus(root);
  const npmArgs = [
    status.hasLockfile ? "ci" : "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  const isWindows = process.platform === "win32";
  const npm = isWindows ? "npm.cmd" : "npm";

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    let settled = false;
    let fallbackStarted = false;
    const finish = (result: PluginDepsInstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    /** npm 会派生子进程；非 Windows 上 detached 建了进程组，超时要整组杀掉 */
    const killChildTree = () => {
      const pid = child?.pid;
      if (!pid) return;
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child?.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      // npm 可能忽略 SIGTERM：给 2 秒清理时间后强杀整组
      const force = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child?.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, 2_000);
      force.unref?.();
    };
    const timer = setTimeout(() => {
      killChildTree();
      finish({
        ok: false,
        code: null,
        command: `${npm} ${npmArgs.join(" ")}`,
        output: tail(redact(`${output}\n[timeout after ${INSTALL_TIMEOUT_MS / 1000}s]`)),
      });
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

    const spawnInstall = (command: string, args: string[], env?: Record<string, string>) => {
      output = "";
      try {
        // Windows 上 .cmd/.bat 不能由 CreateProcess 直接执行（Node 18+ 会
        // EINVAL）；只有 npm.cmd 走 shell，process.execPath 仍直接 spawn。
        const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
        child = spawn(command, args, {
          cwd: root,
          env: { ...process.env, ...(env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
          ...(useShell ? { shell: true } : {}),
        });
      } catch (err) {
        finish({
          ok: false,
        code: null,
        command: `${command} ${args.join(" ")}`,
        output: redact(err instanceof Error ? err.message : String(err)),
      });
        return;
      }
      const collect = (chunk: Buffer | string) => {
        output += String(chunk);
        if (output.length > OUTPUT_TAIL_BYTES * 2) {
          output = output.slice(-OUTPUT_TAIL_BYTES * 2);
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (err) => {
        // npm 不在 PATH：回退内置 bun（编译态 sidecar 以 bun 语义运行）
        if (
          (err as NodeJS.ErrnoException).code === "ENOENT" &&
          !fallbackStarted &&
          command !== process.execPath
        ) {
          fallbackStarted = true;
          spawnInstall(
            process.execPath,
            ["install", "--production", "--ignore-scripts"],
            { BUN_BE_BUN: "1" },
          );
          return;
        }
        finish({
          ok: false,
          code: null,
          command: `${command} ${args.join(" ")}`,
          output: tail(redact(`${output}\n${err.message}`)),
        });
      });
      child.on("close", (code) => {
        // 旧 npm 进程的 close 会在回退 bun 启动后到达：忽略，让 bun 的结果收口
        if (fallbackStarted && command !== process.execPath) return;
        finish({
          ok: code === 0,
          code,
          command: `${command} ${args.join(" ")}`,
          output: tail(redact(output)),
        });
      });
    };

    spawnInstall(npm, npmArgs);
  });
}

/** 安装插件依赖（同一插件根并发去重）；调用方负责用户确认。 */
export function installPluginDeps(pluginRoot: string): Promise<PluginDepsInstallResult> {
  const root = resolve(pluginRoot);
  const existing = inFlight.get(root);
  if (existing) return existing;
  const status = pluginDepsStatus(root);
  if (!status.hasPackageJson) {
    return Promise.resolve({
      ok: false,
      code: null,
      command: "",
      output: "插件没有 package.json，无需安装依赖",
    });
  }
  const task = runInstall(root).finally(() => {
    inFlight.delete(root);
  });
  inFlight.set(root, task);
  return task;
}
