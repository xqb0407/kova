/**
 * 内置插件包（随 app 分发的首方插件）的装载、启动同步与市场读模型。
 *
 * 包 = src/plugins/bundle/kova-plugins.zip（scripts/build-builtin-plugins-zip.ts
 * 从仓库 plugins/ 生成；构建产物不入库，缺失时 ensure:bundle 自愈重打），由
 * `import ... with { type: "file" }` 嵌进
 * bun --compile 单文件二进制（dev 走磁盘路径；测试经 setBuiltinBundleBytesForTest
 * 注入；PI_BUILTIN_PLUGINS_ZIP 可指向别处的包，为未来改走 Tauri resources 留口）。
 *
 * 启动同步 syncBuiltinPlugins()（手法对齐 design-md/builtin-sync.ts）：
 * - 物化位置 cache/builtin/<name>/（身份 `name@builtin`，「本地安装」同族的伪市场），
 *   扫描/合并链/面板读模型天然复用，四链零改动；
 * - `.sync.json` 记包 bundleVersion（内容聚合 hash）：版本一致 = 只补缺失条目，
 *   版本变更 = 全量重物化 + 剪掉包内已不存在的旧条目（app 升级即内置插件升级）；
 * - 同名让位：其他市场已有**启用**的同名插件时不物化内置条目（开发机链接装/本地装
 *   不受打扰；运行期同名遮蔽由 store.activePlugins 的让位过滤兜底）；
 * - 失败非致命（logErr），内置缺失不阻断启动。
 *
 * 更新双通道：随 app 换包自动重同步；日后官方在线市场发布同名新版走"同名让位"，
 * 两通道互不打架。内置条目不可卸载/刷新（marketplaces.ts 拒绝），可禁用（kv）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import zipUrl from "./bundle/kova-plugins.zip" with { type: "file" };
import { logErr } from "../log";
import {
  asString,
  isRecord,
  installedPluginDir,
  pluginsRootDir,
  PLUGIN_NAME_RE,
  BUILTIN_MKT_ID,
  BUILTIN_MKT_NAME,
  type CatalogPluginEntry,
} from "./manifest";
import { invalidateCaches, resolvePluginIconDataUrl, scanInstalledSync } from "./store";

// ---------------------------------------------------------------------------
// 包装载（一次解析驻留内存：条目文件 + catalog 元数据）
// ---------------------------------------------------------------------------

type BuiltinBundlePlugin = {
  name: string;
  version: string;
  /** zip 内相对路径（"<name>/" 前缀已剥离，正斜杠）→ 内容字节 */
  files: Record<string, Uint8Array>;
};

type BuiltinBundle = {
  bundleVersion: string;
  plugins: BuiltinBundlePlugin[];
};

let bundle: BuiltinBundle | null = null;
let loadError: string | null = null;

/** 测试注入的包字节（优先于 env 与内嵌 zip；null 清除） */
let bundleBytesOverride: Uint8Array | null = null;

export function setBuiltinBundleBytesForTest(bytes: Uint8Array | null): void {
  bundleBytesOverride = bytes;
  bundle = null;
  loadError = null;
}

/** 测试钩子：清装载缓存（换 env 重定向后需重读） */
export function resetBuiltinBundleForTest(): void {
  bundle = null;
  loadError = null;
}

async function readZipBytes(): Promise<Uint8Array> {
  if (bundleBytesOverride) return bundleBytesOverride;
  const env = asString(process.env.PI_BUILTIN_PLUGINS_ZIP);
  return new Uint8Array(await Bun.file(env ? resolve(env) : zipUrl).arrayBuffer());
}

function parseBundle(files: Record<string, Uint8Array>): BuiltinBundle {
  const catalogRaw = files["catalog.json"];
  if (!catalogRaw) throw new Error("内置插件包缺 catalog.json");
  let doc: unknown;
  try {
    doc = JSON.parse(strFromU8(catalogRaw));
  } catch (err) {
    throw new Error(`catalog.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc) || typeof doc.bundleVersion !== "string" || !Array.isArray(doc.plugins)) {
    throw new Error("catalog.json 结构非法（需 bundleVersion + plugins[]）");
  }
  const byName = new Map<string, BuiltinBundlePlugin>();
  for (const raw of doc.plugins) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name);
    if (!name || !PLUGIN_NAME_RE.test(name)) continue;
    byName.set(name, { name, version: asString(raw.version) ?? "0.0.0", files: {} });
  }
  for (const [key, bytes] of Object.entries(files)) {
    if (key === "catalog.json") continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const plugin = byName.get(key.slice(0, slash));
    if (!plugin) continue; // 条目不在 catalog 名单：忽略（打包端已校验，读端宽容）
    plugin.files[key.slice(slash + 1)] = bytes;
  }
  const plugins = [...byName.values()].filter((p) => Object.keys(p.files).length > 0);
  if (plugins.length === 0) throw new Error("内置插件包为空（catalog 无有效条目）");
  return { bundleVersion: doc.bundleVersion, plugins };
}

async function loadBuiltinBundle(): Promise<BuiltinBundle> {
  if (bundle) return bundle;
  if (loadError) throw new Error(loadError);
  try {
    bundle = parseBundle(unzipSync(await readZipBytes()));
    return bundle;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    throw new Error(loadError);
  }
}

// ---------------------------------------------------------------------------
// 启动同步
// ---------------------------------------------------------------------------

export type BuiltinSyncResult = {
  status: "noop" | "synced" | "failed";
  error?: string;
  /** 本次首装的插件名 */
  installed: string[];
  /** 本次因版本变更重物化的插件名 */
  updated: string[];
  /** 包内已不存在、被剪掉的旧条目名 */
  removed: string[];
  /** 被同名启用插件让位跳过的插件名 */
  skipped: string[];
};

function builtinCacheDir(): string {
  return join(pluginsRootDir(), "cache", BUILTIN_MKT_ID);
}

function syncMarkerPath(): string {
  return join(builtinCacheDir(), ".sync.json");
}

function readSyncMarker(): { bundleVersion?: string } | undefined {
  try {
    const doc = JSON.parse(readFileSync(syncMarkerPath(), "utf8"));
    return isRecord(doc) ? (doc as { bundleVersion?: string }) : undefined;
  } catch {
    return undefined;
  }
}

function materializePlugin(pl: BuiltinBundlePlugin, b: BuiltinBundle, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [rel, bytes] of Object.entries(pl.files)) {
    const parts = rel.split("/");
    mkdirSync(join(dest, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dest, ...parts), bytes);
  }
  const meta = {
    pluginId: `${pl.name}@${BUILTIN_MKT_ID}`,
    name: pl.name,
    marketplaceId: BUILTIN_MKT_ID,
    marketplaceName: BUILTIN_MKT_NAME,
    version: pl.version,
    revision: `builtin-${b.bundleVersion.slice(0, 12)}`,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(join(dest, "installed.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/**
 * 内置插件包同步（启动闸门调用；永不抛——失败记 failed 返回，调用方无需兜底）。
 */
export async function syncBuiltinPlugins(): Promise<BuiltinSyncResult> {
  const none = { installed: [] as string[], updated: [] as string[], removed: [] as string[], skipped: [] as string[] };
  try {
    const b = await loadBuiltinBundle();
    const dir = builtinCacheDir();
    const upToDate = readSyncMarker()?.bundleVersion === b.bundleVersion;

    // 同名让位：其他市场有启用中的同名插件 → 该名字不物化内置条目
    const occupied = new Set(
      scanInstalledSync()
        .filter((p) => p.mktId !== BUILTIN_MKT_ID && p.enabled)
        .map((p) => p.name),
    );
    const inBundle = new Set(b.plugins.map((p) => p.name));

    const installed: string[] = [];
    const updated: string[] = [];
    const skipped: string[] = [];
    for (const pl of b.plugins) {
      const dest = installedPluginDir(BUILTIN_MKT_ID, pl.name);
      if (occupied.has(pl.name)) {
        skipped.push(pl.name);
        continue;
      }
      const present = existsSync(dest) && statSync(dest).isDirectory();
      if (present && upToDate) continue;
      materializePlugin(pl, b, dest);
      (present ? updated : installed).push(pl.name);
    }

    // 剪旧：cache/builtin 下不在包内的目录（.sync.json 哨兵与文件条目不参与）
    const removed: string[] = [];
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || inBundle.has(entry.name)) continue;
        rmSync(join(dir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    }

    if (!upToDate) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        syncMarkerPath(),
        `${JSON.stringify({ bundleVersion: b.bundleVersion, syncedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    }
    if (installed.length + updated.length + removed.length > 0) invalidateCaches();

    const status = installed.length + updated.length + removed.length > 0 ? "synced" : "noop";
    return { status, installed, updated, removed, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr("builtin-plugins:", msg);
    return { status: "failed", error: msg, ...none };
  }
}

// ---------------------------------------------------------------------------
// 市场读模型（「内置插件」伪市场条目，与 localMarketplaceEntry 同族）
// ---------------------------------------------------------------------------

export type BuiltinMarketplaceEntry = {
  id: string;
  name: string;
  /** 与登记表市场同形状：UI 按 id 区分伪市场，type 仅作渲染分类 */
  type: "directory";
  addedAt: string;
  needsRefresh: false;
  plugins: CatalogPluginEntry[];
};

/**
 * 从已物化的 cache/builtin/ 条目现场合成市场目录（不落缓存、不进登记表）：
 * 呈现与实装严格一致（让位跳过的名字不出现在内置市场里）。没有任何内置条目
 * 时返回 undefined（市场不呈现）。
 */
export function builtinMarketplaceEntry(): BuiltinMarketplaceEntry | undefined {
  const plugins = scanInstalledSync()
    .filter((p) => p.mktId === BUILTIN_MKT_ID)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<CatalogPluginEntry>((p) => {
      const icon = resolvePluginIconDataUrl(p.manifest);
      return {
        name: p.name,
        path: p.manifest.root,
        version: p.version,
        ...(p.manifest.description ? { description: p.manifest.description } : {}),
        ...(icon ? { icon } : {}),
        ...(p.manifest.category ? { category: p.manifest.category } : {}),
        ...(p.manifest.keywords?.length ? { keywords: p.manifest.keywords } : {}),
      };
    });
  if (plugins.length === 0) return undefined;
  return { id: BUILTIN_MKT_ID, name: BUILTIN_MKT_NAME, type: "directory", addedAt: "", needsRefresh: false, plugins };
}
