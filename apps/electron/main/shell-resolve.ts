import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Windows 上解析 bash：优先 Git Bash，最后才 cmd.exe。
 *
 * 关键是**过滤 WSL 转发器**：启用了 WSL 的机器 PATH 里永远有
 * `C:\Windows\System32\bash.exe`，它不是 bash，而是进默认 Linux 发行版
 * exec /bin/bash 的 stub——发行版缺失/损坏时会打出
 * `WSL (… - Relay) ERROR: CreateProcessCommon:800: execvpe(/bin/bash) failed`。
 * 而且 System32 永远排在 PATH 最前，按 PATH 顺序扫会让它压住 Git Bash；
 * 即使发行版是好的，WSL bash 的 cwd/路径语义也不适配 Windows 工作区。
 * 所以 Git Bash 候选前置，PATH 扫描跳过 System32 stub。
 */
export function resolveShellCommand(): { file: string; prefixArgs: string[] } {
  return resolveShell(process.platform, process.env, existsSync);
}

export function resolveShell(
  platform: string,
  env: { PATH?: string; LOCALAPPDATA?: string },
  exists: (path: string) => boolean,
  joinFn: typeof join = join,
): { file: string; prefixArgs: string[] } {
  if (platform !== "win32") return { file: "/bin/bash", prefixArgs: ["-c"] };

  // 第一步：Git Bash 安装位置（硬编码路径最稳；git.exe 反推兜住 portable/非标盘符）
  const dirs = (env.PATH ?? "").split(";").filter(Boolean);
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  if (env.LOCALAPPDATA) {
    candidates.push(joinFn(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }
  for (const d of dirs) {
    if (exists(joinFn(d, "git.exe"))) candidates.push(joinFn(d, "..", "bin", "bash.exe"));
  }
  for (const f of candidates) {
    if (exists(f)) return { file: f, prefixArgs: ["-c"] };
  }

  // 第二步：PATH 扫描，跳过 System32 的 WSL stub（分隔符归一后匹配，大小写不敏感）
  for (const d of dirs) {
    const f = joinFn(d, "bash.exe");
    if (f.toLowerCase().replace(/\\/g, "/").endsWith("windows/system32/bash.exe")) continue;
    if (exists(f)) return { file: f, prefixArgs: ["-c"] };
  }

  return { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c"] };
}
