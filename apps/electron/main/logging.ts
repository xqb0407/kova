/**
 * 磁盘日志（对齐 logging.rs）：<appLogDir>/<YYYY-MM-DD>/{app,pi-agent,web}.log，
 * 10MB 滚动单档、保留 7 天、缓冲 1s 强制 flush；所有行镜像 stderr。
 */
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { guardStreamErrors } from "./child-stream";
import { appDataDir, appLogDir } from "./paths";

const KEEP_DAYS = 7;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FRONTEND_MSG_MAX = 8000;
const FLUSH_AFTER_MS = 1000;
/** 建流失败后的重试间隔：磁盘持续满/无权限时，不能每条日志都重开一次 */
const OPEN_RETRY_MS = 5000;

function levelEnabled(): (l: number) => boolean {
  const raw = (process.env.KOVA_LOG_LEVEL ?? "info").trim().toLowerCase();
  const num = ({ off: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 } as Record<string, number>)[raw] ?? 3;
  return (l) => l <= num;
}
const enabled = levelEnabled();

function tsNow(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function dayStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** stderr 写失败一律吞（GUI 启动 stderr 可能是死管道，对齐 eprint_lossy）。
 *  不用 writeSync(2)：Windows 控制台 QuickEdit 模式下用户一选中文字，
 *  控制台进入暂停态，同步写 stderr 会**无限期阻塞主进程事件循环**——
 *  所有 IPC 排队、整个 UI"哪里都点不了"，只有杀进程才恢复（Windows 偶发
 *  卡死的候选根因之一）。process.stderr 在 Windows TTY 上是异步句柄：
 *  暂停期写入只进 libuv 队列，事件循环照常跑；POSIX 行为与旧实现一致。 */
function eprintLossy(line: string): void {
  try {
    process.stderr.write(line + "\n", () => {
      /* 回调里的错误忽略；流的 'error' 由 initLogging 统一挂监听兜住 */
    });
  } catch {
    /* 日志不能把进程带走 */
  }
}

class SourceFile {
  private date = "";
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private bytes = 0;
  private lastFlush = Date.now();
  private root = "";
  private retryAfter = 0;

  initRoot(root: string): void {
    this.root = root;
  }

  append(line: string): void {
    if (!this.root) return;
    const today = dayStamp(new Date());
    if (!this.stream || this.date !== today) {
      if (Date.now() < this.retryAfter) return; // 上次建流失败：退避期内直接丢弃
      this.close(); // 日切时先收掉昨天的句柄，避免 fd 泄漏
      this.date = today;
      this.open(today);
    }
    if (!this.stream) return;
    if (this.bytes > MAX_FILE_BYTES) {
      this.rotate();
    }
    const payload = line + "\n";
    try {
      this.stream.write(payload);
      this.bytes += Buffer.byteLength(payload);
      if (Date.now() - this.lastFlush >= FLUSH_AFTER_MS) {
        this.lastFlush = Date.now(); // createWriteStream 由 libuv 异步落盘；时间戳仅对齐语义
      }
    } catch {
      this.close();
      this.stream = null;
    }
  }

  private open(day: string): void {
    try {
      const dir = join(this.root, day);
      mkdirSync(dir, { recursive: true });
      const stream = createWriteStream(join(dir, this.name), { flags: "a" });
      guardStreamErrors(stream, () => {
        // 磁盘满/权限/文件被占用：丢弃句柄并退避，下一条日志到点再重开
        if (this.stream !== stream) return; // 已被新句柄顶替
        this.stream = null;
        this.retryAfter = Date.now() + OPEN_RETRY_MS;
      });
      this.stream = stream;
      const st = existsSync(join(dir, this.name)) ? statSync(join(dir, this.name)) : null;
      this.bytes = st?.size ?? 0;
      this.lastFlush = Date.now();
    } catch {
      this.stream = null;
      this.retryAfter = Date.now() + OPEN_RETRY_MS;
    }
  }

  private rotate(): void {
    const path = join(this.root, this.date, this.name);
    try {
      this.close();
      renameSync(path, path + ".1");
    } catch {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    }
    this.bytes = 0;
    this.open(this.date);
  }

  close(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
  }

  constructor(private name: string) {}
}

const appFile = new SourceFile("app.log");
const piFile = new SourceFile("kova-worker.log");
const webFile = new SourceFile("web.log");
let initialized = false;

/** 最先初始化（lib.rs setup 同款顺序） */
export function initLogging(): void {
  if (initialized) return;
  initialized = true;
  // GUI 启动时 stderr 可能是已断开的管道：writable 写失败会 emit('error')，
  // 只靠 write 回调拦不住，必须有人监听，否则是主进程 uncaughtException。
  process.stderr.on("error", () => {});
  const root = appLogDir();
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    /* 下面 append 会兜底 */
  }
  for (const f of [appFile, piFile, webFile]) f.initRoot(root);
  cleanupExpired(root);
}

function cleanupExpired(root: string): void {
  try {
    const now = new Date();
    const keepFrom = new Date(now.getTime() - KEEP_DAYS * 86400_000);
    for (const entry of readdirSync(root)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue; // 目录名非法跳过
      if (new Date(entry + "T00:00:00") >= keepFrom) continue;
      try {
        rmSync(join(root, entry), { recursive: true, force: true });
      } catch {
        /* 单个失败不拦整体 */
      }
    }
  } catch {
    /* root 缺失等：忽略 */
  }
}

export function writeSidecarLine(line: string): void {
  piFile.append(`${tsNow()} ${line}`);
}

export function logInfo(msg: string): void {
  logAt(3, "INFO ", msg);
}
export function logWarn(msg: string): void {
  logAt(2, "WARN ", msg);
}
export function logError(msg: string): void {
  logAt(1, "ERROR", msg);
}
export function logDebug(msg: string): void {
  logAt(4, "DEBUG", msg);
}
function logAt(level: number, tag: string, msg: string): void {
  if (!enabled(level)) return;
  const line = `${tsNow()} [${tag}] ${msg}`;
  eprintLossy(line);
  appFile.append(line);
}

export function setupLoggingCommands(register: (name: string, fn: (...a: any[]) => any) => void): void {
  register("frontend_log", (args: { level: string; message: string }) => {
    if (!initialized) return null;
    const level = args.level === "warn" ? "WARN " : args.level === "error" ? "ERROR" : "INFO ";
    let message = args.message ?? "";
    if (message.length > FRONTEND_MSG_MAX) {
      message = message.slice(0, FRONTEND_MSG_MAX) + "…";
    }
    const line = `${tsNow()} [${level}] ${message}`;
    eprintLossy(line);
    webFile.append(line);
    return null;
  });
  // 手动清理（设置页「清理」）：beforeDays = 7/30；<=0 = 清空今天以前的全部（当天目录保留）
  register("cleanup_logs", (args: { beforeDays: number }) => {
    const root = appLogDir();
    const beforeDays = Math.trunc(Number(args?.beforeDays ?? 0));
    const now = new Date();
    const today = dayStamp(now);
    const cutoff = dayStamp(new Date(now.getTime() - Math.max(beforeDays, 0) * 86400_000));
    for (const f of [appFile, piFile, webFile]) f.close();
    let removed = 0;
    try {
      for (const entry of readdirSync(root)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        const hit = beforeDays <= 0 ? entry < today : entry < cutoff;
        if (hit) {
          try {
            rmSync(join(root, entry), { recursive: true, force: true });
            removed += 1;
          } catch {
            /* 单个失败不拦整体 */
          }
        }
      }
    } catch {
      /* root 缺失 */
    }
    logInfo(`[logging] manual cleanup removed ${removed} dirs (before ${beforeDays} days)`);
    return removed;
  });
}

export { appDataDir };
