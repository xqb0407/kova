/**
 * 市场与安装的写路径：marketplace.json 解析校验 + 目录缓存、git 操作（spawn 不经
 * shell）、市场的添加/移除/刷新、插件安装/卸载。读模型与缓存失效见 store.ts，
 * 登记表见 registry.ts，清单解析见 manifest.ts。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
  LOCAL_MKT_ID,
  LOCAL_MKT_NAME,
  BUILTIN_MKT_ID,
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
  resolvePluginIconDataUrl,
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
    //   "./" 或 "."（插件根即市场根本身，单插件仓库的写法，如 obra/superpowers）
    const src = raw.source;
    let relPath: string | undefined;
    if (typeof src === "string") {
      relPath = src;
    } else if (isRecord(src)) {
      if (typeof src.path === "string" && (src.source === "directory" || src.source === "local")) {
        relPath = src.path;
      } else if (typeof src.source === "string" && /^(\/|\.\/|\.)/.test(src.source)) {
        relPath = src.source;
      }
    }
    if (!relPath) continue;
    // 根写法（"./"）归一为空相对路径 = 市场根本身；不能走 containedRelPath，
    // 它按组件路径语义把空串判为非法（那对 manifest 组件指针是对的，对 source 不是）
    const isRootSource = /^(\.|\.\/)$/.test(relPath.trim());
    const contained = isRootSource ? "" : containedRelPath(root, relPath, `plugins[${entryName}]`, []);
    if (contained === undefined) continue;
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
  if (mktId === LOCAL_MKT_ID) throw new Error("「本地安装」目录随装随生成，无需刷新");
  if (mktId === BUILTIN_MKT_ID) throw new Error("内置插件随应用更新，无需刷新");
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

export type InstallOptions = {
  /** 链接安装（开发模式）：cache 条目做成指向源目录的符号链接，所有读路径实时命中源码，
   *  改完插件重建产物即生效。仅目录市场可用；缺省=保持现有模式（更新不回退链接为拷贝） */
  link?: boolean;
};

/**
 * 安装/更新：从市场源物化到 cache（目录直拷；git 市场从 repos 工作副本拷）。
 * 已装同 id 时整体替换（元数据重写，组件级开关不受影响）。
 * link 模式见 InstallOptions：不拷贝、只 symlink，元数据落兄弟文件（不进源目录）。
 */
export async function installPlugin(mktId: string, name: string, opts: InstallOptions = {}): Promise<InstallResult> {
  if (mktId === LOCAL_MKT_ID) return reinstallLocalPlugin(name);
  // 内置市场不参与安装写路径（条目由启动 sync 物化）
  if (mktId === BUILTIN_MKT_ID) throw new Error("内置插件随应用分发，无需安装");
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
  // 根写法条目（source: "./"）的源目录就是市场根本身——git 市场下目录名是 clone 出来的
  // git-<hash>，与清单名无关，目录名比对在此无意义；改为校验「清单名 == 市场条目名」，
  // 缓存目录名仍由 manifest.name 决定（原不变量由 dest 保证）
  const manifest = parsePluginManifest(sourceRoot, entry.path === "" ? { dirName: entry.name } : {});

  const dest = installedPluginDir(mktId, manifest.name);
  let destIsLink = false;
  try {
    destIsLink = lstatSync(dest).isSymbolicLink();
  } catch {
    /* 未装或悬空 */
  }
  const updated = existsSync(dest);
  // 模式判定：显式 link 参数最优先；缺省保持现有模式（链接项点"更新"仍是链接，
  // 不会被静默回退成拷贝而丢掉开发体验）
  const link = opts.link ?? destIsLink;
  if (link && record.type !== "directory") {
    throw new Error("链接安装仅支持目录市场（git 市场源目录是可被刷重置的工作副本）");
  }
  const sibMeta = `${dest}.installed.json`;
  rmSync(dest, { recursive: true, force: true }); // symlink 只删链接自身，不追随删源目录
  rmSync(sibMeta, { force: true }); // 清上一模式残留元数据
  if (link) {
    mkdirSync(join(pluginsRootDir(), "cache", mktId), { recursive: true });
    symlinkSync(resolve(sourceRoot), dest, "dir");
  } else {
    mkdirSync(dest, { recursive: true });
    cpSync(sourceRoot, dest, {
      recursive: true,
      filter: (src) => {
        // 排除 .git 与市场元数据；installed.json 由本函数最后写入
        if (src === join(dest, "installed.json")) return false;
        return !src.split(sep).includes(".git") && !src.startsWith(rootWithSep + ".git");
      },
    });
  }

  // revision：git 市场取仓库短 hash；目录市场取内容签名（仅展示用）；链接装带 link 前缀
  const revision = link
    ? `link-${sha8(cacheRootSignatureOf(sourceRoot))}`
    : record.type === "git"
      ? await gitShortRevision(marketplaceRepoDir(mktId))
      : `sig-${sha8(cacheRootSignatureOf(sourceRoot))}`;

  const installedAt = new Date().toISOString();
  const meta = {
    pluginId: `${manifest.name}@${mktId}`,
    name: manifest.name,
    marketplaceId: mktId,
    marketplaceName: record.name,
    version: entry.version ?? manifest.version,
    ...(revision ? { revision } : {}),
    ...(link ? { linked: true, sourcePath: resolve(sourceRoot) } : {}),
    installedAt,
  };
  // 链接装元数据写兄弟文件：写进 dest 即写进用户源仓库，属污染
  writeFileSync(link ? sibMeta : join(dest, "installed.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  invalidateCaches();

  const fresh = scanInstalledSync().find((p) => p.pluginId === meta.pluginId);
  if (!fresh) throw new Error(`安装后扫描未找到 ${meta.pluginId}（清单校验失败？）`);
  return { plugin: fresh, updated };
}

/**
 * 直接安装任意本地插件目录（"手动上传安装"）：不登记市场、不要求
 * marketplace.json，目录根下有三态清单（.kova/.claude/.codex-plugin
 * 的 plugin.json）即可。物化到 cache/local/<name>/（身份 `name@local`），
 * installed.json 记住 sourcePath——之后的"更新"即从源目录重拷。
 */
export async function installLocalPlugin(sourceDir: string): Promise<InstallResult> {
  const root = resolve(sourceDir.trim());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`插件目录不存在：${root}`);
  }
  // 清单硬校验（名字合法、与目录名一致等）在物化前拦截
  const manifest = parsePluginManifest(root);

  const dest = installedPluginDir(LOCAL_MKT_ID, manifest.name);
  const updated = existsSync(dest);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(root, dest, {
    recursive: true,
    filter: (src) => {
      // 排除 .git 与上一次安装的元数据残留（installed.json 由本函数写入）
      if (src === join(root, "installed.json")) return false;
      return !src.split(sep).includes(".git") && !src.startsWith(root + sep + ".git");
    },
  });

  const revision = `sig-${sha8(cacheRootSignatureOf(root))}`;
  const installedAt = new Date().toISOString();
  const meta = {
    pluginId: `${manifest.name}@${LOCAL_MKT_ID}`,
    name: manifest.name,
    marketplaceId: LOCAL_MKT_ID,
    marketplaceName: LOCAL_MKT_NAME,
    version: manifest.version,
    revision,
    sourcePath: root,
    installedAt,
  };
  writeFileSync(join(dest, "installed.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  invalidateCaches();

  const fresh = scanInstalledSync().find((p) => p.pluginId === meta.pluginId);
  if (!fresh) throw new Error(`安装后扫描未找到 ${meta.pluginId}（清单校验失败？）`);
  return { plugin: fresh, updated };
}

/** 本地安装项的"更新"：从 installed.json 记录的源目录重新拷贝物化 */
async function reinstallLocalPlugin(name: string): Promise<InstallResult> {
  const existing = scanInstalledSync().find((p) => p.pluginId === `${name}@${LOCAL_MKT_ID}`);
  if (!existing) throw new Error(`本地安装中没有插件 "${name}"`);
  if (!existing.sourcePath) {
    throw new Error(`插件 "${name}" 未记录源目录，无法自动更新（请重新选择目录安装）`);
  }
  if (!existsSync(existing.sourcePath)) {
    throw new Error(`源目录已不存在：${existing.sourcePath}`);
  }
  return installLocalPlugin(existing.sourcePath);
}

export type LocalMarketplaceEntry = {
  id: string;
  name: string;
  type: MarketplaceType;
  addedAt: string;
  needsRefresh: false;
  plugins: CatalogPluginEntry[];
};

/**
 * 「本地安装」伪市场的目录视图（现场合成，不落缓存、不进登记表）：条目来自
 * 已装 local 插件；版本/描述/图标优先读源目录清单——源版本 ≠ 装机版本时，
 * 市场页据此出"更新"按钮。没有任何本地安装项时返回 undefined（市场不呈现）。
 */
export function localMarketplaceEntry(): LocalMarketplaceEntry | undefined {
  const locals = scanInstalledSync().filter((p) => p.mktId === LOCAL_MKT_ID);
  if (locals.length === 0) return undefined;
  const plugins: CatalogPluginEntry[] = locals.map((p) => {
    let version = p.version;
    let description = p.manifest.description;
    let category = p.manifest.category;
    let keywords = p.manifest.keywords;
    let icon = resolvePluginIconDataUrl(p.manifest);
    if (p.sourcePath && existsSync(p.sourcePath)) {
      try {
        const src = parsePluginManifest(p.sourcePath);
        version = src.version;
        description = src.description ?? description;
        category = src.category ?? category;
        keywords = src.keywords ?? keywords;
        icon = resolvePluginIconDataUrl(src) ?? icon;
      } catch {
        /* 源目录清单坏了：保留已装项信息，不阻断呈现 */
      }
    }
    return {
      name: p.name,
      version,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {}),
      ...(category ? { category } : {}),
      ...(keywords?.length ? { keywords } : {}),
      path: p.sourcePath ?? p.manifest.root,
    };
  });
  return {
    id: LOCAL_MKT_ID,
    name: LOCAL_MKT_NAME,
    type: "directory",
    addedAt: "",
    needsRefresh: false,
    plugins,
  };
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
  if (mktId === BUILTIN_MKT_ID) throw new Error("内置插件不可卸载，可在插件设置中禁用");
  const dir = installedPluginDir(mktId, name);
  if (!existsSync(dir)) throw new Error(`未找到已装插件 "${pluginId}"`);
  // 链接装：rmSync 对 symlink 只删链接本体，源目录不受影响
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.installed.json`, { force: true }); // 链接装兄弟元数据（拷贝装无此文件）
  await setPluginEnabled(pluginId, true); // 删除 disabled 记录（= 恢复默认启用，键消失）
  invalidateCaches();
}
