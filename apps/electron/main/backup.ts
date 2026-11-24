/**
 * 备份与恢复（对齐 backup.rs 全契约）：应用数据打包为 `.piabk` 信封
 * （`PIABK1\n` + JSON header + tar.gz 负载，可选 AES-256-GCM/PBKDF2 口令加密），
 * 上传 S3（手写 SigV4）或 WebDAV，或写本地文件；恢复经「staging + 待恢复标记」
 * 在下次启动、任何存储打开之前原子换入。
 *
 * 跨语言兼容：信封字节布局、KDF 参数（PBKDF2-SHA256 / 600000 / 32B 键 / 12B nonce /
 * 16B salt）、payloadSha256（对最终字节，加密后）与 Rust 版一致——Rust 版可直接
 * 解开本版产物，反之亦然（tar 由系统 tar/bsdtar 读写，标准 ustar/pax 均可互读）。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { app } from "electron";
import { appDataDir, dbPath } from "./paths";
import { getDb, kvDelete, kvGet, kvSet } from "./store";
import { emitToWindows } from "./ipc";
import { logInfo, logWarn } from "./logging";
import { decrypt, encrypt, isEncrypted, isSecretCipherReady } from "./secret";
import {
  NETWORK_PROXY_KV_KEY,
  parseNetworkProxyConfig,
  serializeNetworkProxyConfig,
} from "pi-protocol";
import { isLocalProxyHost } from "./system-proxy";
import { openDb } from "./db";
import { taskWorkspaceRoot, isTaskWorkspaceMigrating } from "./task-workspace-root";
import {
  backupCollectPlan,
  collectDirFiles,
  collectFileIfExists,
  DB_FILE,
  headerSummary,
  kovaHomeDir,
  LIBRARY_DIR,
  MAGIC,
  parseHeaderFromPrefix,
  passphraseDecision,
  planRestore,
  readEnvelopeHeader,
  restoreTargets,
  SESSIONS_DIR,
  type BackupHeader,
  type BackupSectionFlags,
  type BackupSectionId,
  type CollectStats,
  type FileEntry,
  type KdfParams,
} from "./backup-plan";

const FORMAT_VERSION = 1;
const SCHEMA_VERSION = 2;
const KDF_ITERATIONS = 600_000;
const CONFIG_KEY = "backup.config.v1";
const PENDING_RESTORE_FILE = "pending-restore.json";
const RESTORE_APPLIED_FILE = "restore-applied.json";
const RESTORE_STAGING_DIR = "restore-staging";
const PROGRESS_EVENT = "backup:progress";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/* ------------------------------------------------------------------ 基础 */

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path: string): { size: number; hash: string } {
  const data = readFileSync(path);
  return { size: data.length, hash: sha256Hex(data) };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, KDF_ITERATIONS, 32, "sha256");
}

function encryptPayload(plain: Uint8Array, passphrase: string): { payload: Buffer; kdf: KdfParams } {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]); // tag 尾接，同 aes-gcm crate
  return {
    payload: ct,
    kdf: { algo: "PBKDF2-SHA256", salt: salt.toString("base64"), iterations: KDF_ITERATIONS, nonce: nonce.toString("base64") },
  };
}

function decryptPayload(ct: Uint8Array, kdf: KdfParams, passphrase: string): Buffer {
  const salt = Buffer.from(kdf.salt, "base64");
  const nonce = Buffer.from(kdf.nonce, "base64");
  const key = deriveKey(passphrase, salt);
  if (ct.length < 16) throw new Error("口令错误或备份已损坏（GCM 校验失败）");
  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error("口令错误或备份已损坏（GCM 校验失败）");
  }
}

/* ------------------------------------------------------------------ 信封 */

function localStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}
function fileStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tarExtract(tgz: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tgz, "-C", destDir], { windowsHide: true });
  if (r.status !== 0) throw new Error(`解包失败: ${r.stderr?.toString().trim() || `tar exit ${r.status}`}`);
}

function tarCreate(tgz: string, rootDir: string, rels: string[]): void {
  if (rels.length === 0) {
    // 空负载：先造一个空 gzip（tar 无成员）
    const r = spawnSync("tar", ["-czf", tgz, "-T", "/dev/null", "-C", rootDir], { windowsHide: true });
    if (r.status !== 0) throw new Error(`finish tar: ${r.stderr?.toString().trim() || `tar exit ${r.status}`}`);
    return;
  }
  // rel 列表走 stdin（-T -），避免超长参数表；路径为相对 rootDir 的形式
  const input = rels.join("\n") + "\n";
  const r = spawnSync("tar", ["-czf", tgz, "-C", rootDir, "-T", "-"], { input, windowsHide: true });
  if (r.status !== 0) throw new Error(`pack tar: ${r.stderr?.toString().trim() || `tar exit ${r.status}`}`);
}

type Progress = (done: number, total: number, msg: string) => void;

/** 大备份（数万文件）逐文件进度事件会淹没渲染层：按 100ms 节流，首尾必发 */
function throttleProgress(progress: Progress): Progress {
  let lastAt = 0;
  return (done, total, msg) => {
    const now = Date.now();
    if (done <= 1 || done >= total || now - lastAt >= 100) {
      lastAt = now;
      progress(done, total, msg);
    }
  };
}

/**
 * 打包备份信封（对齐 pack_backup）：返回（信封路径，header）。
 * 逐文件先快照拷贝再哈希再入包——sessions JSONL 由 sidecar 流式追加，
 * 直接对原文件"先哈希后打包"会在两次读取间被追加，恢复时校验失败。
 */
export function packBackup(
  dbSnapshot: string,
  dataDir: string,
  flags: BackupSectionFlags,
  passphrase: string | null,
  device: string,
  appVersion: string,
  progress: Progress,
): { envelope: string; header: BackupHeader } {
  const entries: [string, string][] = [];
  entries.push([dbSnapshot, DB_FILE]);
  const included = new Set<BackupSectionId>(["core"]);
  const stats: CollectStats = { skippedLinks: 0, skippedLinksPaths: [] };
  // 资料库只收缺省位置（<dataDir>/library）：包内条目按 dataDir 相对路径落位，
  // 用户改到别处的那份由用户自己的同步工具负责（设置页有对应说明）。
  // 任务产物不同：根的移动由本应用自己完成（设置 → 通用 → 任务产物位置），
  // 因此按当前根收集；包内路径仍是 task-workspace/**（换机兼容）。
  for (const source of backupCollectPlan(flags, dataDir, kovaHomeDir(), taskWorkspaceRoot())) {
    const before = entries.length;
    if (source.kind === "dir") collectDirFiles(source.abs, source.rel, entries, stats);
    else collectFileIfExists(source.abs, source.rel, entries);
    if (entries.length > before) included.add(source.section);
  }
  if (stats.skippedLinks > 0) {
    const sample = stats.skippedLinksPaths.join(", ");
    logWarn(
      `[backup] skipped ${stats.skippedLinks} symlink(s) pointing outside collection roots: ${sample}${stats.skippedLinks >= stats.skippedLinksPaths.length ? " …" : ""}`,
    );
  }
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const tmp = join(tmpdir(), `piabk-pack-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  let envelope: string;
  let header: BackupHeader;
  // 打包中途失败（磁盘满、tar 失败等）时清掉自己的临时目录：
  // snapshotDir 是全量数据的拷贝，泄漏可能占满 tmp
  try {
    const tarPath = join(tmp, "payload.tar.gz");
    const snapshotDir = join(tmp, "snapshot");

    const total = entries.length;
    const fileEntries: FileEntry[] = [];
    const rels: string[] = [];
    const tick = throttleProgress(progress);
    for (let idx = 0; idx < entries.length; idx++) {
      const [abs, rel] = entries[idx];
      const snap = join(snapshotDir, rel);
      mkdirSync(dirname(snap), { recursive: true });
      copyFileSync(abs, snap);
      const { size, hash } = sha256File(snap);
      fileEntries.push({ path: rel, size, sha256: hash });
      rels.push(rel);
      tick(idx + 1, total, rel);
    }
    tarCreate(tarPath, snapshotDir, rels);

    const plain = readFileSync(tarPath);
    rmSync(tarPath, { force: true });
    rmSync(snapshotDir, { recursive: true, force: true });

    let payload: Uint8Array = plain;
    let kdf: KdfParams | undefined;
    if (passphrase && passphrase.length > 0) {
      progress(0, 1, "加密负载…");
      const enc = encryptPayload(plain, passphrase);
      payload = enc.payload;
      kdf = enc.kdf;
    }

    header = {
      formatVersion: FORMAT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: localStamp(),
      device,
      appVersion,
      encrypted: kdf !== undefined,
      ...(kdf ? { kdf } : {}),
      payloadSha256: sha256Hex(payload),
      payloadSize: payload.length,
      files: fileEntries,
      sections: [...included],
    };    const fileName = `pi-backup-${fileStamp()}.piabk`;
    envelope = join(tmp, fileName);
    const envelopeBytes: Uint8Array = Buffer.concat([
      MAGIC,
      Buffer.from(JSON.stringify(header), "utf8"),
      Buffer.from("\n", "utf8"),
      payload,
    ]);
    writeFileSync(envelope, envelopeBytes);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { envelope, header };
}

/* ------------------------------------------------------------------ 解包 */

/** 丢弃 JSONL 末尾没有换行的残行（流式追加在备份瞬间可能截断半行） */
function trimTornJsonlTails(root: string): void {
  let names: string[];
  try {
    names = readdirSync(join(root, SESSIONS_DIR));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(root, SESSIONS_DIR, name);
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      continue;
    }
    if (content.length === 0 || content[content.length - 1] === 0x0a) continue;
    const pos = content.lastIndexOf(0x0a);
    writeFileSync(path, pos >= 0 ? content.subarray(0, pos + 1) : Buffer.alloc(0));
  }
}

/**
 * 解包信封到 destDir：逐文件 sha256 校验 + 修剪残行。
 * 口令通过回调在解析出 header 之后才决定——header 内含逐文件清单，体积随
 * 文件数线性增长，固定大小前缀会把真实备份全部误判成「header 未完整」；
 * 未加密包也不会被「记住的口令已失效」卡住。
 */
export function unpackBackup(
  envelope: string,
  destDir: string,
  resolvePassphrase: (header: BackupHeader) => string | null,
  progress: Progress,
): BackupHeader {
  const raw = readFileSync(envelope);
  const first = raw.indexOf(0x0a);
  if (first < 0) throw new Error("不是有效的备份包（header 截断）");
  const second = raw.indexOf(0x0a, first + 1);
  if (second < 0) throw new Error("不是有效的备份包（header 截断）");
  const header = parseHeaderFromPrefix(raw.subarray(0, second + 1));
  const payload = raw.subarray(second + 1);
  if (header.payloadSha256 !== sha256Hex(payload)) {
    throw new Error("负载校验失败（sha256 不匹配，下载不完整或文件损坏）");
  }
  let tarBytes: Buffer;
  if (header.kdf) {
    const passphrase = resolvePassphrase(header);
    if (!passphrase || passphrase.length === 0) throw new Error("该备份已加密，需要口令");
    tarBytes = decryptPayload(payload, header.kdf, passphrase);
  } else {
    tarBytes = payload;
  }

  const tgz = join(tmpdir(), `piabk-unpack-${randomUUID()}.tar.gz`);
  writeFileSync(tgz, tarBytes);
  try {
    tarExtract(tgz, destDir);
  } finally {
    rmSync(tgz, { force: true });
  }

  const total = header.files.length;
  for (let idx = 0; idx < header.files.length; idx++) {
    const fe = header.files[idx];
    const { hash } = sha256File(join(destDir, fe.path));
    if (hash !== fe.sha256) throw new Error(`文件校验失败: ${fe.path}`);
    progress(idx + 1, total, fe.path);
  }
  trimTornJsonlTails(destDir);
  return header;
}

/* ------------------------------------------------------------------ 配置 */

export interface BackupConfig {
  provider: string;
  includeWorkspace: boolean;
  includeLibrary: boolean;
  includePersonal: boolean;
  includeSkillsPlugins: boolean;
  includeCheckpoints: boolean;
  deviceName: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3PathStyle: boolean;
  davUrl: string;
  davUsername: string;
  davPassword: string;
  davSubdir: string;
  rememberPassphrase: boolean;
  passphrase: string;
}

function defaultConfig(): BackupConfig {
  return {
    provider: "off",
    includeWorkspace: true,
    includeLibrary: true,
    includePersonal: true,
    includeSkillsPlugins: true,
    includeCheckpoints: false,
    deviceName: "desktop",
    s3Endpoint: "",
    s3Region: "us-east-1",
    s3Bucket: "",
    s3Prefix: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3PathStyle: true,
    davUrl: "",
    davUsername: "",
    davPassword: "",
    davSubdir: "",
    rememberPassphrase: false,
    passphrase: "",
  };
}

function loadConfig(): BackupConfig {
  const raw = kvGet(CONFIG_KEY);
  if (!raw) return defaultConfig();
  try {
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(cfg: BackupConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(cfg));
}

function configView(c: BackupConfig): any {
  return {
    provider: c.provider,
    includeWorkspace: c.includeWorkspace,
    includeLibrary: c.includeLibrary,
    includePersonal: c.includePersonal,
    includeSkillsPlugins: c.includeSkillsPlugins,
    includeCheckpoints: c.includeCheckpoints,
    deviceName: c.deviceName,
    s3Endpoint: c.s3Endpoint,
    s3Region: c.s3Region,
    s3Bucket: c.s3Bucket,
    s3Prefix: c.s3Prefix,
    s3AccessKeyId: c.s3AccessKeyId,
    s3SecretAccessKeySet: c.s3SecretAccessKey.length > 0,
    s3PathStyle: c.s3PathStyle,
    davUrl: c.davUrl,
    davUsername: c.davUsername,
    davPasswordSet: c.davPassword.length > 0,
    davSubdir: c.davSubdir,
    rememberPassphrase: c.rememberPassphrase,
    passphraseSet: c.passphrase.length > 0,
  };
}

/** 新值空串 = 保留旧值；已是密文（aes:v1:/enc:v1:）= 原样；否则加密落库 */
function mergeSecret(oldV: string, newV: string): string {
  if (!newV || newV.length === 0) return oldV;
  if (isEncrypted(newV)) return newV;
  return encrypt(newV);
}

function mergeConfig(oldC: BackupConfig, newC: BackupConfig): BackupConfig {
  const c = { ...newC };
  c.s3SecretAccessKey = mergeSecret(oldC.s3SecretAccessKey, newC.s3SecretAccessKey);
  c.davPassword = mergeSecret(oldC.davPassword, newC.davPassword);
  c.passphrase = newC.rememberPassphrase ? mergeSecret(oldC.passphrase, newC.passphrase) : "";
  return c;
}

/* ------------------------------------------------------------------ SigV4 / S3 */

function hmacSha256(key: Buffer, data: Buffer | string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

const UNRESERVED = /[A-Za-z0-9\-_.~]/;
function uriEncode(s: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(ch);
    if (UNRESERVED.test(c)) out += c;
    else if (ch === 0x2f && !encodeSlash) out += "/";
    else out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function percentDecode(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && i + 2 < s.length) {
      const v = parseInt(s.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(v)) {
        bytes.push(v);
        i += 2;
        continue;
      }
    }
    bytes.push(s.charCodeAt(i));
  }
  return Buffer.from(bytes).toString("utf8");
}

function sigv4Authorization(opts: {
  method: string;
  url: URL;
  query: [string, string][];
  extraHeaders: [string, string][];
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  amzDate: string;
  dateStamp: string;
}): string {
  let host = opts.url.hostname;
  if (opts.url.port) host += `:${opts.url.port}`;
  const headers: [string, string][] = [
    ["host", host],
    ["x-amz-content-sha256", opts.payloadHash],
    ["x-amz-date", opts.amzDate],
    ...opts.extraHeaders.map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string]),
  ];
  headers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join("");

  const segs = opts.url.pathname.split("/").map((s) => uriEncode(s, false));
  let canonicalUri = segs.join("/");
  if (!canonicalUri.startsWith("/")) canonicalUri = "/" + canonicalUri;
  if (canonicalUri === "") canonicalUri = "/";

  const sortedQuery = [...opts.query].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const canonicalQuery = sortedQuery.map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`).join("&");

  const canonicalRequest = `${opts.method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${opts.payloadHash}`;
  const scope = `${opts.dateStamp}/${opts.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${opts.amzDate}\n${scope}\n${sha256Hex(Buffer.from(canonicalRequest, "utf8"))}`;
  const kDate = hmacSha256(Buffer.from(`AWS4${opts.secretKey}`, "utf8"), opts.dateStamp);
  const kRegion = hmacSha256(kDate, opts.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, Buffer.from(stringToSign, "utf8")).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

interface S3Cfg {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

function s3From(c: BackupConfig): S3Cfg {
  if (!c.s3Bucket.trim()) throw new Error("S3 bucket 未配置");
  let secret = "";
  if (c.s3SecretAccessKey.length > 0) {
    const dec = decrypt(c.s3SecretAccessKey);
    secret = dec.ok ? dec.value : "";
  }
  if (!c.s3AccessKeyId.trim() || !secret) throw new Error("S3 访问密钥未配置或无法解密（请重新填写）");
  return {
    endpoint: c.s3Endpoint.trim().replace(/\/+$/, ""),
    region: c.s3Region.trim() || "us-east-1",
    bucket: c.s3Bucket.trim(),
    prefix: c.s3Prefix.trim().replace(/^\/+|\/+$/g, ""),
    accessKeyId: c.s3AccessKeyId.trim(),
    secretAccessKey: secret,
    pathStyle: c.s3PathStyle,
  };
}

function s3Key(cfg: S3Cfg, name: string): string {
  return cfg.prefix ? `${cfg.prefix}/${name}` : name;
}

function s3ObjectUrl(cfg: S3Cfg, key: string): string {
  const encKey = key.split("/").map((s) => uriEncode(s, false)).join("/");
  if (!cfg.endpoint) {
    return cfg.pathStyle
      ? `https://s3.${cfg.region}.amazonaws.com/${cfg.bucket}/${encKey}`
      : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${encKey}`;
  }
  const base = cfg.endpoint.startsWith("http://") || cfg.endpoint.startsWith("https://") ? cfg.endpoint : `https://${cfg.endpoint}`;
  if (cfg.pathStyle) return `${base}/${cfg.bucket}/${encKey}`;
  const u = new URL(base);
  const port = u.port ? `:${u.port}` : "";
  return `${u.protocol}//${cfg.bucket}.${u.hostname}${port}/${encKey}`;
}

function s3DirUrl(cfg: S3Cfg): string {
  return s3ObjectUrl(cfg, "");
}

async function checkStatus(resp: Response, channel: string, method: string, url: string, extraOk: number[] = []): Promise<Response> {
  if (resp.ok || extraOk.includes(resp.status)) return resp;
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location") ?? "";
    throw new Error(
      `${channel} ${method} ${url} 返回 HTTP ${resp.status}（服务器要求重定向到 ${loc}；已停止自动跟随，请把 URL 改成最终地址）`,
    );
  }
  const text = await resp.text().catch(() => "");
  const snippet = Array.from(text).slice(0, 300).join("");
  throw new Error(`${channel} ${method} ${url} 返回 HTTP ${resp.status}: ${snippet}`);
}

async function s3SignedRequest(
  cfg: S3Cfg,
  method: string,
  urlStr: string,
  query: [string, string][],
  extraHeaders: [string, string][],
  body: Buffer | null,
  extraOk: number[],
  timeoutMs: number,
): Promise<Response> {
  const fullUrl = query.length === 0
    ? urlStr
    : `${urlStr}?${[...query]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
        .join("&")}`;
  const url = new URL(fullUrl);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const amzDate = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const auth = sigv4Authorization({
    method,
    url,
    query,
    extraHeaders,
    payloadHash,
    accessKey: cfg.accessKeyId,
    secretKey: cfg.secretAccessKey,
    region: cfg.region,
    amzDate,
    dateStamp,
  });
  const headers = new Headers();
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  headers.set("authorization", auth);
  for (const [k, v] of extraHeaders) {
    if (!k.toLowerCase().includes("host")) headers.set(k, v);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(fullUrl, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: "manual", signal: ac.signal });
    return await checkStatus(resp, "S3", method, fullUrl, extraOk);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`请求超时: ${method} ${fullUrl}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ WebDAV */

const PROPFIND_BODY =
  `<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>`;
const DAV_405_HINT =
  "HTTP 405 多见于 URL 指向只读根目录（NAS 通常把共享目录挂在根下，根目录禁止写入）：请把「子目录」设置为某个可写共享目录下的路径，例如 home/pi-backups";

interface DavCfg {
  url: string;
  username: string;
  password: string;
  subdir: string;
}
function davFrom(c: BackupConfig): DavCfg {
  if (!c.davUrl.trim()) throw new Error("WebDAV URL 未配置");
  let password = "";
  if (c.davPassword.length > 0) {
    const dec = decrypt(c.davPassword);
    password = dec.ok ? dec.value : "";
  }
  return {
    url: c.davUrl.trim().replace(/\/+$/, ""),
    username: c.davUsername.trim(),
    password,
    subdir: c.davSubdir.trim().replace(/^\/+|\/+$/g, ""),
  };
}
function davDirUrl(cfg: DavCfg): string {
  return cfg.subdir ? `${cfg.url}/${cfg.subdir}/` : `${cfg.url}/`;
}
function davFileUrl(cfg: DavCfg, name: string): string {
  return davDirUrl(cfg) + name.split("/").map((s) => uriEncode(s, false)).join("/");
}
function davAuth(cfg: DavCfg): string | null {
  if (!cfg.username && !cfg.password) return null;
  return `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`, "utf8").toString("base64")}`;
}

async function davRequest(cfg: DavCfg, method: string, url: string, body: string | null, extraOk: number[], timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers = new Headers(extraHeaders);
  const auth = davAuth(cfg);
  if (auth) headers.set("authorization", auth);
  if (body !== null) {
    headers.set("content-type", "application/xml");
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method, headers, body: body ?? undefined, redirect: "manual", signal: ac.signal });
    return await checkStatus(resp, "WebDAV", method, url, extraOk);
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`请求超时: ${method} ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function with405Hint(msg: string): string {
  return msg.includes("HTTP 405") ? `${msg}\n${DAV_405_HINT}` : msg;
}

async function davCollectionExists(cfg: DavCfg, url: string, timeoutMs: number): Promise<boolean> {
  try {
    const resp = await davRequest(cfg, "PROPFIND", url, PROPFIND_BODY, [207], timeoutMs, { depth: "0" });
    return resp.status === 207;
  } catch (e: any) {
    if (String(e?.message ?? e).includes("HTTP 404")) return false;
    return true;
  }
}

/** 逐级 MKCOL 建目录；MKCOL 失败时以 PROPFIND 确认确实存在才继续（对齐 mkcol_deep） */
async function davMkcolDeep(cfg: DavCfg, timeoutMs: number): Promise<void> {
  const base = new URL(`${cfg.url.replace(/\/+$/, "")}/`);
  const basePath = base.pathname.replace(/\/+$/, "");
  const targetPath = new URL(davDirUrl(cfg)).pathname.replace(/\/+$/, "");
  if (!targetPath.startsWith(basePath)) throw new Error("WebDAV 子目录必须位于 URL 路径之内");
  let acc = basePath;
  const rel = targetPath.slice(basePath.length);
  for (const seg of rel.split("/").filter(Boolean)) {
    acc = `${acc}/${seg}`;
    const url = `${base.protocol}//${base.host}${acc}`;
    try {
      await davRequest(cfg, "MKCOL", url, null, [], timeoutMs);
    } catch (e: any) {
      if (!(await davCollectionExists(cfg, url, timeoutMs))) throw new Error(with405Hint(String(e?.message ?? e)));
    }
  }
}

async function davList(cfg: DavCfg, timeoutMs: number): Promise<[string, number, string][]> {
  const url = davDirUrl(cfg);
  let resp: Response;
  try {
    resp = await davRequest(cfg, "PROPFIND", url, PROPFIND_BODY, [207], timeoutMs, { depth: "1" });
  } catch (e: any) {
    if (String(e?.message ?? e).includes("HTTP 404")) return [];
    throw e;
  }
  const text = await resp.text();
  const out: [string, number, string][] = [];
  for (const block of xmlBlocks(text, "response")) {
    const href = percentDecode(xmlFirst(block, "href") ?? "");
    const rtype = (xmlFirst(block, "resourcetype") ?? "").toLowerCase();
    const isDir = rtype.includes("collection") || rtype.includes("<dir") || href.endsWith("/");
    if (isDir || !href) continue;
    const name = href.replace(/\/+$/, "").split("/").pop() ?? "";
    if (!name) continue;
    const size = parseInt(xmlFirst(block, "getcontentlength") ?? "0", 10) || 0;
    const modified = xmlFirst(block, "getlastmodified") ?? "";
    out.push([name, size, modified]);
  }
  return out;
}

/* ------------------------------------------------------------------ 极简 XML 扫描 */

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const lower = xml.toLowerCase();
  const t = tag.toLowerCase();
  let i = 0;
  for (;;) {
    const open = lower.indexOf(`<${t}`, i);
    if (open < 0) break;
    const openEnd = lower.indexOf(">", open);
    if (openEnd < 0) break;
    // 自闭合视为空块
    if (lower[openEnd - 1] === "/") {
      out.push("");
      i = openEnd + 1;
      continue;
    }
    const close = lower.indexOf(`</${t}`, openEnd);
    if (close < 0) break;
    out.push(xml.slice(openEnd + 1, close));
    i = close + 1;
  }
  return out;
}

function xmlFirst(xml: string, tag: string): string | null {
  const blocks = xmlBlocks(xml, tag);
  return blocks.length > 0 ? blocks[0] : null;
}

/* ------------------------------------------------------------------ 远端通道 */

interface RemoteBackup {
  name: string;
  size: number;
  modified: string;
  encrypted: boolean;
}

class RemoteChannel {
  constructor(private cfg: BackupConfig, private s3: S3Cfg | null, private dav: DavCfg | null, private timeoutMs: number) {}

  static fromConfig(cfg: BackupConfig, timeoutMs: number): RemoteChannel {
    if (cfg.provider === "s3") return new RemoteChannel(cfg, s3From(cfg), null, timeoutMs);
    if (cfg.provider === "webdav") return new RemoteChannel(cfg, null, davFrom(cfg), timeoutMs);
    throw new Error(`未知的备份通道: ${cfg.provider}`);
  }

  async put(name: string, bytes: Buffer): Promise<void> {
    if (this.s3) {
      await s3SignedRequest(this.s3, "PUT", s3ObjectUrl(this.s3, s3Key(this.s3, name)), [], [], bytes, [], this.timeoutMs);
      return;
    }
    const cfg = this.dav!;
    const url = davFileUrl(cfg, name);
    const headers = new Headers();
    const auth = davAuth(cfg);
    if (auth) headers.set("authorization", auth);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, { method: "PUT", headers, body: new Uint8Array(bytes), redirect: "manual", signal: ac.signal });
      await checkStatus(resp, "WebDAV", "PUT", url, []).catch((e) => {
        throw new Error(with405Hint(String(e?.message ?? e)));
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getToFile(name: string, dest: string): Promise<number> {
    let resp: Response;
    if (this.s3) {
      resp = await s3SignedRequest(this.s3, "GET", s3ObjectUrl(this.s3, s3Key(this.s3, name)), [], [], null, [], this.timeoutMs);
    } else {
      resp = await davRequest(this.dav!, "GET", davFileUrl(this.dav!, name), null, [], this.timeoutMs);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return buf.length;
  }

  async getPrefix(name: string, maxBytes: number): Promise<Buffer> {
    const range: [string, string][] = [["Range", `bytes=0-${maxBytes - 1}`]];
    let resp: Response;
    if (this.s3) {
      resp = await s3SignedRequest(this.s3, "GET", s3ObjectUrl(this.s3, s3Key(this.s3, name)), [], range, null, [], this.timeoutMs);
    } else {
      const url = davFileUrl(this.dav!, name);
      const headers = new Headers({ range: `bytes=0-${maxBytes - 1}` });
      const auth = davAuth(this.dav!);
      if (auth) headers.set("authorization", auth);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        resp = await fetch(url, { headers, redirect: "manual", signal: ac.signal });
        await checkStatus(resp, "WebDAV", "GET", url, []);
      } finally {
        clearTimeout(timer);
      }
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.subarray(0, maxBytes);
  }

  async delete(name: string): Promise<boolean> {
    if (this.s3) {
      const resp = await s3SignedRequest(this.s3, "DELETE", s3ObjectUrl(this.s3, s3Key(this.s3, name)), [], [], null, [404], this.timeoutMs);
      return resp.status !== 404;
    }
    const resp = await davRequest(this.dav!, "DELETE", davFileUrl(this.dav!, name), null, [404], this.timeoutMs);
    return resp.status !== 404;
  }

  async list(): Promise<[string, number, string][]> {
    if (this.s3) {
      const cfg = this.s3;
      const prefix = cfg.prefix ? `${cfg.prefix}/` : "";
      const out: [string, number, string][] = [];
      let token: string | null = null;
      for (;;) {
        const query: [string, string][] = [
          ["list-type", "2"],
          ["max-keys", "1000"],
          ["prefix", prefix],
        ];
        if (token) query.push(["continuation-token", token]);
        const resp = await s3SignedRequest(cfg, "GET", s3DirUrl(cfg), query, [], null, [], this.timeoutMs);
        const text = await resp.text();
        for (const block of xmlBlocks(text, "Contents")) {
          const key = xmlFirst(block, "Key") ?? "";
          const size = parseInt(xmlFirst(block, "Size")?.trim() ?? "0", 10) || 0;
          const modified = xmlFirst(block, "LastModified") ?? "";
          if (key) out.push([percentDecode(key), size, modified]);
        }
        const truncated = (xmlFirst(text, "IsTruncated") ?? "").trim().toLowerCase() === "true";
        token = xmlFirst(text, "NextContinuationToken")?.trim() ?? null;
        if (!truncated || !token) break;
      }
      return out;
    }
    return davList(this.dav!, this.timeoutMs);
  }
}

/* ------------------------------------------------------------------ 编排 */

function emitProgress(phase: string, done: number, total: number, message: string): void {
  emitToWindows(PROGRESS_EVENT, { phase, done, total, message });
}

/** DB 一致快照：WAL checkpoint + VACUUM INTO（目标不存在） */
function snapshotDatabase(dest: string): void {
  const db = openDb(dbPath());
  try {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* 无 WAL 等：忽略 */
    }
    rmSync(dest, { force: true });
    db.prepare("VACUUM INTO ?1").run(dest);
  } finally {
    db.close();
  }
}

function passphraseState(
  explicit: string | null | undefined,
  cfg: BackupConfig,
): { decision: ReturnType<typeof passphraseDecision>; stored: string } {
  const hasStored = cfg.passphrase.length > 0;
  let stored = "";
  let decryptable = false;
  if (hasStored) {
    const dec = decrypt(cfg.passphrase);
    if (dec.ok) {
      decryptable = dec.value.length > 0;
      if (decryptable) stored = dec.value;
    }
  }
  return {
    decision: passphraseDecision(explicit, cfg.rememberPassphrase, hasStored, decryptable),
    stored,
  };
}

/**
 * 备份用口令来源：记住的口令解不开时必须报错。
 * 旧实现返回 null 会让备份静默降级成不加密包，只有结果文案里一个
 * 「已加密」消失，用户很难察觉。
 */
function resolveBackupPassphrase(explicit: string | null | undefined, cfg: BackupConfig): string | null {
  const { decision, stored } = passphraseState(explicit, cfg);
  if (decision.kind === "explicit") return decision.passphrase;
  if (decision.kind === "stored") return stored;
  if (decision.kind === "stored-unreadable") {
    throw new Error(
      "已保存的备份口令无法解密（可能换了设备或系统钥匙串变化）。请重新输入备份口令，或关闭「记住口令」后再备份（不加密）。",
    );
  }
  return null;
}

/** 恢复用口令来源：未加密包不需要口令；加密包才要求显式输入或可解的口令 */
function resolveRestorePassphrase(
  explicit: string | null | undefined,
  cfg: BackupConfig,
  encrypted: boolean,
): string | null {
  const { decision, stored } = passphraseState(explicit, cfg);
  if (decision.kind === "explicit") return decision.passphrase;
  if (decision.kind === "stored") return stored;
  if (decision.kind === "stored-unreadable" && encrypted) {
    throw new Error("该备份已加密，且保存的口令无法解密，请重新输入恢复口令。");
  }
  return null;
}

/**
 * 远端判断加密位的前缀大小：header 含逐文件清单可到数 MB（数万文件 ≈ 7MB），
 * 逐级加大直到能解析。最后一级较大但只在用户手动刷新列表时发生。
 */
const REMOTE_HEADER_PROBE_BYTES = [8192, 256 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

async function listRemoteBackups(cfg: BackupConfig): Promise<RemoteBackup[]> {
  const channel = RemoteChannel.fromConfig(cfg, 600_000);
  const items = (await channel.list()).filter(([name]) => name.endsWith(".piabk"));
  items.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  const out: RemoteBackup[] = [];
  for (const [name, size, modified] of items) {
    let encrypted = false;
    for (const bytes of REMOTE_HEADER_PROBE_BYTES) {
      try {
        const prefix = await channel.getPrefix(name, bytes);
        encrypted = parseHeaderFromPrefix(prefix).encrypted === true;
        break;
      } catch (e) {
        // header 被前缀截断 → 加大范围重试；其它错误（404、网络）按未知处理
        if (!String(e instanceof Error ? e.message : e).includes("header 未完整")) break;
      }
    }
    out.push({ name, size, modified, encrypted });
  }
  return out;
}

/* ------------------------------------------------------------------ 启动期换入 */

/**
 * 换入发生在 initStore 之前（kv 还读不到），但任务产物可能已被用户改到别的
 * 盘：直接打开当前 state.db 读一次配置。坏库/无表回退 undefined（= 缺省根）。
 */
function taskWorkspaceRootBeforeStore(dataDir: string): string | undefined {
  const env = process.env.KOVA_TASK_WORKSPACE_DIR;
  if (env && env.trim().length > 0) return env.trim();
  try {
    const conn = openDb(join(dataDir, DB_FILE));
    try {
      const row = conn
        .prepare("SELECT value FROM kv WHERE key = 'task.workspace.root'")
        .get() as { value?: string } | undefined;
      const p = typeof row?.value === "string" ? row.value.trim() : "";
      return p.length > 0 ? p : undefined;
    } finally {
      conn.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * setup 阶段（store::init 之前）调用：存在待恢复标记时，把当前数据挪到
 * pre-restore-<ts>/，staging 内容就位，删除标记。返回 Some(摘要) = 已换入。
 */
export function applyPendingRestore(): string | null {
  const dataDir = appDataDir();
  const markerPath = join(dataDir, PENDING_RESTORE_FILE);
  if (!existsSync(markerPath)) return null;

  let marker: { staging?: string; device?: string; fileCount?: number; sections?: string[] } = {};
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    /* 坏标记按缺省处理 */
  }
  let stagingRel = `${RESTORE_STAGING_DIR}/content`;
  if (typeof marker.staging === "string" && marker.staging) stagingRel = marker.staging;
  if (stagingRel.includes("..")) throw new Error("待恢复标记包含非法路径");
  const staging = join(dataDir, stagingRel);
  if (!existsSync(staging)) {
    // staging 丢失（如用户手动清理）：删标记，按无恢复继续
    rmSync(markerPath, { force: true });
    return null;
  }

  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const aside = join(dataDir, `pre-restore-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
  mkdirSync(aside, { recursive: true });

  // 只换入 staging 里确实存在的条目：旧包没有新分区、用户关掉某个开关时，
  // 当前数据原地保留（旧实现无条件先移走，关掉「任务工作区」的备份恢复会清空产物）
  const localTaskRoot = taskWorkspaceRootBeforeStore(dataDir);
  const steps = planRestore(
    restoreTargets(dataDir, kovaHomeDir(), localTaskRoot),
    (target) => existsSync(target.dest),
    (target) => existsSync(join(staging, target.rel)),
  );

  // SQLite 的 WAL/SHM 不随包走：恢复旧库时必须把当前副本一并移开，否则新库会读到旧 WAL
  if (steps.some((step) => step.target.rel === DB_FILE && step.moveIn)) {
    for (const name of ["state.db-wal", "state.db-shm"]) {
      const current = join(dataDir, name);
      if (!existsSync(current)) continue;
      try {
        movePath(current, join(aside, name));
      } catch (e: any) {
        throw new Error(`移出旧 ${name}: ${e?.message ?? e}`);
      }
    }
  }

  for (const step of steps) {
    if (!step.moveIn) continue;
    const current = step.target.dest;
    if (step.moveAside) {
      const dest = join(aside, step.target.rel);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        movePath(current, dest);
      } catch (e: any) {
        throw new Error(`移出旧 ${step.target.rel}: ${e?.message ?? e}`);
      }
    }
    mkdirSync(dirname(current), { recursive: true });
    try {
      movePath(join(staging, step.target.rel), current);
    } catch (e: any) {
      throw new Error(`换入 ${step.target.rel}: ${e?.message ?? e}`);
    }
  }

  // 换机恢复：OS keychain 主密钥不随备份走，旧密文不可解——清空 credentials 引导重输；
  // 其它密文字段由 whenReady 里的 applyRestoreSanitize 探测后清理
  const restoredDb = join(dataDir, DB_FILE);
  let clearedCredentials = 0;
  if (existsSync(restoredDb)) {
    try {
      const conn = openDb(restoredDb);
      try {
        try {
          const row = conn.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n?: number } | undefined;
          clearedCredentials = row?.n ?? 0;
        } catch {
          /* 表不存在等 */
        }
        conn.prepare("DELETE FROM credentials").run();
        try {
          const row = conn.prepare("SELECT value FROM kv WHERE key = 'library.root'").get() as { value?: string } | undefined;
          const custom = typeof row?.value === "string" ? row.value.trim() : "";
          if (custom && custom !== join(dataDir, LIBRARY_DIR)) {
            logWarn(
              `[backup] restored library.root=${custom}; library files were restored to ${join(dataDir, LIBRARY_DIR)}`,
            );
          }
        } catch {
          /* 无 kv 表 */
        }
        // 任务产物：包里的配置（可能来自另一台机器）会覆盖本机 kv；实际换入
        // 用的是本机换入前的根，路径不一致时至少留一条可诊断的日志。
        try {
          const row = conn
            .prepare("SELECT value FROM kv WHERE key = 'task.workspace.root'")
            .get() as { value?: string } | undefined;
          const restored = typeof row?.value === "string" ? row.value.trim() : "";
          const local = localTaskRoot ?? join(dataDir, "task-workspace");
          if (restored && restored !== local) {
            logWarn(
              `[backup] restored task.workspace.root=${restored}; task artifacts were restored to ${local}`,
            );
          }
        } catch {
          /* 无 kv 表 */
        }
      } catch {
        /* 表不存在等 */
      }
      conn.close();
    } catch {
      /* 打不开：留给后续 initStore 报错 */
    }
  }

  try {
    rmSync(join(dataDir, stagingRel.split("/")[0] || RESTORE_STAGING_DIR), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    renameSync(markerPath, join(aside, "pending-restore.json.done"));
  } catch {
    /* ignore */
  }

  // 换机标记：whenReady（主密钥初始化之后）据此做密文探测，避免在换入阶段解密
  try {
    writeFileSync(
      join(dataDir, RESTORE_APPLIED_FILE),
      JSON.stringify(
        {
          appliedAt: new Date().toISOString(),
          device: marker.device ?? "",
          fileCount: marker.fileCount ?? 0,
          sections: Array.isArray(marker.sections) ? marker.sections : [],
          clearedCredentials,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    logWarn(`[backup] write ${RESTORE_APPLIED_FILE} failed: ${e instanceof Error ? e.message : e}`);
  }

  const summary = `device=${marker.device ?? "?"}, fileCount=${marker.fileCount ?? 0}, sections=${
    Array.isArray(marker.sections) && marker.sections.length > 0 ? marker.sections.join(",") : "core"
  }`;
  logInfo(`[backup] pending restore applied: ${summary}`);
  return summary;
}

/** 跨目录 rename；个别文件系统（EXDEV）退化为拷贝后删除 */
function movePath(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    cpSync(src, dest, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ 换机密文清理 */

interface RestoreAppliedMarker {
  appliedAt?: string;
  device?: string;
  fileCount?: number;
  sections?: string[];
  clearedCredentials?: number;
}

/**
 * 换机恢复后清理不可解密的密文字段：主密钥（master.key*）不随备份走，旧密文
 * 在新机器上只是垃圾。只在「刚换入 + 主密钥可用」时执行——钥匙串临时不可用
 * 时 initSecretCipher 会让 backend=unavailable，此时解密必然全失败，不能清理。
 */
export function applyRestoreSanitize(): string | null {
  const dataDir = appDataDir();
  const markerPath = join(dataDir, RESTORE_APPLIED_FILE);
  if (!existsSync(markerPath)) return null;

  let marker: RestoreAppliedMarker = {};
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    /* 坏标记按空处理 */
  }

  // 主密钥长期不可用（如换机后钥匙串一直解不开）时不再无限重试：
  // 超过 7 天就放弃探测，字段保留原值、由各消费方按「无法解密」降级
  const ageMs = marker.appliedAt ? Date.now() - Date.parse(marker.appliedAt) : NaN;
  if (Number.isFinite(ageMs) && ageMs > 7 * 24 * 60 * 60 * 1000) {
    try {
      rmSync(markerPath, { force: true });
    } catch {
      /* ignore */
    }
    logWarn("[backup] restore sanitize abandoned: marker older than 7 days");
    return null;
  }

  if (!isSecretCipherReady()) {
    logWarn("[backup] restore sanitize skipped: secret cipher unavailable (retry next start)");
    return null;
  }

  let clearedBackupSecrets = 0;
  let clearedRemoteToken = 0;
  let clearedProxyConfig = 0;
  let clearedSshPasswords = 0;
  let clearedImTokens = 0;
  let unreadableSecrets = 0;

  const unreadable = (value: unknown): boolean => {
    if (typeof value !== "string" || value.length === 0 || !isEncrypted(value)) return false;
    return !decrypt(value).ok;
  };

  // 备份通道配置：解不开就清空，设置页回到「未设置」；口令被清则同时关掉「记住口令」
  try {
    const raw = kvGet(CONFIG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      for (const field of ["s3SecretAccessKey", "davPassword", "passphrase"]) {
        if (unreadable(cfg[field])) {
          cfg[field] = "";
          changed = true;
          clearedBackupSecrets += 1;
          if (field === "passphrase") cfg.rememberPassphrase = false;
        }
      }
      if (changed) kvSet(CONFIG_KEY, JSON.stringify(cfg));
    }
  } catch {
    /* 坏配置留给设置页重建 */
  }

  // 远程网关 token：解不开就删，重新配对即可
  try {
    if (unreadable(kvGet("remote.token"))) {
      kvDelete("remote.token");
      clearedRemoteToken += 1;
    }
  } catch {
    /* ignore */
  }

  // 网络代理是本机出网配置：恢复包里指向回环/私网的自定义代理换机后通常
  // 不可达，回到「跟随系统」，避免所有模型请求打到一个不存在的本地端口。
  try {
    const raw = kvGet(NETWORK_PROXY_KV_KEY);
    if (raw) {
      const cfg = parseNetworkProxyConfig(raw);
      if (cfg.mode === "custom" && cfg.url) {
        const host = new URL(cfg.url).hostname;
        if (isLocalProxyHost(host)) {
          kvSet(
            NETWORK_PROXY_KV_KEY,
            serializeNetworkProxyConfig({ ...cfg, mode: "system", url: "" }),
          );
          clearedProxyConfig += 1;
        }
      }
    }
  } catch {
    /* 坏配置留给设置页重建 */
  }

  // SSH 主机密码：只摘掉密码字段，主机配置保留
  try {
    const raw = kvGet("ssh.hosts");
    if (raw) {
      const hosts = JSON.parse(raw) as Array<Record<string, unknown>>;
      let changed = false;
      if (Array.isArray(hosts)) {
        for (const host of hosts) {
          if (unreadable(host.passwordEnc)) {
            delete host.passwordEnc;
            changed = true;
            clearedSshPasswords += 1;
          }
        }
      }
      if (changed) kvSet("ssh.hosts", JSON.stringify(hosts));
    }
  } catch {
    /* ignore */
  }

  // IM 微信通道 token（kv im.wechat.token.<channelId>）
  try {
    const raw = kvGet("im_channels");
    const channels = raw ? (JSON.parse(raw) as Array<{ id?: unknown }>) : [];
    if (Array.isArray(channels)) {
      for (const channel of channels) {
        const id = typeof channel?.id === "string" ? channel.id : "";
        if (!id) continue;
        const key = `im.wechat.token.${id}`;
        if (unreadable(kvGet(key))) {
          kvDelete(key);
          clearedImTokens += 1;
        }
      }
    }
  } catch {
    /* ignore */
  }

  // secrets 表保留行：设置页已用 readable:false 标记，用户能看到需要重填哪些
  try {
    const rows = getDb().prepare("SELECT value FROM secrets").all() as Array<{ value?: string }>;
    unreadableSecrets = rows.filter((row) => unreadable(row.value)).length;
  } catch {
    /* 表不存在等 */
  }

  try {
    rmSync(markerPath, { force: true });
  } catch {
    /* ignore */
  }

  const summary = `device=${marker.device || "?"}, credentials=${marker.clearedCredentials ?? 0}, backupSecrets=${clearedBackupSecrets}, remoteToken=${clearedRemoteToken}, proxy=${clearedProxyConfig}, sshPasswords=${clearedSshPasswords}, imTokens=${clearedImTokens}, unreadableSecrets=${unreadableSecrets}`;
  logInfo(`[backup] restore sanitize: ${summary}`);
  return summary;
}

/* ------------------------------------------------------------------ 命令注册 */

export function setupBackupCommands(register: (name: string, fn: (args: any) => any) => void): void {
  register("backup_config_get", () => configView(loadConfig()));

  register("backup_config_set", (a) => {
    const cfg = a?.config as BackupConfig;
    if (!["off", "s3", "webdav"].includes(cfg?.provider)) {
      throw new Error(`未知的备份通道: ${cfg?.provider}`);
    }
    const merged = mergeConfig(loadConfig(), { ...defaultConfig(), ...cfg });
    saveConfig(merged);
    return configView(merged);
  });

  register("backup_test", async () => {
    const cfg = loadConfig();
    if (cfg.provider === "s3") {
      const channel = RemoteChannel.fromConfig(cfg, 20_000);
      await channel.list(); // 等价 list_objects：连通性与签名一并验证
      return "S3 连接成功";
    }
    if (cfg.provider === "webdav") {
      const dav = davFrom(cfg);
      await davMkcolDeep(dav, 20_000);
      const probe = `pi-backup-probe-${randomUUID()}.txt`;
      const channel = RemoteChannel.fromConfig(cfg, 20_000);
      await channel.put(probe, Buffer.from("probe", "utf8"));
      await channel.delete(probe);
      await channel.list();
      return "WebDAV 连接成功（已验证可写入）";
    }
    throw new Error(`请先选择备份通道（当前: ${cfg.provider}）`);
  });

  register("backup_run", async (a) => {
    // 产物目录正在搬移时打包会读到半成品：让用户等迁移完成（通常在秒级）
    if (isTaskWorkspaceMigrating()) throw new Error("任务产物正在迁移，请迁移完成后再备份");
    const cfg = loadConfig();
    const remote = a?.target === "remote" ? true : a?.target === "local" ? false : null;
    if (remote === null) throw new Error(`未知备份目标: ${a?.target}`);
    if (remote && cfg.provider === "off") throw new Error("请先在设置中选择备份通道（S3 / WebDAV）");
    if (remote && cfg.provider === "webdav") {
      await davMkcolDeep(davFrom(cfg), 20_000);
    }

    // 口令最先解析：记住的口令失效时要直接报错，不能先做完 DB 快照再留下一地临时文件
    const pass = resolveBackupPassphrase(typeof a?.passphrase === "string" ? a.passphrase : null, cfg);

    const dataDir = appDataDir();
    emitProgress("db", 0, 1, "生成数据库快照…");
    const runTmp = join(tmpdir(), `piabk-run-${randomUUID()}`);
    mkdirSync(runTmp, { recursive: true });
    let envelopeDir: string | null = null;
    try {
      const dbSnapshot = join(runTmp, "state.db");
      snapshotDatabase(dbSnapshot);

      emitProgress("pack", 0, 1, "打包备份…");
      const device = cfg.deviceName.trim() || "desktop";
      const { envelope, header } = packBackup(
        dbSnapshot,
        dataDir,
        {
          includeWorkspace: cfg.includeWorkspace,
          includeLibrary: cfg.includeLibrary,
          includePersonal: cfg.includePersonal,
          includeSkillsPlugins: cfg.includeSkillsPlugins,
          includeCheckpoints: cfg.includeCheckpoints,
        },
        pass,
        device,
        app.getVersion(),
        (done, total, msg) => emitProgress("pack", done, total, msg),
      );
      envelopeDir = dirname(envelope);
      rmSync(dbSnapshot, { force: true });

      const size = statSync(envelope).size;
      const result = {
        fileName: envelope.split(/[\\/]/).pop() ?? "",
        size,
        fileCount: header.files.length,
        encrypted: header.encrypted,
        remote,
        device: header.device,
        createdAt: header.createdAt,
      };

      if (remote) {
        const channel = RemoteChannel.fromConfig(cfg, 600_000);
        emitProgress("upload", 0, size, "上传备份…");
        await channel.put(result.fileName, readFileSync(envelope));
        emitProgress("upload", size, size, "上传完成");
      } else {
        const dest = typeof a?.localPath === "string" && a.localPath ? a.localPath : null;
        if (!dest) throw new Error("缺少本地保存路径");
        emitProgress("save", 0, size, "写入本地文件…");
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(envelope, dest);
        emitProgress("save", size, size, "写入完成");
      }
      return result;
    } finally {
      // 任何一步失败都不留 DB 快照与信封临时目录（两者都含完整数据/密文）
      if (envelopeDir) rmSync(envelopeDir, { recursive: true, force: true });
      rmSync(runTmp, { recursive: true, force: true });
    }
  });

  register("backup_list_remote", async () => listRemoteBackups(loadConfig()));

  register("backup_download", async (a) => {
    const cfg = loadConfig();
    const name = String(a?.name ?? "");
    if (name.includes("/") || name.includes("..")) throw new Error("非法的备份文件名");
    const channel = RemoteChannel.fromConfig(cfg, 1_800_000);
    emitProgress("download", 0, 1, `下载 ${name}…`);
    try {
      const n = await channel.getToFile(name, String(a?.savePath ?? ""));
      emitProgress("download", 1, 1, "下载完成");
      return n;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      throw new Error(msg.includes("返回 HTTP 404") ? `${msg}\n远端备份可能已被删除，请刷新列表` : msg);
    }
  });

  register("backup_delete_remote", async (a) => {
    const cfg = loadConfig();
    const name = String(a?.name ?? "");
    if (name.includes("/") || name.includes("..")) throw new Error("非法的备份文件名");
    const channel = RemoteChannel.fromConfig(cfg, 60_000);
    const existed = await channel.delete(name);
    return existed ? "已删除" : "远端已不存在，已视为删除";
  });

  register("backup_restore", async (a) => {
    if (isTaskWorkspaceMigrating()) throw new Error("任务产物正在迁移，请迁移完成后再恢复");
    const cfg = loadConfig();
    const source = a?.source ?? {};
    const dataDir = appDataDir();
    const stagingRoot = join(dataDir, RESTORE_STAGING_DIR);
    const stagingContent = join(stagingRoot, "content");
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(stagingContent, { recursive: true });

    const explicitPass = typeof source.passphrase === "string" ? source.passphrase : null;
    let staged = false;
    try {
      const envelopeTmp = join(stagingRoot, "source.piabk");
      if (typeof source.remoteName === "string" && source.remoteName) {
        const name = source.remoteName;
        if (name.includes("/") || name.includes("..")) throw new Error("非法的备份文件名");
        const channel = RemoteChannel.fromConfig(cfg, 1_800_000);
        emitProgress("download", 0, 1, `下载 ${name}…`);
        try {
          await channel.getToFile(name, envelopeTmp);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          throw new Error(msg.includes("返回 HTTP 404") ? `${msg}\n远端备份可能已被删除，请刷新列表` : msg);
        }
        emitProgress("download", 1, 1, "下载完成");
      } else if (typeof source.localPath === "string" && source.localPath) {
        copyFileSync(source.localPath, envelopeTmp);
      } else {
        throw new Error("缺少恢复来源");
      }

      emitProgress("unpack", 0, 1, "解包与校验…");
      // 口令在解出 header 之后由回调决定：未加密包不受「记住的口令已失效」影响，
      // header 大小也不再受固定前缀限制（逐文件清单可达数 MB）
      const header = unpackBackup(
        envelopeTmp,
        stagingContent,
        (h) => resolveRestorePassphrase(explicitPass, cfg, h.encrypted),
        throttleProgress((done, total, msg) => emitProgress("unpack", done, total, msg)),
      );
      rmSync(envelopeTmp, { force: true });
      if (!existsSync(join(stagingContent, DB_FILE))) {
        throw new Error("备份包缺少 state.db，无法恢复");
      }

      // 资料库恢复固定写缺省位置：包里 kv 的 library.root 指向别处时提前告知用户
      let libraryRootHint: string | null = null;
      if (existsSync(join(stagingContent, LIBRARY_DIR))) {
        try {
          const conn = openDb(join(stagingContent, DB_FILE));
          try {
            const row = conn
              .prepare("SELECT value FROM kv WHERE key = 'library.root'")
              .get() as { value?: string } | undefined;
            const custom = typeof row?.value === "string" ? row.value.trim() : "";
            if (custom && custom !== join(dataDir, LIBRARY_DIR)) libraryRootHint = custom;
          } finally {
            conn.close();
          }
        } catch {
          /* 无 kv 表等 */
        }
      }

      // 校验通过才写标记
      const marker = {
        staging: `${RESTORE_STAGING_DIR}/content`,
        createdAt: header.createdAt,
        device: header.device,
        fileCount: header.files.length,
        sections: header.sections ?? [],
      };
      writeFileSync(join(dataDir, PENDING_RESTORE_FILE), JSON.stringify(marker, null, 2));
      staged = true;
      return { header: headerSummary(header), needsRestart: true, libraryRootHint };
    } finally {
      // 失败不留半份 staging（远端恢复时里面还有整个下载下来的备份包）
      if (!staged) rmSync(stagingRoot, { recursive: true, force: true });
    }
  });

  register("backup_peek_header", async (a) => {
    const path = String(a?.path ?? "");
    try {
      // header 含逐文件清单、体积随文件数增长：readEnvelopeHeader 增量读到行尾
      return headerSummary(readEnvelopeHeader(path));
    } catch (e: any) {
      throw new Error(`打开 ${path}: ${e?.message ?? e}`);
    }
  });

  register("backup_restart_app", async () => {
    // 先收尸再重启：app.exit 不走 before-quit，sidecar/工具进程会成孤儿
    try {
      const { cancelAllTools } = await import("./tool-exec");
      cancelAllTools();
    } catch {
      /* ignore */
    }
    try {
      const pi = await import("./pi-agent");
      await pi.killOnExit();
    } catch {
      /* ignore */
    }
    app.relaunch();
    app.exit(0);
    return null;
  });
}
