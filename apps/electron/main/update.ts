/**
 * 升级检查（对齐 update.rs 的清单协议与节流纪律）：
 * R2 latest.json（{channel}/latest.json）、渠道不串、12h 节流、失败静默、
 * 结果缓存进 kv。差异（PORTING-NOTES）：update_install 不做到地替换——
 * 旧桌面壳 minisign 包格式与 Electron 产物不通用，安装动作退回打开下载页。
 */
import { app, shell } from "electron";
import { kvGet, kvSet, kvDelete } from "./store";
import { emitToWindows } from "./ipc";
import { logInfo, logWarn } from "./logging";

const ENDPOINT_KV_KEY = "update.endpoint";
const LAST_CHECK_KEY = "update.lastCheckAt";
const LAST_RESULT_KEY = "update.lastResult";
const SKIPPED_KEY = "update.skippedVersion";
const AUTO_KEY = "update.autoCheck";
const DEFAULT_BASE = "https://dl.openkova.site";
const CHECK_INTERVAL_MS = 12 * 3600 * 1000;

function nowMs(): number {
  return Date.now();
}

interface CachedManifest {
  version: string;
  notes?: string | null;
  pageUrl?: string | null;
  downloads: Record<string, string>;
  /** Electron 版专用直链（downloadsElectron.<platformKey>）：与 旧桌面壳的 downloads 分键，
   *  否则把 Electron 产物写进 downloads 会把 旧桌面壳 老用户的"应用内更新"引到装不上的包 */
  downloadsElectron?: Record<string, string>;
  checkedAt: number;
}

function parseVersion(v: string): [number, number, number, string | null] | null {
  const s = v.trim().replace(/^v/, "");
  const dash = s.indexOf("-");
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : null;
  const parts = core.split(".");
  const major = parseInt(parts[0] ?? "", 10);
  if (!Number.isFinite(major)) return null;
  const minor = Number.isFinite(parseInt(parts[1] ?? "0", 10)) ? parseInt(parts[1] ?? "0", 10) : 0;
  const patch = Number.isFinite(parseInt(parts[2] ?? "0", 10)) ? parseInt(parts[2] ?? "0", 10) : 0;
  return [major, minor, patch, pre];
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  if (l[2] !== c[2]) return l[2] > c[2];
  if (l[3] === null && c[3] !== null) return true;
  if (l[3] !== null && c[3] === null) return false;
  if (l[3] !== null && c[3] !== null) return String(l[3]) > String(c[3]);
  return false;
}

function channelOf(version: string): string {
  return version.includes("-preview") ? "preview" : "stable";
}

function platformKey(): string {
  if (process.platform === "darwin") return process.arch === "arm64" ? "macos-aarch64" : "macos-x64";
  if (process.platform === "win32") return "windows-x64";
  return "linux-x64";
}

function endpointBase(): string {
  const raw = safeKv(ENDPOINT_KV_KEY);
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_BASE;
}

function manifestUrl(channel: string): string {
  return `${endpointBase()}/${channel}/latest.json`;
}

function safeKv(key: string): string | null {
  try {
    return kvGet(key);
  } catch {
    return null;
  }
}

function autoCheckEnabled(): boolean {
  return safeKv(AUTO_KEY) !== "false";
}

function skippedVersion(): string | null {
  const v = safeKv(SKIPPED_KEY);
  return v && v.trim().length > 0 ? v.trim() : null;
}

function lastCheckedAt(): number | null {
  const raw = safeKv(LAST_CHECK_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function cachedManifest(): CachedManifest | null {
  const raw = safeKv(LAST_RESULT_KEY);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (typeof m?.version !== "string" || !m.version) return null;
    const dl = m.downloads ?? {};
    const dlElectron = m.downloadsElectron ?? {};
    return {
      version: m.version,
      notes: m.notes ?? null,
      pageUrl: m.pageUrl ?? null,
      downloads: { ...dl, ...dlElectron },
      downloadsElectron: dlElectron,
      checkedAt: Number(m.checkedAt ?? 0),
    };
  } catch {
    return null;
  }
}

function storeManifest(m: CachedManifest): void {
  try {
    kvSet(LAST_RESULT_KEY, JSON.stringify(m));
    kvSet(LAST_CHECK_KEY, String(m.checkedAt));
  } catch {
    /* 缓存失败不影响本次结果 */
  }
}

async function fetchManifest(url: string): Promise<CachedManifest> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  let text: string;
  try {
    const resp = await fetch(url, { signal: ac.signal, headers: { "user-agent": "kova-desktop-update-check" }, redirect: "follow" });
    if (!resp.ok) throw new Error(`http error: ${resp.status}`);
    text = await resp.text();
  } catch (e: any) {
    clearTimeout(t);
    throw new Error(e?.name === "AbortError" ? "network error: timeout" : `network error: ${e?.message ?? e}`);
  }
  clearTimeout(t);
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`invalid manifest json: ${e?.message ?? e}`);
  }
  const version = typeof v?.version === "string" ? v.version.trim() : "";
  if (!version) throw new Error("manifest has no version");
  const pickStrings = (src: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (src && typeof src === "object") {
      for (const [k, val] of Object.entries(src)) {
        if (typeof val === "string") out[k] = val;
      }
    }
    return out;
  };
  return {
    version,
    notes: typeof v?.notes === "string" ? v.notes : null,
    pageUrl: typeof v?.pageUrl === "string" ? v.pageUrl : null,
    downloads: pickStrings(v?.downloads),
    downloadsElectron: pickStrings(v?.downloadsElectron),
    checkedAt: nowMs(),
  };
}

function buildInfo(current: string, m: CachedManifest | null, fromCache: boolean): any {
  const latest = m ? m.version : null;
  const hasUpdate = latest ? isNewer(latest, current) : false;
  const skipped = latest !== null && skippedVersion() !== null && latest === skippedVersion();
  return {
    current,
    latest,
    hasUpdate,
    channel: channelOf(current),
    notes: m?.notes ?? null,
    pageUrl: m?.pageUrl ?? null,
    downloadUrl: m ? (m.downloadsElectron?.[platformKey()] ?? m.downloads[platformKey()]) ?? null : null,
    checkedAt: m ? m.checkedAt : null,
    skipped,
    autoCheck: autoCheckEnabled(),
    fromCache,
  };
}

export async function updateCheck(args: { force?: boolean | null }): Promise<any> {
  const force = Boolean(args?.force);
  const current = app.getVersion();
  const channel = channelOf(current);
  const last = lastCheckedAt();
  const throttled = last !== null && nowMs() - last < CHECK_INTERVAL_MS;
  if (!force && (!autoCheckEnabled() || throttled)) {
    return buildInfo(current, cachedManifest(), true);
  }
  const url = manifestUrl(channel);
  try {
    const m = await fetchManifest(url);
    storeManifest(m);
    logInfo(`[update] manifest ${m.version} -> ${channel} (${url})`);
    return buildInfo(current, m, false);
  } catch (e: any) {
    if (force) throw e;
    logWarn(`[update] check failed (silent): ${e?.message ?? e}`);
    return buildInfo(current, cachedManifest(), true);
  }
}

export function updateSkipVersion(args: { version?: string | null }): null {
  const v = typeof args?.version === "string" ? args.version.trim() : "";
  if (v.length > 0) kvSet(SKIPPED_KEY, v);
  else kvDelete(SKIPPED_KEY);
  return null;
}

export function updateSetAutoCheck(args: { enabled: boolean }): null {
  kvSet(AUTO_KEY, args?.enabled ? "true" : "false");
  return null;
}

function emitProgress(phase: string, done: number, total: number, message: string): void {
  emitToWindows("update:progress", { phase, done, total, message });
}

/**
 * Electron 版安装：产物格式与 旧桌面壳 updater 包不通用，
 * 改为打开当前平台下载直链（无直链退回下载页）。失败时按前端语义抛错。
 */
export async function updateInstall(): Promise<null> {
  const current = app.getVersion();
  const m = cachedManifest() ?? (await updateCheck({ force: true }) ? (await cachedManifest()) : null);
  const url = m?.downloads?.[platformKey()] ?? m?.pageUrl ?? `${endpointBase()}/${channelOf(current)}/`;
  emitProgress("download", 0, 0, "打开下载页…");
  if (!/^https?:\/\//.test(url)) throw new Error("当前平台没有可用的安装包");
  void shell.openExternal(url);
  emitProgress("done", 1, 1, "已在浏览器中打开下载页，下载后替换应用即可");
  return null;
}

export function setupUpdateCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("update_check", (a) => updateCheck(a));
  register("update_skip_version", (a) => updateSkipVersion(a));
  register("update_set_auto_check", (a) => updateSetAutoCheck(a));
  register("update_install", () => updateInstall());
}
