/**
 * 插件运行时状态与读模型：启用开关（kv 整包，默认启用，显式关闭记键）、
 * 已装插件扫描（签名缓存）、组件/图标解析、生效插件 hooks 读取。
 * 写路径（安装/卸载/市场操作）见 marketplaces.ts，经 invalidateCaches 失效本层缓存。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";
import {
  parsePluginManifest,
  readPluginHooksFile,
  asString,
  pluginsRootDir,
  type PluginHookEntry,
  type PluginComponents,
  type PluginManifest,
  type InstalledPlugin,
} from "./manifest";
import { readMarketplaceRecords } from "./registry";

// ---------------------------------------------------------------------------
// 启用开关（kv 整包，默认启用，显式关闭记键）
// ---------------------------------------------------------------------------

export type PluginsEnabledState = { disabled: Record<string, true> };

export const PLUGINS_ENABLED_KV_KEY = "pi.plugins";

let enabledState: PluginsEnabledState = { disabled: {} };
let stateLoad: Promise<void> | undefined;

/** 启动装配调一次（index.ts 闸门内）；幂等 */
export function initPluginsState(): Promise<void> {
  stateLoad ??= (async () => {
    try {
      const row = await kvGet(PLUGINS_ENABLED_KV_KEY);
      if (!row?.value) return;
      const parsed = JSON.parse(row.value) as Partial<PluginsEnabledState>;
      enabledState = { disabled: (parsed.disabled ?? {}) as Record<string, true> };
    } catch (err) {
      logErr("plugins-state:", err instanceof Error ? err.message : String(err));
    }
  })();
  return stateLoad;
}

async function persistEnabledState(): Promise<void> {
  try {
    await kvSet(PLUGINS_ENABLED_KV_KEY, JSON.stringify(enabledState));
  } catch (err) {
    logErr("plugins-state save:", err instanceof Error ? err.message : String(err));
  }
}

export function isPluginEnabled(pluginId: string): boolean {
  return enabledState.disabled[pluginId] !== true;
}

/** 卸载/安装路径清残留键（不改其余记录） */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
  await initPluginsState();
  if (enabled) delete enabledState.disabled[pluginId];
  else enabledState.disabled[pluginId] = true;
  await persistEnabledState();
  // 开关参与扫描缓存（enabled 字段）与各合并链签名：立即失效，下一次读取即生效
  invalidateCaches();
}

// ---------------------------------------------------------------------------
// 已装插件扫描（签名缓存；同步读取，init 后可用）
// ---------------------------------------------------------------------------

type ScanCache = { sig: string; plugins: InstalledPlugin[] };
let scanCache: ScanCache | undefined;

function cacheRootSignature(): string {
  const cacheDir = join(pluginsRootDir(), "cache");
  if (!existsSync(cacheDir)) return "";
  try {
    return readdirSync(cacheDir)
      .map((mkt) => {
        const mktDir = join(cacheDir, mkt);
        try {
          return `${mkt}:${readdirSync(mktDir).sort().join(",")}`;
        } catch {
          return `${mkt}:`;
        }
      })
      .sort()
      .join("|");
  } catch {
    return "";
  }
}

export function scanInstalledSync(): InstalledPlugin[] {
  const sig = cacheRootSignature();
  if (scanCache && scanCache.sig === sig) return scanCache.plugins;

  const records = readMarketplaceRecords();
  const mktNames = new Map(records.map((r) => [r.id, r.name]));
  const plugins: InstalledPlugin[] = [];
  const cacheDir = join(pluginsRootDir(), "cache");
  if (!existsSync(cacheDir)) {
    scanCache = { sig, plugins: [] };
    return plugins;
  }
  for (const mktId of readdirSync(cacheDir).sort()) {
    const mktDir = join(cacheDir, mktId);
    let names: string[];
    try {
      names = readdirSync(mktDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(mktDir, name);
      // 并发卸载的竞态：stat 失败按已消失处理，下次扫描自然收敛
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const pluginId = `${name}@${mktId}`;
      try {
        const manifest = parsePluginManifest(dir);
        let meta: Record<string, unknown> = {};
        const metaPath = join(dir, "installed.json");
        if (existsSync(metaPath)) {
          try {
            meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          } catch {
            /* 坏元数据按缺省处理 */
          }
        }
        plugins.push({
          pluginId,
          mktId,
          mktName: mktNames.get(mktId) ?? mktId,
          name: manifest.name,
          version: asString(meta.version) ?? manifest.version,
          ...(typeof meta.revision === "string" && meta.revision ? { revision: meta.revision } : {}),
          installedAt: typeof meta.installedAt === "string" ? meta.installedAt : "",
          sourceMissing: !mktNames.has(mktId),
          enabled: isPluginEnabled(pluginId),
          manifest,
          diagnostics: manifest.diagnostics,
        });
      } catch (err) {
        plugins.push({
          pluginId,
          mktId,
          mktName: mktNames.get(mktId) ?? mktId,
          name,
          version: "0.0.0",
          installedAt: "",
          sourceMissing: !mktNames.has(mktId),
          enabled: isPluginEnabled(pluginId),
          manifest: {
            name,
            version: "0.0.0",
            manifestKind: "xulux",
            root: dir,
            components: {},
            unsupported: [],
            diagnostics: [],
          },
          diagnostics: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
  }
  scanCache = { sig, plugins };
  return plugins;
}

/** 设置页/协议清单：全部已装插件（含禁用与坏清单，diagnostics 随行） */
export function listInstalledPlugins(): InstalledPlugin[] {
  return scanInstalledSync().map((p) => ({ ...p }));
}

/** 合并链用：启用的插件，pluginId 稳定排序（同名遮蔽顺序确定） */
export function activePlugins(): InstalledPlugin[] {
  return scanInstalledSync().filter((p) => p.enabled);
}

/** 插件根内组件绝对路径（再次包含性校验；未声明返回 undefined） */
export function resolvePluginComponent(
  manifest: PluginManifest,
  kind: keyof PluginComponents,
): string | undefined {
  const rel = manifest.components[kind];
  if (!rel) return undefined;
  const abs = resolve(manifest.root, rel);
  const rootWithSep = manifest.root.endsWith(sep) ? manifest.root : manifest.root + sep;
  if (!abs.startsWith(rootWithSep)) return undefined;
  return abs;
}

// ---------------------------------------------------------------------------
// 图标解析（载荷直接给可显示的 src：远程 URL 原样，本地文件读成 data URL）
// ---------------------------------------------------------------------------

const ICON_MAX_BYTES = 256 * 1024;

const ICON_MIME: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
};

export function readIconDataUrl(abs: string): string | undefined {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > ICON_MAX_BYTES || st.size === 0) return undefined;
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    const mime = ICON_MIME[ext];
    if (!mime) return undefined;
    return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * 插件清单图标 → 可显示 src：http(s)/data URL 原样返回；相对路径按插件根做
 * 包含性校验后读文件转 data URL（webview CSP img-src 已含 data:/https:）。
 */
export function resolvePluginIconDataUrl(manifest: PluginManifest): string | undefined {
  const icon = manifest.icon;
  if (!icon) return undefined;
  if (/^(https?:|data:)/i.test(icon)) return icon;
  const abs = resolve(manifest.root, icon);
  const rootWithSep = manifest.root.endsWith(sep) ? manifest.root : manifest.root + sep;
  if (!abs.startsWith(rootWithSep)) return undefined;
  return readIconDataUrl(abs);
}

// ---------------------------------------------------------------------------
// 运行时钩子读取（hooks.ts 的 matchingHooks 每次调用；文件签名缓存兜底）
// ---------------------------------------------------------------------------

const hookCache = new Map<string, { sig: string; hooks: PluginHookEntry[] }>();

function fileSignature(path: string): string {
  try {
    const st = statSync(path);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return "";
  }
}

/** 生效插件的全部 hooks（合并链入口，同事件/matcher 过滤在 hooks.ts 侧做） */
export function activePluginHooks(): PluginHookEntry[] {
  const out: PluginHookEntry[] = [];
  for (const plugin of activePlugins()) {
    const file = resolvePluginComponent(plugin.manifest, "hooks");
    if (!file) continue;
    const sig = fileSignature(file);
    const cached = hookCache.get(plugin.pluginId);
    if (cached && cached.sig === sig) {
      out.push(...cached.hooks);
      continue;
    }
    const diagnostics: string[] = [];
    const hooks = readPluginHooksFile(file, plugin.pluginId, plugin.name, diagnostics);
    hookCache.set(plugin.pluginId, { sig, hooks });
    for (const d of diagnostics) logErr(`plugin ${plugin.pluginId}:`, d);
    out.push(...hooks);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 市场/安装操作（写路径）
// ---------------------------------------------------------------------------

export function invalidateCaches(): void {
  scanCache = undefined;
  hookCache.clear();
  pluginsStateVersion += 1;
}

/**
 * 插件状态版本号：开关/安装/卸载/市场移除都会递增。MCP loadSync 把它并入
 * 文件签名——插件层缓存失效不能只靠文件 mtime（开关翻转不改任何文件）。
 */
let pluginsStateVersion = 0;

export function currentPluginsStateVersion(): number {
  return pluginsStateVersion;
}

/** 测试钩子：清内存缓存与 kv 装载（不删磁盘文件） */
export function resetPluginsForTest(): void {
  enabledState = { disabled: {} };
  stateLoad = undefined;
  scanCache = undefined;
  hookCache.clear();
}
