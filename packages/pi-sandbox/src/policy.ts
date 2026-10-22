import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWithinAnyRoots, realResolve } from "./paths";
import {
  SANDBOX_FALLBACKS,
  SANDBOX_NETWORKS,
  SANDBOX_TIERS,
  type SandboxConfig,
  type SandboxFallback,
  type SandboxNetwork,
  type SandboxPlan,
  type SandboxPlatform,
  type SandboxTier,
} from "./types";

export const DEFAULT_SANDBOX_CONFIG: Readonly<SandboxConfig> = Object.freeze({
  // 发布默认关闭：用户在设置页显式开启「工作区」档后才生效。
  tier: "off",
  network: "allow",
  allowPackageCaches: true,
  onUnavailable: "deny",
});

export type BuildSandboxPlanInput = {
  cwd: string;
  externalDirs?: readonly string[];
  writeRoots?: readonly string[];
  tempRoot: string;
  config?: SandboxConfig;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  /** 测试注入：缓存目录是否存在。默认 existsSync。 */
  pathExists?: (path: string) => boolean;
};

/** 宽松规整：坏值回落到默认，配置来自设置页，不能因为一个字段把沙箱整个关掉。 */
export function normalizeSandboxConfig(raw: unknown): SandboxConfig {
  const value =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const tier: SandboxTier = (SANDBOX_TIERS as readonly unknown[]).includes(value.tier)
    ? (value.tier as SandboxTier)
    : DEFAULT_SANDBOX_CONFIG.tier;
  const network: SandboxNetwork = (SANDBOX_NETWORKS as readonly unknown[]).includes(
    value.network,
  )
    ? (value.network as SandboxNetwork)
    : DEFAULT_SANDBOX_CONFIG.network;
  const onUnavailable: SandboxFallback = (SANDBOX_FALLBACKS as readonly unknown[]).includes(
    value.onUnavailable,
  )
    ? (value.onUnavailable as SandboxFallback)
    : DEFAULT_SANDBOX_CONFIG.onUnavailable;
  return {
    tier,
    network,
    allowPackageCaches:
      typeof value.allowPackageCaches === "boolean"
        ? value.allowPackageCaches
        : DEFAULT_SANDBOX_CONFIG.allowPackageCaches,
    onUnavailable,
  };
}

/**
 * 由会话事实生成沙箱计划。纯函数：不读配置中心、不写盘，只做路径归一。
 *
 * 写入根 = cwd + 用户挂载的外部目录 + 本机 write roots + 会话临时目录 + 包缓存。
 * 读取拒绝根 = 常见凭据目录；workspace 档其余读取放行，strict 档由 readRoots 接管。
 */
export function buildSandboxPlan(input: BuildSandboxPlanInput): SandboxPlan | null {
  const config = normalizeSandboxConfig(input.config ?? DEFAULT_SANDBOX_CONFIG);
  if (config.tier === "off") return null;

  const platform = normalizePlatform(input.platform ?? process.platform);
  const home = input.homeDir ?? homedir();
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? existsSync;

  const cwd = realResolve(input.cwd);
  const tempRoot = realResolve(input.tempRoot);
  const writeRoots = uniqueResolved([
    cwd,
    ...(input.externalDirs ?? []),
    ...(input.writeRoots ?? []),
    tempRoot,
  ]);
  const cacheRoots = config.allowPackageCaches
    ? uniqueResolved(packageCacheRoots(platform, home, env).filter(pathExists))
    : [];
  const denyReadRoots = uniqueResolved(secretRoots(platform, home, env));
  // 授权清单本身不能由 Agent 写：否则它可以先把自己的目录加进 write roots，
  // 下一次 plan 就自动放行。项目共享清单同样禁写，避免污染团队配置。
  const denyWritePaths = uniqueResolved([
    join(cwd, ".kova", "permissions.json"),
    join(cwd, ".kova", "permissions.local.json"),
    join(home, ".kova", "permissions.json"),
    join(home, ".kova", "permissions.local.json"),
  ]);
  // 写根上限：超出时丢弃多余的包缓存根（保留授权目录），防止 Seatbelt
  // profile / 命令行长度失控；丢弃只影响缓存可写性，不削弱隔离。
  const MAX_WRITE_ROOTS = 128;
  const allWriteRoots = uniqueResolved([...writeRoots, ...cacheRoots]);
  const effectiveWriteRoots =
    allWriteRoots.length > MAX_WRITE_ROOTS
      ? allWriteRoots.slice(0, MAX_WRITE_ROOTS)
      : allWriteRoots;

  return {
    version: 1,
    tier: "workspace",
    platform,
    cwd,
    // strict 档预留；workspace 档只使用 denyReadRoots。
    readRoots: [],
    denyReadRoots,
    denyWritePaths,
    writeRoots: effectiveWriteRoots,
    tempRoots: [tempRoot],
    cacheRoots,
    network: config.network,
    onUnavailable: config.onUnavailable,
  };
}

export function planAllowsWrite(plan: SandboxPlan, target: string): boolean {
  const real = realResolve(target);
  // 授权清单按"大小写折叠 + 去尾分隔符"比较：Windows 文件系统大小写不敏感，
  // `.KOVA/permissions.local.json` 这类变体不能绕过禁写。
  if (plan.denyWritePaths.some((path) => samePath(real, realResolve(path)))) {
    return false;
  }
  return isWithinAnyRoots(real, plan.writeRoots);
}

function samePath(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/[\\/]+$/, "");
  const [pa, pb] = [strip(a), strip(b)];
  if (process.platform === "win32") {
    return pa.toLowerCase() === pb.toLowerCase();
  }
  return pa === pb;
}

export function planAllowsRead(plan: SandboxPlan, target: string): boolean {
  if (plan.readRoots.length > 0) {
    return isWithinAnyRoots(target, plan.readRoots);
  }
  return !isWithinAnyRoots(target, plan.denyReadRoots);
}

export function planAllowsNetwork(plan: SandboxPlan): boolean {
  return plan.network === "allow";
}

export function writeDeniedMessage(plan: SandboxPlan, target: string): string {
  const real = realResolve(target);
  if (plan.denyWritePaths.some((path) => samePath(real, realResolve(path)))) {
    return (
      `sandbox: write denied: ${target}. This file is protected (sandbox authorization). ` +
      "Change permissions through settings or the approval card, not by editing it."
    );
  }
  const allowed = plan.writeRoots.slice(0, 6).join(", ");
  const more = plan.writeRoots.length > 6 ? ", …" : "";
  return (
    `sandbox: write denied: ${target}. Allowed write roots: ${allowed}${more}. ` +
    "Add the directory as a project directory or write root in settings if this is intended."
  );
}

export function readDeniedMessage(target: string): string {
  return `sandbox: read denied: ${target}. This path is in the sandbox deny list.`;
}

export function networkDeniedMessage(): string {
  return "sandbox: network disabled by sandbox.";
}

export function unavailableMessage(backend: string): string {
  return (
    `sandbox: backend unavailable (${backend}). Command not executed. ` +
    "Set sandbox mode to off or allow fallback in settings."
  );
}

function normalizePlatform(platform: NodeJS.Platform): SandboxPlatform {
  return platform === "darwin" || platform === "win32" || platform === "linux"
    ? platform
    : "other";
}

function uniqueResolved(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const resolved = realResolve(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function packageCacheRoots(
  platform: SandboxPlatform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === "darwin") {
    return [
      join(home, "Library", "Caches"),
      join(home, ".npm"),
      join(home, ".bun", "install", "cache"),
      join(home, "Library", "pnpm"),
      join(home, ".cache"),
      join(home, ".yarn", "berry", "cache"),
      join(home, ".cargo", "registry"),
      join(home, "go", "pkg", "mod"),
      join(home, ".gradle", "caches"),
      join(home, ".m2", "repository"),
    ];
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(localAppData, "npm-cache"),
      join(localAppData, "Yarn", "Cache"),
      join(localAppData, "pnpm", "store"),
      join(home, ".bun", "install", "cache"),
      join(home, ".cargo", "registry"),
      join(home, "go", "pkg", "mod"),
      join(home, ".gradle", "caches"),
      join(home, ".m2", "repository"),
    ];
  }
  if (platform === "linux") {
    return [
      join(home, ".npm"),
      join(home, ".cache"),
      join(home, ".bun", "install", "cache"),
      join(home, ".cargo", "registry"),
      join(home, "go", "pkg", "mod"),
      join(home, ".gradle", "caches"),
      join(home, ".m2", "repository"),
      join(home, ".yarn", "berry", "cache"),
    ];
  }
  return [];
}

function secretRoots(
  platform: SandboxPlatform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  const common = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".git-credentials"),
  ];
  if (platform === "darwin") {
    return [...common, join(home, "Library", "Keychains")];
  }
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return [...common, join(appData, "gcloud")];
  }
  return common;
}
