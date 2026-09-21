/**
 * 市场与安装的写路径：marketplace.json 解析校验 + 目录缓存、git 操作（spawn 不经
 * shell）、市场的添加/移除/刷新、插件安装/卸载。读模型与缓存失效见 store.ts，
 * 登记表见 registry.ts，清单解析见 manifest.ts。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { logErr } from "../log";
import {
  asString,
  containedRelPath,
  installedPluginDir,
  isRecord,
  parsePluginManifest,
  pluginsRootDir,
  type CatalogPluginEntry,
  type InstalledPlugin,
  type MarketplaceCatalog,
  type MarketplaceCatalogCache,
  type MarketplaceRecord,
  type MarketplaceType,
} from "./manifest";
import {
  marketplaceIdFor,
  readMarketplaceRecords,
  sha8,
  writeMarketplaceRecords,
} from "./registry";
import {
  invalidateCaches,
  readIconDataUrl,
  scanInstalledSync,
  setPluginEnabled,
} from "./store";

function reposDir(): string {
  return join(pluginsRootDir(), "repos");
}

function marketplaceRepoDir(mktId: string): string {
  return join(reposDir(), mktId);
}

function catalogsDir(): string {
  return join(pluginsRootDir(), "catalogs");
}

function catalogCachePath(mktId: string): string {
  return join(catalogsDir(), `${mktId}.json`);
}

// ---------------------------------------------------------------------------
// 市场目录（marketplace.json 解析校验 + 目录缓存）
// ---------------------------------------------------------------------------

const MAX_CATALOG_PLUGINS = 128;

function parseMarketplaceCatalog(
  root: string,
): { ok: true; catalog: MarketplaceCatalog } | { ok: false; error: string } {
  // 清单位置探测：自有格式在市场根；Claude 系放 .claude-plugin/marketplace.json；
  // Codex 系放 .agents/plugins/marketplace.json（其个人/团队市场约定位置）
  const candidates = [
    join(root, "marketplace.json"),
    join(root, ".claude-plugin", "marketplace.json"),
    join(root, ".agents", "plugins", "marketplace.json"),
  ];
  const p = candidates.find((c) => existsSync(c));
  if (!p) {
    return { ok: false, error: `${root}: 未找到 marketplace.json（或 .claude-plugin/marketplace.json）` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return { ok: false, error: `${p}: 解析失败（${err instanceof Error ? err.message : String(err)}）` };
  }
  if (!isRecord(doc)) return { ok: false, error: `${p}: 顶层必须是对象` };
  const name = asString(doc.name);
  if (!name) return { ok: false, error: `${p}: 缺少 name` };
  const rawPlugins = doc.plugins;
  if (!Array.isArray(rawPlugins)) return { ok: false, error: `${p}: plugins 必须是数组` };
  const plugins: CatalogPluginEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawPlugins.slice(0, MAX_CATALOG_PLUGINS)) {
    if (!isRecord(raw)) continue;
    const entryName = asString(raw.name);
    if (!entryName) continue;
    if (seen.has(entryName)) continue;
    // source 四种写法（兼容 Claude 生态 marketplaces 的常见形状）：
    //   "./plugins/xxx"（相对路径字符串）
    //   { source: "directory" | "local", path: "./plugins/xxx" }（自有格式）
    //   { source: "./plugins/xxx" }（对象包路径字符串，Claude 生态变体）
    const src = raw.source;
    let relPath: string | undefined;
    if (typeof src === "string") {
      relPath = src;
    } else if (isRecord(src)) {
      if (typeof src.path === "string" && (src.source === "directory" || src.source === "local")) {
        relPath = src.path;
      } else if (typeof src.source === "string" && /^(\/|\.\/)/.test(src.source)) {
        relPath = src.source;
      }
    }
    if (!relPath) continue;
    const contained = containedRelPath(root, relPath, `plugins[${entryName}]`, []);
    if (!contained) continue;
    seen.add(entryName);
    plugins.push({
      name: entryName,
      path: contained,
      ...(asString(raw.version) ? { version: asString(raw.version) } : {}),
      ...(asString(raw.description) ? { description: asString(raw.description) } : {}),
      ...(asString(raw.icon) ? { icon: asString(raw.icon) } : {}),
      ...(asString(raw.category) ? { category: asString(raw.category) } : {}),
      ...(Array.isArray(raw.keywords)
        ? { keywords: (raw.keywords as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 16) }
        : {}),
    });
  }
  return {
    ok: true,
    catalog: {
      name,
      ...(asString(doc.displayName) ? { displayName: asString(doc.displayName) } : {}),
      plugins,
    },
  };
}

function readCatalogCache(mktId: string): MarketplaceCatalogCache | undefined {
  const p = catalogCachePath(mktId);
  if (!existsSync(p)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!isRecord(doc) || !isRecord(doc.catalog) || !Array.isArray((doc.catalog as MarketplaceCatalog).plugins)) {
      return undefined;
    }
    return doc as MarketplaceCatalogCache;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(mktId: string, cache: MarketplaceCatalogCache): void {
  mkdirSync(catalogsDir(), { recursive: true });
  writeFileSync(catalogCachePath(mktId), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// git 操作（spawn，不经 shell；clone 失败区分未安装 git）
// ---------------------------------------------------------------------------

function gitRun(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new Error(err instanceof Error ? err.message : String(err)));
      return;
    }
    let stderr = "";
    const timer = setTimeout(
      () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        reject(new Error(`git ${args[0]} 超时`));
      },
      opts.timeoutMs ?? 120_000,
    );
    timer.unref?.();
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.message.includes("ENOENT")) {
        reject(new Error("未找到 git 命令：添加 Git 仓库市场需要本机安装 git"));
        return;
      }
      reject(new Error(`git ${args[0]}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stderr);
        return;
      }
      reject(new Error(`git ${args[0]} 失败（exit ${code ?? "signal"}）：${stderr.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

async function cloneOrResetRepo(repo: string, dest: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(reposDir(), { recursive: true });
  await gitRun(["clone", "--depth", "1", "--single-branch", repo, dest]);
}

/** rev-parse 短 hash：stdout 取值（失败/超时按未知 revision 处理） */
async function gitShortRevision(dir: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolvePromise(undefined);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 64) out += chunk.toString("utf8");
    });
    child.on("error", () => resolvePromise(undefined));
    child.on("close", (code) => resolvePromise(code === 0 ? out.trim() || undefined : undefined));
  });
}

// ---------------------------------------------------------------------------
// 市场/安装操作（写路径）
// ---------------------------------------------------------------------------

export type AddMarketplaceInput = {
  type: MarketplaceType;
  /** directory 必填：市场根目录 */
  path?: string;
  /** git 必填：仓库地址 */
  repo?: string;
};

export type AddMarketplaceResult = { record: MarketplaceRecord; catalog: MarketplaceCatalog; revision?: string };

/** 添加并立即校验/刷新市场（git 含首次 clone，调用方负责耗时提示） */
export async function addMarketplace(input: AddMarketplaceInput): Promise<AddMarketplaceResult> {
  const type = input.type;
  const source = type === "git" ? input.repo?.trim() : input.path?.trim();
  if (!source) throw new Error(type === "git" ? "addMarketplace: repo is required" : "addMarketplace: path is required");
  if (type === "git" && !/^(https?:\/\/|git@|ssh:\/\/)/.test(source)) {
    throw new Error(`repo 需为 http(s)/ssh 地址（"${source}"）`);
  }

  const id = marketplaceIdFor(type, source);
  const records = readMarketplaceRecords();
  const existing = records.find((r) => r.id === id);

  let root: string;
  let revision: string | undefined;
  if (type === "directory") {
    root = resolve(source);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`市场目录不存在：${root}`);
    }
  } else {
    root = marketplaceRepoDir(id);
    await cloneOrResetRepo(source, root);
    revision = await gitShortRevision(root);
  }

  const parsed = parseMarketplaceCatalog(root);
  if (!parsed.ok) throw new Error(parsed.error);

  const record: MarketplaceRecord = {
    id,
    name: parsed.catalog.name,
    type,
    ...(type === "directory" ? { path: root } : { repo: source }),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    lastRefresh: new Date().toISOString(),
  };
  const nextRecords = existing
    ? records.map((r) => (r.id === id ? record : r))
    : [...records, record];
  writeMarketplaceRecords(nextRecords);
  writeCatalogCache(id, { catalog: parsed.catalog, ...(revision ? { revision } : {}), readAt: record.lastRefresh ?? "" });
  return { record, catalog: parsed.catalog, ...(revision ? { revision } : {}) };
}

/** 移除市场登记（不卸载已装插件；git 工作副本一并清理） */
export function removeMarketplace(mktId: string): void {
  const records = readMarketplaceRecords();
  const next = records.filter((r) => r.id !== mktId);
  if (next.length === records.length) throw new Error(`未找到市场 "${mktId}"`);
  writeMarketplaceRecords(next);
  rmSync(marketplaceRepoDir(mktId), { recursive: true, force: true });
  rmSync(catalogCachePath(mktId), { force: true });
  invalidateCaches();
}

export type RefreshResult = { record: MarketplaceRecord; catalog: MarketplaceCatalog; revision?: string };

/** 刷新市场：directory 重读目录；git 重新浅克隆后重读（含更新检测所需的 revision） */
export async function refreshMarketplace(mktId: string): Promise<RefreshResult> {
  const record = readMarketplaceRecords().find((r) => r.id === mktId);
  if (!record) throw new Error(`未找到市场 "${mktId}"`);
  let root: string;
  let revision: string | undefined;
  if (record.type === "directory") {
    root = record.path ?? "";
    if (!root || !existsSync(root)) throw new Error(`市场目录不存在：${root}`);
  } else {
    root = marketplaceRepoDir(mktId);
    await cloneOrResetRepo(record.repo ?? "", root);
    revision = await gitShortRevision(root);
  }
  const parsed = parseMarketplaceCatalog(root);
  if (!parsed.ok) throw new Error(parsed.error);
  const lastRefresh = new Date().toISOString();
  writeMarketplaceRecords(
    readMarketplaceRecords().map((r) => (r.id === mktId ? { ...r, lastRefresh } : r)),
  );
  writeCatalogCache(mktId, { catalog: parsed.catalog, ...(revision ? { revision } : {}), readAt: lastRefresh });
  return { record, catalog: parsed.catalog, ...(revision ? { revision } : {}) };
}

/**
 * 市场清单（含目录缓存；未刷新过的 git 市场返回空目录并标 needsRefresh）。
 * 图标就地解析为可显示 src：远程 URL 原样；本地相对路径按"插件目录优先、
 * 市场根兜底"读成 data URL（git 市场的根是本机 repos 工作副本）。
 */
export function getMarketplaceCatalog(mktId: string): { catalog: MarketplaceCatalog; revision?: string; needsRefresh: boolean } {
  const cache = readCatalogCache(mktId);
  if (!cache) return { catalog: { name: mktId, plugins: [] }, needsRefresh: true };
  const record = readMarketplaceRecords().find((r) => r.id === mktId);
  const marketRoot = record
    ? record.type === "directory"
      ? record.path
      : marketplaceRepoDir(mktId)
    : undefined;
  const catalog: MarketplaceCatalog = {
    ...cache.catalog,
    plugins: cache.catalog.plugins.map((p) => {
      if (!p.icon || !marketRoot || /^(https?:|data:)/i.test(p.icon)) return p;
      const pluginDir = resolve(marketRoot, p.path);
      const rootWithSep = pluginDir.endsWith(sep) ? pluginDir : pluginDir + sep;
      // 图标基点二选一：相对插件目录（生态惯例）或相对市场根（简写惯例），
      // 两者都做包含性校验，读不到文件自然回退占位
      const under = (base: string, rel: string): string | undefined => {
        const abs = resolve(base, rel);
        const baseWithSep = base.endsWith(sep) ? base : base + sep;
        return abs.startsWith(baseWithSep) ? readIconDataUrl(abs) : undefined;
      };
      const dataUrl = under(pluginDir, p.icon) ?? under(marketRoot, p.icon);
      return dataUrl ? { ...p, icon: dataUrl } : { ...p, icon: undefined };
    }),
  };
  return { catalog, ...(cache.revision ? { revision: cache.revision } : {}), needsRefresh: false };
}

export type InstallResult = { plugin: InstalledPlugin; updated: boolean };

/**
 * 安装/更新：从市场源物化到 cache（目录直拷；git 市场从 repos 工作副本拷）。
 * 已装同 id 时整体替换（installed.json 重写，组件级开关不受影响）。
 */
export async function installPlugin(mktId: string, name: string): Promise<InstallResult> {
  const record = readMarketplaceRecords().find((r) => r.id === mktId);
  if (!record) throw new Error(`未找到市场 "${mktId}"`);
  let cache = readCatalogCache(mktId);
  if (!cache) {
    const refreshed = await refreshMarketplace(mktId);
    cache = { catalog: refreshed.catalog, ...(refreshed.revision ? { revision: refreshed.revision } : {}), readAt: new Date().toISOString() };
  }
  const entry = cache.catalog.plugins.find((p) => p.name === name);
  if (!entry) throw new Error(`市场 "${cache.catalog.name}" 中没有插件 "${name}"`);

  const sourceRoot =
    record.type === "directory" ? join(record.path ?? "", entry.path) : join(marketplaceRepoDir(mktId), entry.path);
  const rootWithSep = sourceRoot.endsWith(sep) ? sourceRoot : sourceRoot + sep;
  if (!existsSync(sourceRoot)) throw new Error(`插件源目录不存在：${sourceRoot}`);

  // 安装前先解析源清单（名字与目录名一致等硬校验在物化前拦截）
  const manifest = parsePluginManifest(sourceRoot);

  const dest = installedPluginDir(mktId, manifest.name);
  const updated = existsSync(dest);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(sourceRoot, dest, {
    recursive: true,
    filter: (src) => {
      // 排除 .git 与市场元数据；installed.json 由本函数最后写入
      if (src === join(dest, "installed.json")) return false;
      return !src.split(sep).includes(".git") && !src.startsWith(rootWithSep + ".git");
    },
  });

  // revision：git 市场取仓库短 hash；目录市场取内容签名（仅展示用）
  const revision =
    record.type === "git" ? await gitShortRevision(marketplaceRepoDir(mktId)) : `sig-${sha8(cacheRootSignatureOf(sourceRoot))}`;

  const installedAt = new Date().toISOString();
  const meta = {
    pluginId: `${manifest.name}@${mktId}`,
    name: manifest.name,
    marketplaceId: mktId,
    marketplaceName: record.name,
    version: entry.version ?? manifest.version,
    ...(revision ? { revision } : {}),
    installedAt,
  };
  writeFileSync(join(dest, "installed.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  invalidateCaches();

  const fresh = scanInstalledSync().find((p) => p.pluginId === meta.pluginId);
  if (!fresh) throw new Error(`安装后扫描未找到 ${meta.pluginId}（清单校验失败？）`);
  return { plugin: fresh, updated };
}

function cacheRootSignatureOf(dir: string): string {
  try {
    return readdirSync(dir)
      .sort()
      .map((n) => {
        try {
          const st = statSync(join(dir, n));
          return `${n}:${st.mtimeMs}:${st.size}`;
        } catch {
          return n;
        }
      })
      .join("|");
  } catch {
    return "";
  }
}

/** 卸载：删物化目录 + 清开关残留。组件级 kv 残留由各子系统 stateKey 天然失配，无需清理 */
export async function uninstallPlugin(pluginId: string): Promise<void> {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0) throw new Error(`非法插件身份 "${pluginId}"`);
  const name = pluginId.slice(0, at);
  const mktId = pluginId.slice(at + 1);
  const dir = installedPluginDir(mktId, name);
  if (!existsSync(dir)) throw new Error(`未找到已装插件 "${pluginId}"`);
  rmSync(dir, { recursive: true, force: true });
  await setPluginEnabled(pluginId, true); // 删除 disabled 记录（= 恢复默认启用，键消失）
  invalidateCaches();
}
