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
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { app } from "electron";
import { appDataDir, dbPath } from "./paths";
import { kvGet, kvSet } from "./store";
import { emitToWindows } from "./ipc";
import { logInfo } from "./logging";
import { decrypt, encrypt, PREFIX as SECRET_PREFIX } from "./secret";
import { openDb } from "./db";

const MAGIC = Buffer.from("PIABK1\n", "utf8");
const FORMAT_VERSION = 1;
const KDF_ITERATIONS = 600_000;
const CONFIG_KEY = "backup.config.v1";
const PENDING_RESTORE_FILE = "pending-restore.json";
const RESTORE_STAGING_DIR = "restore-staging";
const PROGRESS_EVENT = "backup:progress";
const SESSIONS_DIR = "sessions";
const TASK_WORKSPACE_DIR = "task-workspace";
const DB_FILE = "state.db";
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

interface KdfParams {
  algo: string;
  salt: string;
  iterations: number;
  nonce: string;
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

interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}

interface BackupHeader {
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  device: string;
  appVersion: string;
  encrypted: boolean;
  kdf?: KdfParams;
  files: FileEntry[];
  payloadSha256: string;
  payloadSize: number;
}

interface BackupHeaderSummary {
  createdAt: string;
  device: string;
  appVersion: string;
  encrypted: boolean;
  fileCount: number;
}

function headerSummary(h: BackupHeader): BackupHeaderSummary {
  return {
    createdAt: h.createdAt,
    device: h.device,
    appVersion: h.appVersion,
    encrypted: h.encrypted,
    fileCount: (h.files ?? []).length,
  };
}

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

function collectDirFiles(dir: string, relBase: string, out: [string, string][]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const rel = `${relBase}/${name}`;
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) collectDirFiles(path, rel, out);
    else out.push([path, rel]);
  }
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

/**
 * 打包备份信封（对齐 pack_backup）：返回（信封路径，header）。
 * 逐文件先快照拷贝再哈希再入包——sessions JSONL 由 sidecar 流式追加，
 * 直接对原文件"先哈希后打包"会在两次读取间被追加，恢复时校验失败。
 */
export function packBackup(
  dbSnapshot: string,
  dataDir: string,
  includeWorkspace: boolean,
  passphrase: string | null,
  device: string,
  appVersion: string,
  progress: Progress,
): { envelope: string; header: BackupHeader } {
  const entries: [string, string][] = [];
  entries.push([dbSnapshot, DB_FILE]);
  collectDirFiles(join(dataDir, SESSIONS_DIR), SESSIONS_DIR, entries);
  if (includeWorkspace) collectDirFiles(join(dataDir, TASK_WORKSPACE_DIR), TASK_WORKSPACE_DIR, entries);
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const tmp = join(tmpdir(), `piabk-pack-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  const tarPath = join(tmp, "payload.tar.gz");
  const snapshotDir = join(tmp, "snapshot");

  const total = entries.length;
  const fileEntries: FileEntry[] = [];
  const rels: string[] = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const [abs, rel] = entries[idx];
    const snap = join(snapshotDir, rel);
    mkdirSync(dirname(snap), { recursive: true });
    copyFileSync(abs, snap);
    const { size, hash } = sha256File(snap);
    fileEntries.push({ path: rel, size, sha256: hash });
    rels.push(rel);
    progress(idx + 1, total, rel);
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

  const header: BackupHeader = {
    formatVersion: FORMAT_VERSION,
    schemaVersion: 1,
    createdAt: localStamp(),
    device,
    appVersion,
    encrypted: kdf !== undefined,
    ...(kdf ? { kdf } : {}),
    payloadSha256: sha256Hex(payload),
    payloadSize: payload.length,
    files: fileEntries,
  };
  const fileName = `pi-backup-${fileStamp()}.piabk`;
  const envelope = join(tmp, fileName);
  const envelopeBytes: Uint8Array = Buffer.concat([
    MAGIC,
    Buffer.from(JSON.stringify(header), "utf8"),
    Buffer.from("\n", "utf8"),
    payload,
  ]);
  writeFileSync(envelope, envelopeBytes);
  return { envelope, header };
}

/** 从信封前若干字节解析 header（远端列表/本地 peek 用） */
export function parseHeaderFromPrefix(prefix: Buffer): BackupHeader {
  const first = prefix.indexOf(0x0a);
  if (first < 0) throw new Error("不是有效的备份包（缺 magic 换行）");
  const magic = prefix.subarray(0, first).toString("utf8");
  if (magic !== MAGIC.subarray(0, MAGIC.length - 1).toString("utf8")) {
    throw new Error("不是有效的备份包（magic 不匹配）");
  }
  const rest = prefix.subarray(first + 1);
  const second = rest.indexOf(0x0a);
  if (second < 0) throw new Error("不是有效的备份包（header 未完整）");
  try {
    return JSON.parse(rest.subarray(0, second).toString("utf8"));
  } catch (e: any) {
    throw new Error(`解析 header 失败: ${e?.message ?? e}`);
  }
}

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

/** 解包信封到 destDir：逐文件 sha256 校验 + 修剪残行 */
export function unpackBackup(
  envelope: string,
  destDir: string,
  passphrase: string | null,
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

/** 新值空串 = 保留旧值；enc:v1: 前缀 = 原样；否则加密落库 */
function mergeSecret(oldV: string, newV: string): string {
  if (!newV || newV.length === 0) return oldV;
  if (newV.startsWith(SECRET_PREFIX)) return newV;
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

function resolvePassphrase(explicit: string | null | undefined, cfg: BackupConfig): string | null {
  if (explicit && explicit.length > 0) return explicit;
  if (cfg.rememberPassphrase && cfg.passphrase.length > 0) {
    const dec = decrypt(cfg.passphrase);
    return dec.ok && dec.value.length > 0 ? dec.value : null;
  }
  return null;
}

async function listRemoteBackups(cfg: BackupConfig): Promise<RemoteBackup[]> {
  const channel = RemoteChannel.fromConfig(cfg, 600_000);
  const items = (await channel.list()).filter(([name]) => name.endsWith(".piabk"));
  items.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  const out: RemoteBackup[] = [];
  for (const [name, size, modified] of items) {
    let encrypted = false;
    try {
      const prefix = await channel.getPrefix(name, 4096);
      encrypted = parseHeaderFromPrefix(prefix).encrypted === true;
    } catch {
      encrypted = false;
    }
    out.push({ name, size, modified, encrypted });
  }
  return out;
}

/* ------------------------------------------------------------------ 启动期换入 */

/**
 * setup 阶段（store::init 之前）调用：存在待恢复标记时，把当前数据挪到
 * pre-restore-<ts>/，staging 内容就位，删除标记。返回 Some(摘要) = 已换入。
 */
export function applyPendingRestore(): string | null {
  const dataDir = appDataDir();
  const markerPath = join(dataDir, PENDING_RESTORE_FILE);
  if (!existsSync(markerPath)) return null;
  const markerRaw = (() => {
    try {
      return readFileSync(markerPath, "utf8");
    } catch {
      return "";
    }
  })();
  let stagingRel = `${RESTORE_STAGING_DIR}/content`;
  try {
    const v = JSON.parse(markerRaw);
    if (typeof v?.staging === "string" && v.staging) stagingRel = v.staging;
  } catch {
    /* 缺省 */
  }
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

  const candidates = [DB_FILE, "state.db-wal", "state.db-shm", SESSIONS_DIR, TASK_WORKSPACE_DIR];
  for (const name of candidates) {
    const current = join(dataDir, name);
    if (existsSync(current)) {
      try {
        renameSync(current, join(aside, name));
      } catch (e: any) {
        throw new Error(`移出旧 ${name}: ${e?.message ?? e}`);
      }
    }
    const staged = join(staging, name);
    if (existsSync(staged)) {
      try {
        renameSync(staged, current);
      } catch (e: any) {
        throw new Error(`换入 ${name}: ${e?.message ?? e}`);
      }
    }
  }

  // 换机恢复：OS keychain 主密钥不随备份走，旧密文不可解——清空 credentials 引导重输
  const restoredDb = join(dataDir, DB_FILE);
  if (existsSync(restoredDb)) {
    try {
      const conn = openDb(restoredDb);
      try {
        conn.prepare("DELETE FROM credentials").run();
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
  let summary = "ok";
  try {
    const v = JSON.parse(markerRaw);
    summary = `device=${v?.device ?? "?"}, fileCount=${v?.fileCount ?? 0}`;
  } catch {
    /* 缺省 */
  }
  logInfo(`[backup] pending restore applied: ${summary}`);
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
    const cfg = loadConfig();
    const remote = a?.target === "remote" ? true : a?.target === "local" ? false : null;
    if (remote === null) throw new Error(`未知备份目标: ${a?.target}`);
    if (remote && cfg.provider === "off") throw new Error("请先在设置中选择备份通道（S3 / WebDAV）");
    if (remote && cfg.provider === "webdav") {
      await davMkcolDeep(davFrom(cfg), 20_000);
    }

    const dataDir = appDataDir();
    emitProgress("db", 0, 1, "生成数据库快照…");
    const runTmp = join(tmpdir(), `piabk-run-${randomUUID()}`);
    mkdirSync(runTmp, { recursive: true });
    const dbSnapshot = join(runTmp, "state.db");
    snapshotDatabase(dbSnapshot);

    const pass = resolvePassphrase(typeof a?.passphrase === "string" ? a.passphrase : null, cfg);
    emitProgress("pack", 0, 1, "打包备份…");
    const device = cfg.deviceName.trim() || "desktop";
    const { envelope, header } = packBackup(
      dbSnapshot,
      dataDir,
      cfg.includeWorkspace,
      pass,
      device,
      app.getVersion(),
      (done, total, msg) => emitProgress("pack", done, total, msg),
    );
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
    rmSync(dirname(envelope), { recursive: true, force: true });
    rmSync(runTmp, { recursive: true, force: true });
    return result;
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
    const cfg = loadConfig();
    const source = a?.source ?? {};
    const dataDir = appDataDir();
    const stagingRoot = join(dataDir, RESTORE_STAGING_DIR);
    const stagingContent = join(stagingRoot, "content");
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(stagingContent, { recursive: true });

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
    const pass = resolvePassphrase(typeof source.passphrase === "string" ? source.passphrase : null, cfg);
    let header: BackupHeader;
    try {
      header = unpackBackup(envelopeTmp, stagingContent, pass, (done, total, msg) => emitProgress("unpack", done, total, msg));
    } catch (e) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw e;
    }
    rmSync(envelopeTmp, { force: true });

    // 校验通过才写标记
    const marker = {
      staging: `${RESTORE_STAGING_DIR}/content`,
      createdAt: header.createdAt,
      device: header.device,
      fileCount: header.files.length,
    };
    writeFileSync(join(dataDir, PENDING_RESTORE_FILE), JSON.stringify(marker, null, 2));
    return { header: headerSummary(header), needsRestart: true };
  });

  register("backup_peek_header", async (a) => {
    const path = String(a?.path ?? "");
    let prefix: Buffer;
    try {
      prefix = readFileSync(path).subarray(0, 8192);
    } catch (e: any) {
      throw new Error(`打开 ${path}: ${e?.message ?? e}`);
    }
    return headerSummary(parseHeaderFromPrefix(prefix));
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
