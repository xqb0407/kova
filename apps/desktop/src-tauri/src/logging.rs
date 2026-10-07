//! 磁盘日志：按日期分目录、按来源分文件，自研轻量实现（不引入 tauri-plugin-log）。
//!
//! 目录结构：<app_log_dir>/<YYYY-MM-DD>/app.log（Rust 主进程）、
//! pi-agent.log（sidecar stderr 转发）、web.log（前端 console 转发）。
//! - 行格式：`2026-09-10 21:33:05.123 [INFO ] [target] msg`（时间戳写入时补）
//! - 保留 KEEP_DAYS 天，启动时清理过期日期目录（目录名非法直接跳过）
//! - 单文件超 MAX_FILE_BYTES 滚动为 `*.log.1`（单档覆盖）
//! - 所有落盘行同步镜像到 stderr，dev 终端可见性不回退

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration as StdDuration, Instant};

use chrono::{Duration as ChronoDuration, Local, NaiveDate};
use log::{LevelFilter, Metadata, Record};
use tauri::{AppHandle, Manager};

/// 写 stderr，**失败即忽略**。
///
/// `eprintln!` 在写 stderr 失败时会 panic——这是 std 的保证行为。对 GUI 应用是致命的：
/// 从 Finder 或由别的进程（IDE/Electron）拉起时，stderr 可能是一根无人读取的管道，
/// 父进程一退出写入就失败，于是"记一条日志"变成 panic；release 档 `panic = "abort"`
/// （见 Cargo.toml），而这条 panic 又发生在 Tauri 命令处理器里，直接带走整个进程。
/// 崩溃栈就是 frontend_log → __eprint → panic_fmt → abort。
///
/// 日志的职责是记录，不是把程序带走。所有 stderr 输出一律走这里。
fn eprint_lossy(line: &str) {
    write_lossy(&mut std::io::stderr(), line);
}

/// `eprint_lossy` 的可测内核：把一行写给任意 writer，**错误一律吞掉**。
/// 单独抽出来是为了能用"必定失败的 writer"在测试里钉住这个契约，
/// 而不必去动测试进程的 fd 2（那会污染同进程内并行跑的其他测试）。
fn write_lossy<W: Write>(w: &mut W, line: &str) {
    let _ = writeln!(w, "{line}");
}



const KEEP_DAYS: i64 = 7;
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const FRONTEND_MSG_MAX: usize = 8000;
/// 迭代 3b：落盘缓冲窗口与最长滞留时间。逐行 write syscall 在 sidecar
/// 高频 stderr / web.log 转发下是纯开销；BufWriter 吸收小行，超过
/// FLUSH_AFTER 未刷新则下一次追加时强制 flush（tail 可见性 ≤1s 量级）。
const LOG_BUF_BYTES: usize = 256 * 1024;
const LOG_FLUSH_AFTER: StdDuration = StdDuration::from_millis(1000);

/// 级别过滤存储（LevelFilter 映射，默认 Info）
static LEVEL: AtomicU8 = AtomicU8::new(3);

fn level_filter_to_u8(f: LevelFilter) -> u8 {
    match f {
        LevelFilter::Off => 0,
        LevelFilter::Error => 1,
        LevelFilter::Warn => 2,
        LevelFilter::Info => 3,
        LevelFilter::Debug => 4,
        LevelFilter::Trace => 5,
    }
}

fn parse_level_filter(s: &str) -> Option<LevelFilter> {
    match s.trim().to_ascii_lowercase().as_str() {
        "off" => Some(LevelFilter::Off),
        "error" => Some(LevelFilter::Error),
        "warn" => Some(LevelFilter::Warn),
        "info" => Some(LevelFilter::Info),
        "debug" => Some(LevelFilter::Debug),
        "trace" => Some(LevelFilter::Trace),
        _ => None,
    }
}

/// 单个来源日志文件的句柄状态（当前日期 + 已写字节数，跨天/超限时重建）
struct SourceFile {
    date: NaiveDate,
    file: Option<BufWriter<File>>,
    bytes: u64,
    max_bytes: u64,
    last_flush: Instant,
}

impl SourceFile {
    fn new(max_bytes: u64) -> Self {
        Self {
            date: Local::now().date_naive(),
            file: None,
            bytes: 0,
            max_bytes,
            last_flush: Instant::now(),
        }
    }

    /// 追加一行（调用方负责时间戳前缀，这里补换行）。
    /// 跨天换目录；超 max_bytes 滚动为 `<name>.1`（覆盖旧档）。
    fn append(&mut self, root: &Path, name: &str, line: &str) {
        let today = Local::now().date_naive();
        if self.file.is_none() || self.date != today {
            self.date = today;
            self.open(root, name);
        }
        if self.bytes > self.max_bytes {
            self.rotate(root, name);
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let payload = format!("{line}\n");
        if let Err(e) = file.write_all(payload.as_bytes()) {
            eprint_lossy(&format!("[logging] write {name} failed: {e}"));
            self.file = None;
            return;
        }
        self.bytes += payload.len() as u64;
        if self.last_flush.elapsed() >= LOG_FLUSH_AFTER {
            if let Err(e) = file.flush() {
                eprint_lossy(&format!("[logging] flush {name} failed: {e}"));
            }
            self.last_flush = Instant::now();
        }
    }

    fn open(&mut self, root: &Path, name: &str) {
        let dir = root.join(self.date.format("%Y-%m-%d").to_string());
        if let Err(e) = fs::create_dir_all(&dir) {
            eprint_lossy(&format!("[logging] create log dir failed: {e}"));
            self.file = None;
            return;
        }
        let path = dir.join(name);
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                self.bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
                self.file = Some(BufWriter::with_capacity(LOG_BUF_BYTES, file));
                self.last_flush = Instant::now();
            }
            Err(e) => {
                eprint_lossy(&format!("[logging] open log file failed: {e}"));
                self.file = None;
            }
        }
    }

    fn rotate(&mut self, root: &Path, name: &str) {
        // 先 flush 再摘句柄：否则缓冲里未落盘的行会被 rename 甩在旧档外
        self.close();
        let dir = root.join(self.date.format("%Y-%m-%d").to_string());
        let path = dir.join(name);
        let archived = dir.join(format!("{name}.1"));
        let _ = fs::remove_file(&archived);
        if fs::rename(&path, &archived).is_ok() {
            self.bytes = 0;
        }
        self.open(root, name);
    }

    /// 冲刷并关闭当前句柄（滚动/清空日志目录前调用）
    fn close(&mut self) {
        if let Some(mut w) = self.file.take() {
            let _ = w.flush();
        }
    }
}

/// 日志器：三个固定来源 + 级别过滤（实现 log::Log 供 Rust 端宏使用）
struct Logger {
    root: Option<PathBuf>,
    app: Mutex<SourceFile>,
    pi_agent: Mutex<SourceFile>,
    web: Mutex<SourceFile>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

impl Logger {
    fn slot(&self, name: &str) -> &Mutex<SourceFile> {
        match name {
            "pi-agent.log" => &self.pi_agent,
            "web.log" => &self.web,
            _ => &self.app,
        }
    }

    /// 追加到指定来源文件（root 缺失时跳过落盘）
    fn append_source(&self, name: &str, line: &str) {
        let Some(root) = self.root.as_ref() else {
            return;
        };
        if let Ok(mut sf) = self.slot(name).lock() {
            sf.append(root, name, line);
        }
    }

    /// 冲刷并关闭全部来源文件句柄（清空日志目录前调用，避免 Windows 上
    /// 句柄锁目录；不 flush 会丢缓冲窗口内的尾部日志）
    fn close_handles(&self) {
        for slot in [&self.app, &self.pi_agent, &self.web] {
            if let Ok(mut sf) = slot.lock() {
                sf.close();
            }
        }
    }
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() as u8 <= LEVEL.load(Ordering::Relaxed)
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let line = format!(
            "{ts} [{:<5}] [{}] {}",
            record.level(),
            record.target(),
            record.args()
        );
        eprint_lossy(&line);
        self.append_source("app.log", &line);
    }

    fn flush(&self) {}
}

/// 当前时间戳前缀（来源文件共用格式）
fn ts_now() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

/// 在 lib.rs setup 最先调用：解析日志目录、注册全局 logger、清理过期目录
pub fn init(app: &AppHandle) {
    let root = app.path().app_log_dir().ok();
    if let Some(dir) = root.as_ref() {
        if let Err(e) = fs::create_dir_all(dir) {
            eprint_lossy(&format!("[logging] create log root failed: {e}"));
        }
    }
    if let Ok(raw) = std::env::var("KOVA_LOG_LEVEL") {
        if let Some(f) = parse_level_filter(&raw) {
            LEVEL.store(level_filter_to_u8(f), Ordering::Relaxed);
        }
    }
    let _ = LOGGER.set(Logger {
        root,
        app: Mutex::new(SourceFile::new(MAX_FILE_BYTES)),
        pi_agent: Mutex::new(SourceFile::new(MAX_FILE_BYTES)),
        web: Mutex::new(SourceFile::new(MAX_FILE_BYTES)),
    });
    // 必须填 OnceLock：write_sidecar_line / frontend_log / cleanup_logs 都走
    // LOGGER.get()，之前只 leak 给 log::set_logger 导致 pi-agent.log/web.log 无声蒸发
    let logger = LOGGER.get().expect("LOGGER just set (or already initialized)");
    if log::set_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Trace); // 过滤在 Logger::enabled 内做
    }
    if let Some(dir) = logger.root.as_ref() {
        let root = dir.clone();
        std::thread::spawn(move || cleanup_expired(&root, Local::now().date_naive()));
    }
}

/// sidecar stderr 行落 pi-agent.log（Rust 转发，sidecar 零改动）
pub fn write_sidecar_line(line: &str) {
    if let Some(logger) = LOGGER.get() {
        logger.append_source("pi-agent.log", &format!("{} {}", ts_now(), line));
    }
}

/// 前端 console 转发落 web.log（invoke 自 lib/frontend-logging.ts）
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    let level = match level.as_str() {
        "warn" => "WARN",
        "error" => "ERROR",
        _ => "INFO",
    };
    let mut message = message;
    if message.len() > FRONTEND_MSG_MAX {
        // 截断点回退到 UTF-8 字符边界，避免 panic
        let mut end = FRONTEND_MSG_MAX;
        while end > 0 && !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push('…');
    }
    if let Some(logger) = LOGGER.get() {
        let line = format!("{} [{level}] {message}", ts_now());
        eprint_lossy(&line);
        logger.append_source("web.log", &line);
    }
}

/// 清理 KEEP_DAYS 天前的日期目录；目录名非法（非 YYYY-MM-DD）直接跳过
fn cleanup_expired(root: &Path, today: NaiveDate) {
    cleanup_before(root, today, KEEP_DAYS);
}

/// 删除早于 `today - before_days` 的日期目录，返回删除数量。
/// `before_days <= 0` 表示清空今天以前的全部（当天目录始终保留）。
fn cleanup_before(root: &Path, today: NaiveDate, before_days: i64) -> usize {
    let cutoff = today - ChronoDuration::days(before_days.max(0));
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(date) = NaiveDate::parse_from_str(name, "%Y-%m-%d") else {
            continue;
        };
        let hit = if before_days <= 0 {
            date < today
        } else {
            date < cutoff
        };
        if hit && fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 手动清理日志（设置页「清理」菜单）：before_days = 7/30，0 = 清空今天以前的全部（当天保留）
#[tauri::command]
pub fn cleanup_logs(before_days: i64) -> Result<u32, String> {
    let Some(logger) = LOGGER.get() else {
        return Err("logging not initialized".into());
    };
    let Some(root) = logger.root.clone() else {
        return Err("log dir unavailable".into());
    };
    let today = Local::now().date_naive();
    logger.close_handles();
    let removed = cleanup_before(&root, today, before_days);
    log::info!("[logging] manual cleanup removed {removed} dirs (before {before_days} days)");
    Ok(removed as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kova-logging-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cleanup_removes_only_expired_date_dirs() {
        let root = temp_root("cleanup");
        let today = Local::now().date_naive();
        let old = (today - ChronoDuration::days(KEEP_DAYS + 1))
            .format("%Y-%m-%d")
            .to_string();
        let fresh = today.format("%Y-%m-%d").to_string();
        fs::create_dir_all(root.join(&old)).unwrap();
        fs::create_dir_all(root.join(&fresh)).unwrap();
        fs::create_dir_all(root.join("not-a-date")).unwrap();

        cleanup_expired(&root, today);

        assert!(!root.join(&old).exists(), "过期日期目录应被删除");
        assert!(root.join(&fresh).exists(), "当天目录应保留");
        assert!(root.join("not-a-date").exists(), "非法目录名应跳过");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cleanup_before_returns_removed_count() {
        let root = temp_root("count");
        let today = Local::now().date_naive();
        let mk = |offset_days: i64| {
            root.join((today - ChronoDuration::days(offset_days)).format("%Y-%m-%d").to_string())
        };
        for offset in [KEEP_DAYS + 1, KEEP_DAYS + 2, KEEP_DAYS + 3] {
            fs::create_dir_all(mk(offset)).unwrap();
        }
        fs::create_dir_all(mk(0)).unwrap();

        assert_eq!(cleanup_before(&root, today, KEEP_DAYS), 3, "只删过期目录");
        assert!(mk(0).exists(), "第一轮清理不动当天目录");
        // 清空（0）也不动当天目录
        assert_eq!(cleanup_before(&root, today, 0), 0, "当天目录保留");
        assert!(mk(0).exists(), "清空不删除当天目录");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn source_file_rotates_on_size_limit() {
        let root = temp_root("rotate");
        let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let mut sf = SourceFile::new(64);
        for i in 0..20 {
            sf.append(&root, "app.log", &format!("line-{i:03} {}", "x".repeat(20)));
        }
        assert!(root.join(&today).join("app.log").exists());
        assert!(
            root.join(&today).join("app.log.1").exists(),
            "超过 max_bytes 后应滚动出 .1 档"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn source_file_switches_dir_on_new_day() {
        let root = temp_root("newday");
        let mut sf = SourceFile::new(MAX_FILE_BYTES);
        // 模拟昨天已写过：直接把内部日期拨回昨天，再追加应落到今天目录
        sf.date = Local::now().date_naive() - ChronoDuration::days(1);
        sf.file = None;
        sf.append(&root, "app.log", "after-day-switch");
        let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
        assert!(root.join(&today).join("app.log").exists());
        fs::remove_dir_all(&root).ok();
    }

    /// 回归：日志写入失败绝不能让进程崩掉。
    ///
    /// 实机崩溃栈（macOS crash report）：frontend_log → std::io::stdio::__eprint
    /// → core::panicking::panic_fmt → abort。`eprintln!` 在写 stderr 失败时 panic，
    /// 而 release 档 panic = "abort"，且这条 panic 发生在 Tauri 命令处理器里，
    /// 于是"stderr 不可写"升级成"整个应用被带走"。触发场景很普通：
    /// 应用由别的进程拉起（IDE/Electron），父进程退出后 stderr 成为断管。
    #[test]
    fn write_lossy_swallows_a_broken_stderr() {
        struct DeadPipe;
        impl Write for DeadPipe {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken pipe"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken pipe"))
            }
        }
        // 不 panic 即通过——这正是修复本身
        write_lossy(&mut DeadPipe, "2026-10-07 21:54:36 [ERROR] 崩给你看");
    }

    /// 反证：同一个 writer 上，`eprintln!` 那种"失败即 panic"的写法确实会炸。
    /// 没有这条，上面的测试可能只是在空转。
    #[test]
    fn writing_to_a_dead_pipe_panics_when_unwrapped() {
        struct DeadPipe;
        impl Write for DeadPipe {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken pipe"))
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken pipe"))
            }
        }
        let caught = std::panic::catch_unwind(|| {
            let mut w = DeadPipe;
            writeln!(w, "x").expect("eprintln! 语义：写失败即 panic");
        });
        assert!(caught.is_err(), "写失败必须表现为 panic，否则上面那条测试是空转");
    }
}
