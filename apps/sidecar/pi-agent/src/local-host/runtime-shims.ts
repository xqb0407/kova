/**
 * 应用内置运行时的 PATH 补丁。
 *
 * 打包态从 Dock 启动时 PATH 往往只有 `/usr/bin:/bin:/usr/sbin:/sbin`，而
 * Codex 插件的 MCP 启动脚本与 hooks 普遍直接调用 `node`。找不到系统 node
 * 时，把 sidecar 运行时（bun 语义）以 `node` 之名放进 0700 临时目录，并
 * 前置到子进程 PATH；配合 BUN_BE_BUN=1 即按 bun CLI 运行。
 *
 * 仅 POSIX：Windows 没有软链语义，MCP 的直接 `command: "node"` 回退由
 * mcp-manager 用 process.execPath 处理。
 */
import { mkdtempSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 命令是否能在 PATH 上找到（含 Windows PATHEXT）；带路径分隔符的原样交给 spawn */
export function commandOnPath(
  command: string,
  pathValue = process.env.PATH ?? process.env.Path ?? "",
): boolean {
  if (command.includes("/") || command.includes("\\")) return true;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(dir, command + ext)).isFile()) return true;
      } catch {
        /* 继续找 */
      }
    }
  }
  return false;
}

/** 内置运行时的 `node` 软链目录（进程内只建一次，0700 临时目录） */
let nodeShimDir: string | null | undefined;
export function ensureNodeShimDir(): string | undefined {
  if (nodeShimDir !== undefined) return nodeShimDir ?? undefined;
  if (process.platform === "win32") {
    nodeShimDir = null;
    return undefined;
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), "kova-node-bin-"));
    symlinkSync(process.execPath, join(dir, "node"));
    nodeShimDir = dir;
    return dir;
  } catch {
    nodeShimDir = null;
    return undefined;
  }
}

/** 返回前置了 node 软链的 PATH；内置运行时不可用时返回 undefined */
export function pathWithNodeShim(
  basePath = process.env.PATH ?? process.env.Path ?? "",
): string | undefined {
  const dir = ensureNodeShimDir();
  if (!dir) return undefined;
  return basePath ? `${dir}:${basePath}` : dir;
}
