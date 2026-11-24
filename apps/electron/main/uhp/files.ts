/**
 * UHP files and artifacts.
 *
 * Uploads are stored under <appData>/uhp/files/<file_id>/; produced files are
 * copied under <appData>/uhp/artifacts/<sessionId>/<file_id>/. Both roots are
 * containment-checked before every read to block traversal and symlink escape.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { newFileId } from "uhp-protocol";
import type { UhpFile, UhpSessionFile } from "uhp-protocol";
import { appDataDir } from "../paths";
import { listFilesForSession, listFiles, loadFile, saveFile, deleteFile } from "./store";
import type { UhpFileRecord } from "./types";
import { zipStore, type ZipEntry } from "./zip";

export const UHP_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Bound artifact copying per session so a task cannot fill the disk. */
export const UHP_MAX_ARTIFACTS_PER_SESSION = 500;
export const UHP_MAX_ARTIFACT_BYTES_PER_SESSION = 256 * 1024 * 1024;
/** Zip archives are built in memory; keep the ceiling well below 4 GiB. */
export const UHP_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export class UhpInputFileError extends Error {
  readonly fileId: string;
  constructor(fileId: string) {
    super(`Uploaded file "${fileId}" was not found.`);
    this.name = "UhpInputFileError";
    this.fileId = fileId;
  }
}

export class UhpArchiveTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`Artifact archive is too large (${bytes} bytes).`);
    this.name = "UhpArchiveTooLargeError";
    this.bytes = bytes;
  }
}

export function filesRoot(): string {
  return join(appDataDir(), "uhp", "files");
}

export function artifactsRoot(): string {
  return join(appDataDir(), "uhp", "artifacts");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Session ids are opaque; keep them from becoming path segments like `../`. */
function safeSessionSegment(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "_");
  return safe.slice(0, 128) || "session";
}

function sanitizeFilename(input: string | undefined): string {
  const base = basename((input ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f]/g, "").trim();
  if (!base || base === "." || base === "..") return "file";
  return base.slice(0, 160);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRealpath(path: string, root: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(path);
    return isWithin(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/* ------------------------------ multipart ------------------------------ */

export { parseMultipart, type MultipartPart } from "./multipart";

/* ------------------------------ uploads ------------------------------ */

export function saveUpload(input: {
  filename?: string;
  contentType?: string;
  bytes: Buffer;
}): UhpFile {
  if (input.bytes.length > UHP_MAX_UPLOAD_BYTES) {
    throw new Error("file_too_large");
  }
  const filename = sanitizeFilename(input.filename);
  const id = newFileId();
  const dir = join(filesRoot(), id);
  ensureDir(dir);
  const path = join(dir, filename);
  try {
    writeFileSync(path, input.bytes);
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
  const record: UhpFileRecord = {
    id,
    filename,
    bytes: input.bytes.length,
    createdAt: Math.floor(Date.now() / 1000),
    path,
    source: "upload",
  };
  try {
    saveFile(record);
  } catch (error) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
  return {
    id: record.id,
    object: "file",
    filename: record.filename,
    bytes: record.bytes,
    created_at: record.createdAt,
  };
}

export function readUpload(id: string): { record: UhpFileRecord; bytes: Buffer } | null {
  const direct = loadFile(id);
  if (!direct || direct.source !== "upload") return null;
  const real = safeRealpath(direct.path, filesRoot());
  if (!real) return null;
  try {
    return { record: direct, bytes: readFileSync(real) };
  } catch {
    return null;
  }
}

export function mimeTypeOf(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "pdf":
      return "application/pdf";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

/* ------------------------------ input files ------------------------------ */

type FileInputPart = Record<string, unknown> & {
  type?: string;
  file_id?: string;
  filename?: string;
  file_data?: string;
  mime_type?: string;
};

/**
 * Resolve `file_id` references in a Responses input array into inline data.
 * Returns a cloned request; the caller's object is never mutated.
 */
export function resolveInputFileIds<T extends Record<string, unknown>>(request: T): T {
  const input = request.input;
  if (!Array.isArray(input)) return request;
  const next = input.map((item) => {
    if (!item || typeof item !== "object") return item;
    const message = item as { content?: unknown };
    if (!Array.isArray(message.content)) return item;
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = part as FileInputPart;
      if (p.type !== "input_file" && p.type !== "input_image") return part;
      // Never trust a client-supplied `path`. The server adds one only after
      // resolving a file_id it owns; otherwise `file_id: "nope", path:
      // "/etc/passwd"` would make the harness read an arbitrary local file.
      const { path: _clientPath, ...clean } = p as FileInputPart & { path?: unknown };
      if (!p.file_id) return clean;
      const file = readUpload(p.file_id);
      if (!file) throw new UhpInputFileError(p.file_id);
      const mime = p.mime_type ?? mimeTypeOf(file.record.filename);
      // Hand the sidecar a local path instead of base64. Path mode keeps
      // documents up to 20 MiB and avoids doubling memory on the stdin frame.
      return {
        ...clean,
        filename: p.filename ?? file.record.filename,
        mime_type: mime,
        path: file.record.path,
      };
    });
    return { ...(item as Record<string, unknown>), content };
  });
  return { ...request, input: next };
}

/* ------------------------------ artifacts ------------------------------ */

function pathFromToolArguments(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const value = args as Record<string, unknown>;
  if (name === "write" || name === "edit") {
    for (const key of ["path", "file_path", "filePath"]) {
      if (typeof value[key] === "string" && value[key]) return value[key] as string;
    }
  }
  return null;
}

const MAX_SCAN_FILES = 2_000;
const MAX_SCAN_DEPTH = 6;
const MAX_SCANNED_FILE_BYTES = 50 * 1024 * 1024;
/** Never copy likely secret material into a downloadable artifact. */
const SENSITIVE_FILE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519|ecdsa)|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const SCAN_SKIP_DIRS = new Set([
  ".git",
  ".ssh",
  ".kova",
  ".next",
  ".aws",
  ".azure",
  ".cache",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".local",
  ".npm",
  ".pnpm-store",
  ".turbo",
  ".yarn",
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "logs",
  "tmp",
  "temp",
]);

function isSensitiveArtifactPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return true;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const filename = parts[parts.length - 1] ?? "";
  if (SENSITIVE_FILE.test(filename)) return true;
  return parts.slice(0, -1).some((segment) => SCAN_SKIP_DIRS.has(segment.toLowerCase()));
}

type ArtifactBudget = { files: number; bytes: number };

function artifactBudget(sessionId: string): ArtifactBudget {
  const existing = listFilesForSession(sessionId);
  return {
    files: existing.length,
    bytes: existing.reduce((sum, record) => sum + record.bytes, 0),
  };
}

function copyArtifactFromSource(input: {
  sessionId: string;
  responseId?: string;
  sourcePath: string;
  knownPaths: Set<string>;
  budget: ArtifactBudget;
}): UhpFileRecord | null {
  const real = safeRealpath(input.sourcePath, dirname(input.sourcePath));
  // safeRealpath above only verifies the file is readable; the caller must
  // already have established workspace containment.
  if (!real || input.knownPaths.has(real)) return null;
  let size = 0;
  try {
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > MAX_SCANNED_FILE_BYTES) return null;
    size = stat.size;
  } catch {
    return null;
  }
  if (
    input.budget.files >= UHP_MAX_ARTIFACTS_PER_SESSION ||
    input.budget.bytes + size > UHP_MAX_ARTIFACT_BYTES_PER_SESSION
  ) {
    return null;
  }
  const id = newFileId();
  const filename = sanitizeFilename(real);
  const dir = join(artifactsRoot(), safeSessionSegment(input.sessionId), id);
  ensureDir(dir);
  const target = join(dir, filename);
  try {
    copyFileSync(real, target);
  } catch {
    return null;
  }
  const record: UhpFileRecord = {
    id,
    filename,
    bytes: size,
    createdAt: Math.floor(Date.now() / 1000),
    path: target,
    sourcePath: real,
    sessionId: input.sessionId,
    ...(input.responseId ? { responseId: input.responseId } : {}),
    containerId: `cntr_${input.sessionId}`,
    source: "artifact",
  };
  try {
    saveFile(record);
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
  input.knownPaths.add(real);
  input.budget.files += 1;
  input.budget.bytes += size;
  return record;
}

/** Copy files created/edited by write/edit tools into the session artifact root. */
export function recordArtifactsFromOutput(input: {
  sessionId: string;
  responseId?: string;
  cwd: string;
  output: unknown[];
}): UhpFileRecord[] {
  const existing = listFilesForSession(input.sessionId);
  const knownPaths = new Set(existing.map((row) => row.sourcePath ?? row.path));
  const budget = artifactBudget(input.sessionId);
  const records: UhpFileRecord[] = [];

  for (const item of input.output) {
    if (!item || typeof item !== "object") continue;
    const value = item as { type?: string; name?: string; arguments?: string; status?: string };
    if (value.type !== "function_call" || typeof value.name !== "string") continue;
    // An in-progress/failed call may still carry arguments but did not produce
    // a file; only completed calls are evidence of an artifact.
    if (value.status !== undefined && value.status !== "completed") continue;
    let parsed: unknown = null;
    try {
      parsed = value.arguments ? JSON.parse(value.arguments) : null;
    } catch {
      parsed = null;
    }
    const rawPath = pathFromToolArguments(value.name, parsed);
    if (!rawPath) continue;
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(input.cwd, rawPath);
    if (!isWithin(input.cwd, candidate)) continue;
    if (!existsSync(candidate)) continue;
    if (isSensitiveArtifactPath(input.cwd, candidate)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    const real = safeRealpath(candidate, input.cwd);
    if (!real) continue;
    const record = copyArtifactFromSource({
      sessionId: input.sessionId,
      responseId: input.responseId,
      sourcePath: real,
      knownPaths,
      budget,
    });
    if (record) records.push(record);
  }
  return records;
}

/**
 * Fallback artifact capture for harnesses/tools that create files outside
 * write/edit (bash redirection, build scripts). Bounded BFS over the workspace;
 * only files whose mtime is at/after the task start are copied.
 */
export function recordRecentWorkspaceArtifacts(input: {
  sessionId: string;
  responseId?: string;
  cwd: string;
  sinceMs: number;
}): UhpFileRecord[] {
  const existing = listFilesForSession(input.sessionId);
  const knownPaths = new Set(existing.map((row) => row.sourcePath ?? row.path));
  const budget = artifactBudget(input.sessionId);
  const records: UhpFileRecord[] = [];
  let visited = 0;
  const threshold = input.sinceMs - 1_000;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_FILES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_SCAN_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitiveArtifactPath(input.cwd, path)) continue;
      visited += 1;
      try {
        const stat = statSync(path);
        if (stat.mtimeMs < threshold) continue;
      } catch {
        continue;
      }
      const real = safeRealpath(path, input.cwd);
      if (!real) continue;
      const record = copyArtifactFromSource({
        sessionId: input.sessionId,
        responseId: input.responseId,
        sourcePath: real,
        knownPaths,
        budget,
      });
      if (record) records.push(record);
    }
  };

  walk(input.cwd, 0);
  return records;
}

export function fileToWire(record: UhpFileRecord): UhpSessionFile {
  return {
    id: record.id,
    container_id:
      record.containerId ?? `cntr_${record.sessionId ?? "unknown"}`,
    filename: record.filename,
    bytes: record.bytes,
    created_at: record.createdAt,
  };
}

export function listSessionArtifacts(sessionId: string): UhpSessionFile[] {
  return listFilesForSession(sessionId)
    .filter((record) => record.source === "artifact")
    .map(fileToWire);
}

export function archiveSessionArtifacts(sessionId: string): Buffer {
  const records = listFilesForSession(sessionId).filter((record) => record.source === "artifact");
  const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  if (totalBytes > UHP_MAX_ARCHIVE_BYTES) {
    throw new UhpArchiveTooLargeError(totalBytes);
  }
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  for (const record of records) {
    let name = record.filename;
    let index = 1;
    while (used.has(name)) {
      const dot = record.filename.lastIndexOf(".");
      name =
        dot > 0
          ? `${record.filename.slice(0, dot)}-${index}${record.filename.slice(dot)}`
          : `${record.filename}-${index}`;
      index += 1;
    }
    used.add(name);
    // Stored paths are server-generated, but validate again on read so a
    // corrupted record can never exfiltrate an arbitrary file through a zip.
    const real = safeRealpath(record.path, artifactsRoot());
    if (!real) continue;
    try {
      entries.push({ name, data: readFileSync(real) });
    } catch {
      /* missing file: skip */
    }
  }
  return zipStore(entries);
}

export function readContainerFile(
  containerId: string,
  fileId: string,
): { record: UhpFileRecord; bytes: Buffer } | null {
  const record = loadFile(fileId);
  if (!record) return null;
  if (record.containerId !== containerId) return null;
  const root = record.source === "artifact" ? artifactsRoot() : filesRoot();
  const real = safeRealpath(record.path, root);
  if (!real) return null;
  try {
    return { record, bytes: readFileSync(real) };
  } catch {
    return null;
  }
}

/** Remove uploads older than the retention window; artifacts follow their session. */
export function pruneOldUploads(retentionDays: number, now = Date.now()): number {
  const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const record of listFiles()) {
    if (record.source !== "upload") continue;
    if (record.createdAt * 1000 >= cutoff) continue;
    // Only remove a directory that resolves inside the upload root. A
    // corrupted record must not turn retention into arbitrary rm -rf.
    const dir = safeRealpath(dirname(record.path), filesRoot());
    if (dir) {
      // Never recursively remove the upload root itself, even if a corrupted
      // record points at a file directly under it.
      const rel = relative(filesRoot(), dir);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* missing file: still drop the record */
        }
      }
    }
    deleteFile(record.id);
    removed += 1;
  }
  return removed;
}

export function deleteSessionArtifacts(sessionId: string): void {
  for (const record of listFilesForSession(sessionId)) {
    const root = record.source === "artifact" ? artifactsRoot() : filesRoot();
    const real = safeRealpath(record.path, root);
    if (real) {
      try {
        rmSync(real, { force: true });
      } catch {
        /* ignore */
      }
    }
    deleteFile(record.id);
  }
  try {
    rmSync(join(artifactsRoot(), safeSessionSegment(sessionId)), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ignore */
  }
}
