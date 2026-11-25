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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  type CatalogGitSource,
  type CatalogPluginEntry,
  type InstalledPlugin,
  type MarketplaceCatalog,
  type MarketplaceCatalogCache,
  type MarketplaceRecord,
  type MarketplaceType,
  type PluginManifest,
} from "./manifest";
import {
  CODEX_PERSONAL_MKT_ID,
  marketplaceIdFor,
  marketplaceRecordById,
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

/**
 * 市场 source 解析根：优先用 record/cache 里记录的 sourceBase；旧记录没有时
 * 现场探测清单布局反推（`.agents/plugins/...` 的上层是真正的 source 根）。
 */
function marketplaceSourceBaseForRecord(record: MarketplaceRecord): string {
  if (record.sourceBase) return record.sourceBase;
  const root =
    record.type === "directory" ? (record.path ?? "") : marketplaceRepoDir(record.id);
  if (!root) return root;
  for (const layout of MARKETPLACE_LAYOUTS) {
    const manifest = join(root, layout.split("/").join(sep));
    if (!existsSync(manifest)) continue;
    return marketplaceRootFromManifestPath(manifest) ?? root;
  }
  return root;
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

/** 支持的 market 清单布局（相对市场根；顺序 = 探测优先级） */
const MARKETPLACE_LAYOUTS = [
  "marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".agents/plugins/api_marketplace.json",
] as const;

/**
 * 从 marketplace.json 的实际路径反推 source 解析根。
 * Codex 的个人市场把清单放在 `~/.agents/plugins/marketplace.json`，但
 * `./plugins/x` 相对的是 `~`；用布局后缀剥离而不是用户登记路径。
 */
export function marketplaceRootFromManifestPath(manifestPath: string): string | undefined {
  const normalized = resolve(manifestPath);
  // 必须按后缀从长到短匹配：`.claude-plugin/marketplace.json` 也以
  // `marketplace.json` 结尾，先匹配短的会把 source 根错算到布局目录里。
  const layouts = [...MARKETPLACE_LAYOUTS].sort((a, b) => b.length - a.length);
  for (const layout of layouts) {
    const suffix = sep + layout.split("/").join(sep);
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -suffix.length) || sep;
    }
  }
  return undefined;
}

/** 明确的远程 git URL（裸 owner/repo 只在对象 source 里按 GitHub 简写归一） */
function isGitUrl(value: string): boolean {
  const v = value.trim();
  return /^(https?|ssh|git|file):\/\//i.test(v) || /^git@/.test(v);
}

/**
 * 允许的远程 source 协议：http(s)/ssh/git/file 与 scp 风格 git@host:repo，
 * 以及 GitHub `owner/repo` 简写。拒绝 `ext::` / `fd::` 等可执行本地命令的
 * git transport，也拒绝以 `-` 开头（会被 git 当成选项）的 URL。
 */
function isAllowedGitSourceUrl(value: string): boolean {
  const v = value.trim();
  if (!v || v.startsWith("-")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v)?.[1]?.toLowerCase();
  if (scheme) {
    // 只信任加密/本机 transport：http/git 明文可被中间人替换插件代码
    return scheme === "https" || scheme === "ssh" || scheme === "file";
  }
  return (
    /^git@[A-Za-z0-9._-]+:/.test(v) ||
    /^github\.com\//i.test(v) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)
  );
}

/** Codex 允许 `owner/repo` 简写；本地字符串 source 仍优先按路径解释 */
function normalizeGitUrl(value: string): string {
  const v = value.trim();
  if (isGitUrl(v)) return v;
  if (/^github\.com\//i.test(v)) return `https://${v}`;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) {
    const repo = v.replace(/\.git$/i, "");
    return `https://github.com/${repo}.git`;
  }
  return v;
}

/**
 * Codex `url` / `git-subdir` 的 url 允许三种形态：
 * - 远程 URL（http(s)/ssh/git/file）或 GitHub `owner/repo`；
 * - 相对市场根的 `./repo` / `../repo`（必须落在市场根内）；
 * - 绝对本地路径（`/repo` 或 Windows 盘符路径）。
 * 相对路径在解析期就归一成绝对路径，材料化层不再依赖 sourceBase。
 */
function resolveMarketplaceGitUrl(
  raw: string,
  sourceBase: string,
  entryName: string,
  diagnostics: string[],
): string | undefined {
  const url = raw.trim();
  if (!url) return undefined;
  if (/^\.{1,2}[\\/]/.test(url)) {
    // 市场清单可能来自另一平台：Windows 分隔符先归一，交给 path.resolve
    const abs = resolve(sourceBase, url.replace(/\\/g, "/"));
    const prefix = sourceBase.endsWith(sep) ? sourceBase : sourceBase + sep;
    if (abs !== sourceBase && !abs.startsWith(prefix)) {
      diagnostics.push(`plugins[${entryName}]: git source url 逃逸市场根，已跳过`);
      return undefined;
    }
    return abs;
  }
  if (url.startsWith("/") || /^[A-Za-z]:[\\/]/.test(url)) return url;
  if (!isAllowedGitSourceUrl(url)) {
    diagnostics.push(`plugins[${entryName}]: 不支持的 git source URL（${url}），已跳过`);
    return undefined;
  }
  return normalizeGitUrl(url);
}

/** 目录条目的展示元数据（local/git 两种 source 共用；Codex interface 优先回退） */
function catalogMetadata(raw: Record<string, unknown>): Partial<CatalogPluginEntry> {
  const iface = isRecord(raw.interface) ? raw.interface : undefined;
  const displayName = asString(raw.displayName) ?? asString(iface?.displayName);
  const description =
    asString(raw.description) ??
    asString(iface?.shortDescription) ??
    asString(iface?.longDescription);
  const icon =
    asString(raw.icon) ??
    asString(iface?.composerIcon) ??
    asString(iface?.logo) ??
    asString(iface?.logoDark);
  const category = asString(raw.category) ?? asString(iface?.category);
  const policy = isRecord(raw.policy) ? raw.policy : undefined;
  const authPolicy =
    policy?.authentication === "ON_USE"
      ? ("on_use" as const)
      : policy?.authentication === "ON_INSTALL"
        ? ("on_install" as const)
        : undefined;
  return {
    ...(displayName ? { displayName } : {}),
    ...(asString(raw.version) ? { version: asString(raw.version) } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(category ? { category } : {}),
    ...(authPolicy ? { authPolicy } : {}),
    ...(Array.isArray(raw.keywords)
      ? {
          keywords: (raw.keywords as unknown[])
            .filter((k): k is string => typeof k === "string")
            .slice(0, 16),
        }
      : {}),
  };
}

function parseMarketplaceCatalog(
  root: string,
): { ok: true; catalog: MarketplaceCatalog; sourceBase: string } | { ok: false; error: string } {
  // 清单位置探测：自有格式在市场根；Claude/Cursor 系放各自的目录；
  // Codex 系放 .agents/plugins/（marketplace.json 或 api_marketplace.json）
  const candidates = MARKETPLACE_LAYOUTS.map((layout) =>
    join(root, layout.split("/").join(sep)),
  );
  const p = candidates.find((c) => existsSync(c));
  if (!p) {
    return { ok: false, error: `${root}: 未找到 marketplace.json（已探测 ${MARKETPLACE_LAYOUTS.join(" / ")}）` };
  }
  const sourceBase = marketplaceRootFromManifestPath(p) ?? root;
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
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPlugins.slice(0, MAX_CATALOG_PLUGINS)) {
    if (!isRecord(raw)) continue;
    const entryName = asString(raw.name);
    if (!entryName) continue;
    if (seen.has(entryName)) continue;
    // Codex policy.installation=NOT_AVAILABLE：目录里声明了但当前渠道不可安装，
    // 直接隐藏并留诊断，避免 UI 装一个必然失败的条目。
    if (isRecord(raw.policy) && raw.policy.installation === "NOT_AVAILABLE") {
      diagnostics.push(`plugins[${entryName}]: policy.installation=NOT_AVAILABLE，已隐藏`);
      continue;
    }
    // source 写法（兼容 Claude/Codex 生态 marketplaces 的常见形状）：
    //   "./plugins/xxx"（相对路径字符串）
    //   { source: "directory" | "local", path: "./plugins/xxx" }（自有/Codex 格式）
    //   { source: "./plugins/xxx" }（对象包路径字符串，Claude 生态变体）
    //   { source: "git" | "git-subdir" | "url", url, path?, ref?, sha? }（Codex 远程）
    //   "./" 或 "."（插件根即市场根本身，单插件仓库的写法）
    const src = raw.source;
    let relPath: string | undefined;
    let gitSource: CatalogGitSource | undefined;
    if (typeof src === "string") {
      if (isGitUrl(src)) {
        const url = resolveMarketplaceGitUrl(src, sourceBase, entryName, diagnostics);
        if (!url) continue;
        gitSource = { kind: "git", url };
      } else {
        relPath = src;
      }
    } else if (isRecord(src)) {
      const kind = typeof src.source === "string" ? src.source : undefined;
      if (kind === "git" || kind === "git-subdir" || kind === "url") {
        const rawUrl = asString(src.url);
        if (!rawUrl) {
          diagnostics.push(`plugins[${entryName}]: ${kind} source 缺少 url，已跳过`);
          continue;
        }
        const url = resolveMarketplaceGitUrl(
          rawUrl,
          sourceBase,
          entryName,
          diagnostics,
        );
        if (!url) continue;
        const path = asString(src.path)?.trim();
        const ref = asString(src.ref)?.trim();
        const sha = asString(src.sha)?.trim();
        if (ref && (ref.startsWith("-") || /\s/.test(ref))) {
          diagnostics.push(`plugins[${entryName}]: git source ref 非法，已跳过`);
          continue;
        }
        // Codex 的 sha 字段实际是自由 selector（commit / tag / branch），
        // 不能按十六进制硬校验；只拦会被 git 当选项的形态。
        if (sha && (sha.startsWith("-") || /\s/.test(sha))) {
          diagnostics.push(`plugins[${entryName}]: git source sha 非法，已跳过`);
          continue;
        }
        gitSource = {
          kind: "git",
          url,
          ...(path ? { path } : {}),
          ...(ref ? { ref } : {}),
          ...(sha ? { sha } : {}),
        };
      } else if (kind === "npm") {
        diagnostics.push(`plugins[${entryName}]: npm source 暂不支持，已跳过`);
        continue;
      } else if (
        typeof src.path === "string" &&
        (kind === undefined || kind === "directory" || kind === "local")
      ) {
        relPath = src.path;
      } else if (typeof kind === "string" && /^(\/|\.\/|\.)/.test(kind)) {
        relPath = kind;
      } else if (typeof kind === "string") {
        diagnostics.push(
          `plugins[${entryName}]: source 类型 "${kind}" 暂不支持，已跳过`,
        );
        continue;
      }
    }
    if (gitSource) {
      const sub = (gitSource.path ?? "")
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "")
        .replace(/\/+$/, "");
      if (
        sub.startsWith("/") ||
        sub === ".." ||
        sub.startsWith("../") ||
        sub.includes("/../")
      ) {
        diagnostics.push(`plugins[${entryName}]: git source 子目录逃逸仓库根，已跳过`);
        continue;
      }
      if (sub) gitSource.path = sub;
      else delete gitSource.path;
      seen.add(entryName);
      plugins.push({
        ...catalogMetadata(raw),
        name: entryName,
        path: sub,
        source: gitSource,
      });
      continue;
    }
    if (!relPath) {
      diagnostics.push(
        src === undefined
          ? `plugins[${entryName}]: 缺少 source，已跳过`
          : `plugins[${entryName}]: 无法识别的 source，已跳过`,
      );
      continue;
    }
    // 根写法（"./"）归一为空相对路径 = source 根本身；不能走 containedRelPath，
    // 它按组件路径语义把空串判为非法（那对 manifest 组件指针是对的，对 source 不是）
    const isRootSource = /^(\.|\.\/)$/.test(relPath.trim());
    const contained = isRootSource
      ? ""
      : containedRelPath(sourceBase, relPath, `plugins[${entryName}]`, []);
    if (contained === undefined) {
      diagnostics.push(`plugins[${entryName}]: source 路径逃逸市场根，已跳过`);
      continue;
    }
    seen.add(entryName);
    plugins.push({
      ...catalogMetadata(raw),
      name: entryName,
      path: contained,
    });
  }
  return {
    ok: true,
    sourceBase,
    catalog: {
      name,
      ...(asString(doc.displayName) ? { displayName: asString(doc.displayName) } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
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

/** 单个 git source 的材料化并发去重（同一 url/ref/sha 只 clone 一次） */
const gitSourceInFlight = new Map<string, Promise<string>>();

function gitSourceCacheDir(source: CatalogGitSource): string {
  return join(
    pluginsRootDir(),
    "sources",
    sha8(`${source.url}|${source.ref ?? ""}|${source.sha ?? ""}`),
  );
}

const GIT_SOURCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 清理长期未使用的 git source 缓存（安装/预览会 touch 命中的条目）。 */
export function pruneGitSourceCache(
  maxAgeMs = GIT_SOURCE_MAX_AGE_MS,
  now = Date.now(),
): number {
  const root = join(pluginsRootDir(), "sources");
  if (!existsSync(root)) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      // 中断的 clone 临时目录：过一小时就清
      const age = now - st.mtimeMs;
      const isTmp = name.includes(".tmp-");
      if (age > (isTmp ? 60 * 60 * 1000 : maxAgeMs)) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* 并发删除：忽略 */
    }
  }
  return removed;
}

/**
 * 把 Codex marketplace 的远程 source（git / git-subdir / url）材料化到
 * plugins/sources/<hash>，返回仓库根或子目录的绝对路径。
 *
 * 默认浅克隆；`ref` 走 --branch（分支/标签），`sha` 再补一次定向 fetch +
 * detach checkout。同一 url/ref/sha 有缓存，安装/预览不会反复拉网。
 */
export async function materializeGitPluginSource(
  entry: CatalogPluginEntry,
  opts: { refresh?: boolean } = {},
): Promise<string> {
  const source = entry.source;
  if (!source) throw new Error(`插件 "${entry.name}" 没有远程 source`);
  const dest = gitSourceCacheDir(source);
  pruneGitSourceCache();
  // 更新安装时丢弃旧缓存，让分支/标签重新解析到最新 commit
  if (opts.refresh) rmSync(dest, { recursive: true, force: true });
  const target = source.path ? resolve(dest, source.path) : dest;
  const prefix = dest.endsWith(sep) ? dest : dest + sep;
  if (target !== dest && !target.startsWith(prefix)) {
    throw new Error(`插件 "${entry.name}" 的 git 子目录逃逸仓库根：${source.path}`);
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    try {
      const now = new Date();
      utimesSync(dest, now, now);
    } catch {
      /* 并发清理/权限问题：不影响读取 */
    }
    return target;
  }

  const existing = gitSourceInFlight.get(dest);
  if (existing) return existing;
  const task = (async (): Promise<string> => {
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    try {
      const refIsSha = source.ref ? /^[0-9a-f]{7,40}$/i.test(source.ref) : false;
      const cloneArgs = ["clone", "--depth", "1", "--single-branch"];
      if (source.ref && !refIsSha) cloneArgs.push("--branch", source.ref);
      cloneArgs.push(source.url, tmp);
      await gitRun(cloneArgs);
      const sha = source.sha ?? (refIsSha ? source.ref : undefined);
      if (sha) {
        // 浅克隆不一定包含目标 commit；定向 fetch 失败时让 checkout 给出真实错误。
        // sha 也可能是 tag/branch（Codex 的 selector 是自由字符串）：fetch 成功后
        // checkout FETCH_HEAD，避免为远端分支名本地找不到 ref。
        const shaIsHex = /^[0-9a-f]{7,40}$/i.test(sha);
        let fetched = false;
        try {
          await gitRun(["fetch", "--depth", "1", "origin", sha], { cwd: tmp });
          fetched = true;
        } catch {
          /* 已在克隆结果里时 checkout 会成功 */
        }
        await gitRun(
          ["checkout", "--detach", fetched && !shaIsHex ? "FETCH_HEAD" : sha],
          { cwd: tmp },
        );
      }
      rmSync(dest, { recursive: true, force: true });
      renameSync(tmp, dest);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        throw new Error(
          `插件 "${entry.name}" 的 git source 子目录不存在：${source.path ?? "."}`,
        );
      }
      return target;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      gitSourceInFlight.delete(dest);
    }
  })();
  gitSourceInFlight.set(dest, task);
  return task;
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
    ...(parsed.sourceBase !== root ? { sourceBase: parsed.sourceBase } : {}),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    lastRefresh: new Date().toISOString(),
  };
  const nextRecords = existing
    ? records.map((r) => (r.id === id ? record : r))
    : [...records, record];
  writeMarketplaceRecords(nextRecords);
  writeCatalogCache(id, {
    catalog: parsed.catalog,
    sourceBase: parsed.sourceBase,
    ...(revision ? { revision } : {}),
    readAt: record.lastRefresh ?? "",
  });
  return { record, catalog: parsed.catalog, ...(revision ? { revision } : {}) };
}

/** 移除市场登记（不卸载已装插件；git 工作副本一并清理） */
export function removeMarketplace(mktId: string): void {
  if (mktId === CODEX_PERSONAL_MKT_ID) {
    throw new Error("Codex personal 市场为内置自动发现市场，不可移除");
  }
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
  const record = marketplaceRecordById(mktId);
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
  // 布局可能变化：新 sourceBase 与登记根相同时必须清掉旧值，否则 source 仍按
  // 旧布局根解析（例如 .agents/plugins 被移到根级 marketplace.json 之后）。
  const { sourceBase: _staleSourceBase, ...recordWithoutSourceBase } = record;
  const nextRecord: MarketplaceRecord = {
    ...recordWithoutSourceBase,
    lastRefresh,
    ...(parsed.sourceBase !== root ? { sourceBase: parsed.sourceBase } : {}),
  };
  const realRecords = readMarketplaceRecords();
  if (realRecords.some((r) => r.id === mktId)) {
    writeMarketplaceRecords(realRecords.map((r) => (r.id === mktId ? nextRecord : r)));
  }
  writeCatalogCache(mktId, {
    catalog: parsed.catalog,
    sourceBase: parsed.sourceBase,
    ...(revision ? { revision } : {}),
    readAt: lastRefresh,
  });
  return { record: nextRecord, catalog: parsed.catalog, ...(revision ? { revision } : {}) };
}

/**
 * 市场工作副本里的插件清单图标：条目通常不在 marketplace.json 里重复声明 icon
 * （图标归插件自己的清单所有），安装前卡片因此只能显示首字母块。这里就地读
 * 插件清单图标——目录市场的源目录、git 市场的 repos 工作副本都在盘上，安装前
 * 也能显示真实图标（清单缺失/无 icon 按无图标处理，回退首字母块）。
 */
function readMarketPluginMeta(
  pluginDir: string,
  name: string,
): { icon?: string; displayName?: string } {
  try {
    // source 可指向子目录或异名目录：目录名一致性以市场条目名为准，避免误判
    const manifest = parsePluginManifest(pluginDir, { dirName: name });
    const icon = resolvePluginIconDataUrl(manifest);
    return {
      ...(icon ? { icon } : {}),
      ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * 远程 source 的清单图标/展示名只能在材料化后读取：预览/安装拿到清单时
 * 顺手回填目录缓存，下一次市场列表就能显示（避免列表刷新为每个 git source
 * 都 clone 一遍）。
 */
export function cacheCatalogEntryMetadata(
  mktId: string,
  catalogName: string,
  manifest: PluginManifest,
): void {
  const cache = readCatalogCache(mktId);
  if (!cache) return;
  const index = cache.catalog.plugins.findIndex((entry) => entry.name === catalogName);
  if (index < 0) return;
  const entry = cache.catalog.plugins[index]!;
  const displayName = entry.displayName ?? manifest.displayName;
  const icon = entry.icon ?? resolvePluginIconDataUrl(manifest);
  if (displayName === entry.displayName && icon === entry.icon) return;
  const plugins = [...cache.catalog.plugins];
  plugins[index] = {
    ...entry,
    ...(displayName ? { displayName } : {}),
    ...(icon ? { icon } : {}),
  };
  writeCatalogCache(mktId, {
    ...cache,
    catalog: { ...cache.catalog, plugins },
  });
}

/**
 * 市场清单（含目录缓存；未刷新过的 git 市场返回空目录并标 needsRefresh）。
 * 图标就地解析为可显示 src：远程 URL 原样；本地相对路径按"插件目录优先、
 * 市场根兜底"读成 data URL（git 市场的根是本机 repos 工作副本）。条目未声明
 * icon / displayName 时回退读插件清单——中文展示名不必在 marketplace.json
 * 里重复维护。
 */
export function getMarketplaceCatalog(mktId: string): { catalog: MarketplaceCatalog; revision?: string; needsRefresh: boolean } {
  const record = marketplaceRecordById(mktId);
  let cache = readCatalogCache(mktId);
  // 内置 personal 市场没有登记动作：首次读取时现场解析并落缓存，避免用户
  // 还要先去市场页点一次刷新才看到插件。
  if (!cache && record?.builtin && record.path) {
    const parsed = parseMarketplaceCatalog(record.path);
    if (parsed.ok) {
      const readAt = new Date().toISOString();
      writeCatalogCache(mktId, { catalog: parsed.catalog, sourceBase: parsed.sourceBase, readAt });
      cache = { catalog: parsed.catalog, sourceBase: parsed.sourceBase, readAt };
    }
  }
  if (!cache) return { catalog: { name: mktId, plugins: [] }, needsRefresh: true };
  const marketRoot = record ? marketplaceSourceBaseForRecord(record) : undefined;
  const catalog: MarketplaceCatalog = {
    ...cache.catalog,
    plugins: cache.catalog.plugins.map((p) => {
      if (!marketRoot) return p;
      const pluginDir = resolve(marketRoot, p.path);
      let next: CatalogPluginEntry = p;
      let iconResolved = false;
      if (p.icon) {
        if (/^(https?:|data:)/i.test(p.icon)) {
          iconResolved = true;
        } else {
          // 图标基点二选一：相对插件目录（生态惯例）或相对市场根（简写惯例），
          // 两者都做包含性校验，读不到文件自然回退占位
          const under = (base: string, rel: string): string | undefined => {
            const abs = resolve(base, rel);
            const baseWithSep = base.endsWith(sep) ? base : base + sep;
            return abs.startsWith(baseWithSep) ? readIconDataUrl(abs) : undefined;
          };
          const dataUrl = under(pluginDir, p.icon) ?? under(marketRoot, p.icon);
          if (dataUrl) {
            next = { ...next, icon: dataUrl };
            iconResolved = true;
          }
        }
      }
      // 展示名与图标都可能要读插件清单：任一未就位才解析（一次读两用）
      if (!next.displayName || !iconResolved) {
        const meta = readMarketPluginMeta(pluginDir, p.name);
        if (!next.displayName && meta.displayName) {
          next = { ...next, displayName: meta.displayName };
        }
        if (!iconResolved) {
          // 声明过但读不到 → 回退清单图标；清单也没有则显式清空（沿用旧行为）
          next = meta.icon
            ? { ...next, icon: meta.icon }
            : p.icon
              ? { ...next, icon: undefined }
              : next;
        }
      }
      return next;
    }),
  };
  return { catalog, ...(cache.revision ? { revision: cache.revision } : {}), needsRefresh: false };
}

/**
 * 市场条目的源目录定位（仅本地 source；远程 git source 用 async 版本）。
 * 登记表 + 目录缓存，不读内容；市场未刷新 / 条目不在目录 / 源目录不存在时
 * 返回 undefined。
 */
export function resolveMarketplacePluginSource(
  mktId: string,
  name: string,
): { record: MarketplaceRecord; entry: CatalogPluginEntry; dir: string } | undefined {
  const record = marketplaceRecordById(mktId);
  if (!record) return undefined;
  const entry = readCatalogCache(mktId)?.catalog.plugins.find((p) => p.name === name);
  if (!entry) return undefined;
  const root = marketplaceSourceBaseForRecord(record);
  if (!root) return undefined;
  const dir = resolve(root, entry.path);
  if (!existsSync(dir)) return undefined;
  return { record, entry, dir };
}

/** 预览用异步定位：远程 git source 需要先材料化；本地 source 复用同步实现 */
export async function resolveMarketplacePluginSourceAsync(
  mktId: string,
  name: string,
): Promise<
  { record: MarketplaceRecord; entry: CatalogPluginEntry; dir: string } | undefined
> {
  const record = marketplaceRecordById(mktId);
  if (!record) return undefined;
  const entry = readCatalogCache(mktId)?.catalog.plugins.find((p) => p.name === name);
  if (!entry) return undefined;
  if (entry.source) {
    const dir = await materializeGitPluginSource(entry);
    return { record, entry, dir };
  }
  return resolveMarketplacePluginSource(mktId, name);
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
 * 更新（已装同 id 的普通安装）会先刷新市场源：cache 目录与 git 工作副本都可能
 * 已落后，"更新"不刷新只是把旧内容重拷一遍。显式链接装跳过刷新（源目录不可达
 * 时也应允许把已装副本转成链接）。
 * link 模式见 InstallOptions：不拷贝、只 symlink，元数据落兄弟文件（不进源目录）。
 */
export async function installPlugin(mktId: string, name: string, opts: InstallOptions = {}): Promise<InstallResult> {
  if (mktId === LOCAL_MKT_ID) return reinstallLocalPlugin(name);
  const record = marketplaceRecordById(mktId);
  if (!record) throw new Error(`未找到市场 "${mktId}"`);
  const updating =
    opts.link !== true &&
    scanInstalledSync().some(
      (p) =>
        p.mktId === mktId &&
        (p.name === name || p.catalogName === name),
    );
  let cache = readCatalogCache(mktId);
  if (!cache || updating) {
    const refreshed = await refreshMarketplace(mktId);
    cache = { catalog: refreshed.catalog, ...(refreshed.revision ? { revision: refreshed.revision } : {}), readAt: new Date().toISOString() };
  }
  const entry = cache.catalog.plugins.find((p) => p.name === name);
  if (!entry) throw new Error(`市场 "${cache.catalog.name}" 中没有插件 "${name}"`);
  // 远程 source 无法链接安装；在 clone 之前就拒绝，不做无谓网络请求
  if (opts.link === true && entry.source) {
    throw new Error("链接安装仅支持目录市场的本地 source");
  }

  const sourceRoot = entry.source
    ? await materializeGitPluginSource(entry, { refresh: updating })
    : join(marketplaceSourceBaseForRecord(record), entry.path);
  if (!existsSync(sourceRoot)) throw new Error(`插件源目录不存在：${sourceRoot}`);

  // 安装前先解析源清单（名字与目录名一致等硬校验在物化前拦截）
  // 根写法条目（source: "./"）的源目录就是市场根本身——git 市场下目录名是 clone 出来的
  // git-<hash>，与清单名无关，目录名比对在此无意义；改为校验「清单名 == 市场条目名」，
  // 缓存目录名仍由 manifest.name 决定（原不变量由 dest 保证）
  // 市场条目名与源目录名可以不同（Codex 市场很常见）；统一以条目名作为
  // dirName 基准，既支持单插件仓库的根 source，也支持 ./plugins/gitlab-src。
  const manifest = parsePluginManifest(sourceRoot, { dirName: entry.name });
  cacheCatalogEntryMetadata(mktId, entry.name, manifest);

  const dest = installedPluginDir(mktId, manifest.name);
  let destIsLink = false;
  try {
    destIsLink = lstatSync(dest).isSymbolicLink();
  } catch {
    /* 未装或悬空 */
  }
  const updated = lstatExists(dest);
  // 模式判定：显式 link 参数最优先；缺省保持现有模式（链接项点"更新"仍是链接，
  // 不会被静默回退成拷贝而丢掉开发体验）
  const link = opts.link ?? destIsLink;
  if (link && (record.type !== "directory" || entry.source)) {
    throw new Error(
      "链接安装仅支持目录市场的本地 source（git 市场/远程 source 的目录是可被重置的缓存）",
    );
  }
  const sibMeta = `${dest}.installed.json`;
  // revision 先算：git 取短 hash、目录市场取内容签名，均不依赖物化结果
  const revision = link
    ? `link-${sha8(cacheRootSignatureOf(sourceRoot))}`
    : entry.source
      ? await gitShortRevision(sourceRoot)
      : record.type === "git"
        ? await gitShortRevision(marketplaceRepoDir(mktId))
        : `sig-${sha8(cacheRootSignatureOf(sourceRoot))}`;

  const installedAt = new Date().toISOString();
  const meta = {
    pluginId: `${manifest.name}@${mktId}`,
    name: manifest.name,
    catalogName: name,
    marketplaceId: mktId,
    marketplaceName: record.name,
    version: entry.version ?? manifest.version,
    ...(revision ? { revision } : {}),
    ...(link ? { linked: true, sourcePath: resolve(sourceRoot) } : {}),
    installedAt,
  };
  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
  if (link) {
    // 链接装元数据写兄弟文件：写进 dest 即写进用户源仓库，属污染。
    // 软链目标保持 resolve（不做 realpath）：sourcePath 要与用户登记/清单里的
    // 路径完全一致，/var 与 /private/var 这类系统别名不该被改写。
    const target = resolve(sourceRoot);
    replacePluginDirAtomically(dest, (staging) => {
      symlinkSync(target, staging, "dir");
    });
    writeFileSync(sibMeta, metaJson, "utf8");
  } else {
    // 拷贝源可能是符号链接（目录市场里很常见）：cpSync 对符号链接源 + 已存在
    // 的目标目录会 ENOTDIR，解到真实目录再拷。
    const copyRoot = realpathSync(sourceRoot);
    const copyWithSep = copyRoot.endsWith(sep) ? copyRoot : copyRoot + sep;
    replacePluginDirAtomically(dest, (staging) => {
      mkdirSync(staging, { recursive: true });
      cpSync(copyRoot, staging, {
        recursive: true,
        filter: (src) => {
          // 排除 .git 与源目录里上一次安装的元数据；installed.json 由本函数写入
          if (src === join(copyRoot, "installed.json")) return false;
          return !src.split(sep).includes(".git") && !src.startsWith(copyWithSep + ".git");
        },
      });
      writeFileSync(join(staging, "installed.json"), metaJson, "utf8");
    });
    // 从链接装切回拷贝装：清掉上一次链接模式留下的兄弟元数据（失败时保留）。
    // 主物化已经成功，清理失败只记日志，不能把安装报成失败。
    try {
      rmSync(sibMeta, { force: true });
    } catch (err) {
      logErr(
        "plugin install: remove stale link metadata failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  invalidateCaches();

  const fresh = scanInstalledSync().find((p) => p.pluginId === meta.pluginId);
  if (!fresh) throw new Error(`安装后扫描未找到 ${meta.pluginId}（清单校验失败？）`);
  return { plugin: fresh, updated };
}

/** 目标路径是否存在（含悬空符号链接；existsSync 对悬空链接返回 false） */
function lstatExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子替换插件物化目录：先在同级 staging 路径构建，成功后再把旧目录挪成
 * backup、staging 改名为正式路径，最后删 backup。build 抛错或 rename 失败时
 * 旧目录原样保留——更新失败不能把用户手上能用的版本一起弄丢。
 *
 * build(staging) 负责在 staging 位置创建目录或符号链接（helper 不预建，
 * 以便链接安装直接 symlinkSync）。
 */
export function replacePluginDirAtomically(
  dest: string,
  build: (staging: string) => void,
): void {
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now().toString(36)}`;
  const staging = join(parent, `.${basename(dest)}.staging-${stamp}`);
  const backup = join(parent, `.${basename(dest)}.backup-${stamp}`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  try {
    build(staging);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  const hadOld = lstatExists(dest);
  if (hadOld) renameSync(dest, backup);
  try {
    renameSync(staging, dest);
  } catch (err) {
    if (hadOld) {
      try {
        renameSync(backup, dest);
      } catch (restoreErr) {
        logErr(
          "plugin install: restore previous install failed:",
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        );
      }
    }
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  if (hadOld) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (err) {
      logErr(
        "plugin install: remove backup failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
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
  // 官方 Codex 安装器常把 ~/plugins/<name> 做成指向源码的符号链接。
  // cpSync 对符号链接源会尝试在目标位置建链接（目标目录已 mkdir 时直接
  // ENOTDIR）；这里解到真实目录，只拷贝内容。sourcePath 仍记原路径，
  // 更新时重新解析链接即可。
  const realRoot = realpathSync(root);
  // 生态清单允许 name 缺省/与目录名不同；Kova 原生仍在 parse 内做严格校验。
  const manifest = parsePluginManifest(root, { dirName: basename(root) });

  const dest = installedPluginDir(LOCAL_MKT_ID, manifest.name);
  const updated = lstatExists(dest);
  const revision = `sig-${sha8(cacheRootSignatureOf(realRoot))}`;
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
  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
  replacePluginDirAtomically(dest, (staging) => {
    mkdirSync(staging, { recursive: true });
    cpSync(realRoot, staging, {
      recursive: true,
      filter: (src) => {
        // 排除 .git 与源目录里上一次安装的元数据（installed.json 由本函数写入）
        if (src === join(realRoot, "installed.json")) return false;
        return !src.split(sep).includes(".git") && !src.startsWith(realRoot + sep + ".git");
      },
    });
    writeFileSync(join(staging, "installed.json"), metaJson, "utf8");
  });
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
    let displayName = p.manifest.displayName;
    let description = p.manifest.description;
    let category = p.manifest.category;
    let keywords = p.manifest.keywords;
    let icon = resolvePluginIconDataUrl(p.manifest);
    if (p.sourcePath && existsSync(p.sourcePath)) {
      try {
        const src = parsePluginManifest(p.sourcePath);
        version = src.version;
        displayName = src.displayName ?? displayName;
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
      ...(displayName ? { displayName } : {}),
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
  const dir = installedPluginDir(mktId, name);
  if (!existsSync(dir)) throw new Error(`未找到已装插件 "${pluginId}"`);
  // 链接装：rmSync 对 symlink 只删链接本体，源目录不受影响
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.installed.json`, { force: true }); // 链接装兄弟元数据（拷贝装无此文件）
  await setPluginEnabled(pluginId, true); // 删除 disabled 记录（= 恢复默认启用，键消失）
  invalidateCaches();
}
