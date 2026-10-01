//! 主机工具执行：bash / read / write / edit / http。
//! 此前在 sidecar（Node child_process / fs）实现，现下沉到 Rust：
//! - bash 用 taskkill /T /F 杀整个进程树，解决 Windows 上孙进程残留
//!   （Node 的 child.kill() 只杀直接子进程）
//! - read/write/edit 用 std::fs，行为与原 TS 实现镜像（行号格式、截断上限、
//!   二进制检测、old_string 唯一性校验）
//! glob/grep 留在 sidecar：纯只读内存计算，且 JS 正则（lookahead 等）与
//! Rust regex 语法不兼容，迁移有行为风险。

use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MAX_TOOL_OUTPUT: usize = 16 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_MS: u64 = 120_000;
/// 模型可申请的超时上限（600s）：防单命令挂死回合，长任务应走 runInBackground
const MAX_BASH_TIMEOUT_MS: u64 = 600_000;
/// 进程收尾后等读线程 EOF 的上限：正常毫秒级返回，只给「杀干净了但管道未关」留余量
const READER_JOIN_GRACE_MS: u64 = 2_000;

const DEFAULT_HTTP_TIMEOUT_MS: u64 = 30_000;
const MAX_HTTP_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES_CAP: usize = 10 * 1024 * 1024;

fn str_param(p: &Value, key: &str) -> Result<String, String> {
    p.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

/* ------------------------------ 运行中工具的取消 ------------------------------ */

/// 杀整棵进程树。
///
/// Windows：taskkill /T /F（Git Bash 会再拉起真正的命令进程，只杀直接子进程会残留孙进程）。
/// Unix：bash 以 `process_group(0)` 自立进程组（见 run_bash），pgid 即 pid，
/// `killpg` 一次收掉整组——Chrome 这类会再派生 GPU/Renderer 子孙的命令尤其需要。
/// 只杀直接子进程会留下持有 stdout 管的孤儿孙进程，导致 run_bash 的读线程永不 EOF。
#[cfg(windows)]
pub(crate) fn kill_tree(pid: u32) {
    let mut killer = Command::new("taskkill");
    killer
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut killer);
    let _ = killer.output();
}

#[cfg(unix)]
pub(crate) fn kill_tree(pid: u32) {
    // 负 pid = 整个进程组；先组后单点，组已空时单点兜底（pgid 未立组的极端情况）
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// 一条在飞的 tool 请求：取消标志 + bash 子进程 pid（spawn 后才登记）
#[derive(Default)]
struct CancelEntry {
    pid: StdMutex<Option<u32>>,
    cancelled: AtomicBool,
}

/// 在飞表：host_query id → 取消令牌。handle_tool 注册，响应产出（Drop）时注销
fn in_flight_tools() -> &'static StdMutex<HashMap<String, Arc<CancelEntry>>> {
    static TABLE: OnceLock<StdMutex<HashMap<String, Arc<CancelEntry>>>> = OnceLock::new();
    TABLE.get_or_init(Default::default)
}

/// RAII 取消令牌：sidecar 发来 host_cancel（或超时放弃）时置标志并杀已登记的进程树
pub struct CancelGuard {
    id: String,
    entry: Arc<CancelEntry>,
}

impl CancelGuard {
    fn new(id: &str) -> Self {
        let entry = Arc::new(CancelEntry::default());
        if !id.is_empty() {
            if let Ok(mut map) = in_flight_tools().lock() {
                map.insert(id.to_string(), Arc::clone(&entry));
            }
        }
        Self {
            id: id.to_string(),
            entry,
        }
    }

    /// 登记本请求派生出的进程 pid；若取消已先到达（竞态窗口），立即补杀。
    /// 同一请求只会派生一棵进程树（bash 命令，或 browser_shot 的 Chrome），
    /// 槽位单值够用。
    pub(crate) fn attach_pid(&self, pid: u32) {
        {
            let mut slot = self.entry.pid.lock().unwrap_or_else(|e| e.into_inner());
            *slot = Some(pid);
        }
        if self.entry.cancelled.load(Ordering::Relaxed) {
            kill_tree(pid);
        }
    }

    /// browser_* 动作的等待循环按此检查中断（host_cancel / 超时放弃）
    pub fn is_cancelled(&self) -> bool {
        self.entry.cancelled.load(Ordering::Relaxed)
    }

    /// 不挂到在飞表的可取消令牌。给测试用——测试里没有 host_cancel，
    /// 但等待循环仍要有个 is_cancelled 可问。
    #[cfg(test)]
    pub fn detached() -> Self {
        Self { id: String::new(), entry: Arc::new(CancelEntry::default()) }
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = in_flight_tools().lock() {
            // 只删自己那次登记（id 理论上可能跨重启复用）
            let owned = map
                .get(&self.id)
                .map(|e| Arc::ptr_eq(e, &self.entry))
                .unwrap_or(false);
            if owned {
                map.remove(&self.id);
            }
        }
    }
}

/// host_cancel 入口：置取消标志 + 杀进程树；id 未登记（已完成/非工具）时是 no-op
pub fn cancel_tool(id: &str) {
    let entry = in_flight_tools()
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned());
    if let Some(entry) = entry {
        entry.cancelled.store(true, Ordering::Relaxed);
        let pid = *entry.pid.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pid) = pid {
            kill_tree(pid);
        }
    }
}

/// sidecar 进程退出兜底：所有在飞工具置标志并杀进程树，避免孤儿进程
pub fn cancel_all_tools() {
    let entries: Vec<Arc<CancelEntry>> = in_flight_tools()
        .lock()
        .map(|mut m| m.drain().map(|(_, e)| e).collect())
        .unwrap_or_default();
    for entry in entries {
        entry.cancelled.store(true, Ordering::Relaxed);
        let pid = *entry.pid.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pid) = pid {
            kill_tree(pid);
        }
    }
}

/// Windows 下隐藏控制台窗口（等价 Node spawn 的 windowsHide: true）
#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
pub(crate) fn no_window(_cmd: &mut Command) {}

/// bash 可执行文件解析：与原 sidecar resolveShellCommand 一致——
/// Windows 用 Git Bash（PATH → git.exe 同目录 → 常见安装位置），退回 cmd.exe。
fn resolve_shell_command() -> (String, Vec<String>) {
    if !cfg!(windows) {
        return ("/bin/bash".into(), vec!["-c".into()]);
    }
    let path_dirs: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let mut candidates: Vec<String> = path_dirs.iter().map(|d| format!("{d}\\bash.exe")).collect();
    // git.exe 在 PATH 上时，尝试同安装目录的 bin\bash.exe（便携/自定义安装）
    let git_dir = path_dirs
        .iter()
        .find(|d| std::path::Path::new(&format!("{d}\\git.exe")).exists())
        .cloned();
    if let Some(git_dir) = git_dir {
        candidates.push(format!("{git_dir}\\..\\bin\\bash.exe"));
    }
    candidates.push("C:\\Program Files\\Git\\bin\\bash.exe".into());
    candidates.push("C:\\Program Files (x86)\\Git\\bin\\bash.exe".into());
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!("{local}\\Programs\\Git\\bin\\bash.exe"));
    }
    for file in candidates {
        if std::path::Path::new(&file).exists() {
            return (file, vec!["-c".into()]);
        }
    }
    ("cmd.exe".into(), vec!["/d".into(), "/s".into(), "/c".into()])
}

/// 运行 shell 命令：合并 stdout/stderr，超时或收到取消（host_cancel）时
/// taskkill /T /F 杀进程树提前退出。
/// `secrets`：本次调用要注入的环境变量（名字 + 明文；由 secret_env 在进锁窗口外
/// 解析好），只影响这一个派生进程——绝不写进父进程环境。
fn run_bash(
    cwd: &str,
    command: &str,
    timeout_ms: u64,
    cancel: &CancelGuard,
    secrets: &[(String, String)],
) -> Result<Value, String> {
    let (file, prefix_args) = resolve_shell_command();
    let mut cmd = Command::new(&file);
    cmd.args(&prefix_args)
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::secret_env::apply_env(&mut cmd, secrets);
    no_window(&mut cmd);
    // Unix：自立进程组，killpg 才能一次收掉命令派生出的全部子孙
    // （stdin 已是 null，不存在「脱离前台进程组读不到终端」的副作用）
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn {file}: {e}"))?;
    let pid = child.id();
    // 登记 pid：取消若已在 spawn 前到达，这里立即补杀（关闭竞态窗口）
    cancel.attach_pid(pid);

    let combined: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
    let killed = Arc::new(AtomicBool::new(false));
    let mut reader_handles = Vec::new();
    let (reader_done_tx, reader_done_rx) = std::sync::mpsc::channel::<()>();
    let streams: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().ok_or("no stdout")?),
        Box::new(child.stderr.take().ok_or("no stderr")?),
    ];
    for stream in streams {
        let sink = Arc::clone(&combined);
        let killed_flag = Arc::clone(&killed);
        let done_tx = reader_done_tx.clone();
        reader_handles.push(std::thread::spawn(move || {
            let mut reader = stream;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let overflow = match sink.lock() {
                            Ok(mut out) => {
                                let over = out.len() >= MAX_TOOL_OUTPUT;
                                if !over {
                                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                                }
                                over
                            }
                            Err(_) => true,
                        };
                        // 输出超限：与原 TS 行为一致，杀掉进程提前结束（防失控输出）
                        if overflow && !killed_flag.swap(true, Ordering::Relaxed) {
                            kill_tree(pid);
                        }
                    }
                }
            }
            let _ = done_tx.send(());
        }));
    }
    drop(reader_done_tx);

    // 等 wait 结束、超时或取消；后两者用 taskkill /T /F 杀整棵进程树
    let timeout = Duration::from_millis(timeout_ms);
    let start = Instant::now();
    // spawn/attach 期间可能已收到取消：进程被 attach_pid 补杀，这里标记为 cancelled
    let mut cancelled = cancel.is_cancelled();
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if cancel.is_cancelled() {
                    cancelled = true;
                    kill_tree(pid);
                    break None;
                }
                if start.elapsed() >= timeout {
                    kill_tree(pid);
                    break None; // 超时
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break Some(-1),
        }
    };

    // 取消方（host_cancel 线程）会直接 kill 掉进程树抢先一步：Unix 的 SIGKILL 是
    // 瞬时的，下一轮 try_wait 就已经是「已退出」，循环根本没机会读到标志位，
    // 于是同一事实会被报成 [timeout]。出口处再兜一次，让已取消优先于超时。
    if cancel.is_cancelled() {
        cancelled = true;
    }

    // 收读线程必须有上限：读线程卡在 pipe read 上只有一种成因——进程树还活着。
    // 正常路径下 kill_tree 已收干净，管道立即 EOF、毫秒返回；这里再兜一层，
    // 保证「取消/超时的快速返回」不被任何残留进程无限拖住（曾因此让一次
    // Chrome 无头截图把 bash RPC 拖到 135s 超时，并留下孤儿继续占 SingletonLock）。
    // 超时未完成就直接丢弃句柄（线程 detach）：它只持有 Arc，无 UB 风险。
    let drain_deadline = Instant::now() + Duration::from_millis(READER_JOIN_GRACE_MS);
    while reader_done_rx.recv_timeout(Duration::from_millis(50)).is_ok() {
        if Instant::now() >= drain_deadline {
            break;
        }
    }
    drop(reader_handles);

    // 读线程可能仍detach着，不能用 try_unwrap（会因 Arc 计数非 1 而静默返回空串）
    let mut out = combined.lock().map(|m| m.clone()).unwrap_or_default();
    let mut truncated = false;
    // UTF-8 字符边界截断（比 TS 的 UTF-16 截断更安全）
    if out.len() > MAX_TOOL_OUTPUT {
        let mut cut = MAX_TOOL_OUTPUT;
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        truncated = true;
    }
    let status = if cancelled {
        "\n[cancelled]".to_string()
    } else {
        match exit_code {
            Some(0) => String::new(),
            Some(code) => format!("\n[exit code: {code}]"),
            None => format!(
                "\n[timeout after {}s — output above is what was collected before the kill. \
                 For long-running commands pass runInBackground:true and poll with task_output, \
                 or split the work into shorter steps.]",
                timeout_ms / 1000
            ),
        }
    };
    let suffix = if truncated { "\n…[output truncated]" } else { "" };
    // 脱敏必须在回程前做：输出一旦返回 sidecar 就顺着 tool_execution_end
    // 进转录落盘，那时明文已经跟着写出去了。见 docs/secrets-env-design.md §1.6。
    let out = crate::secret_env::redact(&out, secrets);
    Ok(json!({
        "output": format!("{out}{status}{suffix}"),
        "truncated": truncated,
        "exitCode": exit_code,
        "cancelled": cancelled,
    }))
}

fn read_text_file(cwd: &str, file_path: &str) -> Result<(Vec<u8>, String), String> {
    let full = resolve_path(cwd, file_path)?;
    let raw = std::fs::read(&full).map_err(|e| format!("failed to read {file_path}: {e}"))?;
    Ok((raw, full))
}

/* ----------------------------- 后台 bash 任务 ------------------------------
 * 主流做法（Claude Code run_in_background 等）：长命令丢后台立即返回句柄，
 * 回合继续不阻塞；配套 task_output（读输出+状态）/ task_stop（杀）按需操作。
 * 与前台 bash 的关键差异：后台任务**不受 host_cancel 影响**（跨回合存活——
 * 取消对话回合只杀前台命令树），进程自然退出或被 task_stop 显式杀掉。 */

/// 单任务输出缓冲上限：超限丢头部保留尾部（tail 对诊断更有用）
const MAX_BG_OUTPUT: usize = 256 * 1024;
/// 已完成任务句柄保留上限：超过淘汰最老的已完成项（运行中不淘汰）
const MAX_BG_TASKS: usize = 32;
static BG_NEXT_ID: AtomicU32 = AtomicU32::new(1);

struct BgTask {
    command: String,
    pid: u32,
    combined: Arc<StdMutex<String>>,
    killed: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    exit_code: Arc<StdMutex<Option<i32>>>,
    /// 启动时注入的密钥存档：task_output 回程前按它脱敏（明文只存在本进程内存，
    /// 不随输出外泄；同 run_bash 出口脱敏的约束，见 docs/secrets-env-design.md §1.6）
    secrets: Vec<(String, String)>,
    /// 发起线程 id（sidecar 随工具信封带上）。这张表是全进程一张，任务却属于
    /// 某一个会话：没有归属校验的话，任意线程猜到一个 taskId 就能读到别人命令
    /// 的输出（可能含未脱敏上下文），或 task_stop 杀掉别人的长跑进程。
    owner: String,
}

static BG_TASKS: OnceLock<StdMutex<HashMap<u32, BgTask>>> = OnceLock::new();

fn bg_tasks() -> &'static StdMutex<HashMap<u32, BgTask>> {
    BG_TASKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// 启动后台 shell 命令：spawn + 双流读者线程 + wait 线程，立即返回 task id。
/// 输出进 256KB 尾部缓冲；secrets 只注入这一个派生进程（同前台 bash）。
/// owner = 发起线程 id，落进 BgTask 供 task_output / task_stop 校验归属。
fn run_bash_background(
    cwd: &str,
    command: &str,
    secrets: &[(String, String)],
    owner: &str,
) -> Result<Value, String> {
    let (file, prefix_args) = resolve_shell_command();
    let mut cmd = Command::new(&file);
    cmd.args(&prefix_args)
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::secret_env::apply_env(&mut cmd, secrets);
    no_window(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn {file}: {e}"))?;
    let pid = child.id();

    let combined = Arc::new(StdMutex::new(String::new()));
    let killed = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(true));
    let exit_code = Arc::new(StdMutex::new(None::<i32>));
    let streams: Vec<Box<dyn Read + Send>> = vec![
        Box::new(child.stdout.take().ok_or("no stdout")?),
        Box::new(child.stderr.take().ok_or("no stderr")?),
    ];
    for stream in streams {
        let sink = Arc::clone(&combined);
        let killed_flag = Arc::clone(&killed);
        std::thread::spawn(move || {
            let mut reader = stream;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if killed_flag.load(Ordering::Relaxed) {
                            break;
                        }
                        if let Ok(mut out) = sink.lock() {
                            out.push_str(&String::from_utf8_lossy(&buf[..n]));
                            // 超限丢头部：保留尾部 MAX_BG_OUTPUT 字节（字符边界对齐）
                            if out.len() > MAX_BG_OUTPUT {
                                let cut = out.len() - MAX_BG_OUTPUT;
                                let mut cut2 = cut;
                                while cut2 < out.len() && !out.is_char_boundary(cut2) {
                                    cut2 += 1;
                                }
                                out.drain(..cut2);
                            }
                        }
                    }
                }
            }
        });
    }

    // wait 线程：阻塞等退出，标记 done + exit code（孤儿进程自然回收，无泄漏）
    let wait_running = Arc::clone(&running);
    let wait_code = Arc::clone(&exit_code);
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).or(Some(-1));
        if let Ok(mut c) = wait_code.lock() {
            *c = code;
        }
        wait_running.store(false, Ordering::Relaxed);
    });

    let id = BG_NEXT_ID.fetch_add(1, Ordering::Relaxed);
    // 淘汰最老的已完成任务，句柄表不无限增长（运行中的不淘汰）
    if let Ok(mut map) = bg_tasks().lock() {
        if map.len() >= MAX_BG_TASKS {
            if let Some(oldest_done) = map.iter().find(|(_, t)| !t.running.load(Ordering::Relaxed)).map(|(k, _)| *k) {
                map.remove(&oldest_done);
            }
        }
        map.insert(id, BgTask {
            command: command.to_string(),
            pid,
            combined: Arc::clone(&combined),
            killed: Arc::clone(&killed),
            running,
            exit_code,
            secrets: secrets.to_vec(),
            owner: owner.to_string(),
        });
    }
    Ok(json!({
        "output": format!(
            "Started in background (task {id}). The process keeps running across turns and is \
             NOT killed when this turn is cancelled. Use task_output with taskId={id} to read \
             collected output and check status; use task_stop with taskId={id} to kill it. \
             Do not poll in a tight loop — do other work first, then check again."
        ),
        "taskId": id,
    }))
}

/// 取本线程有权访问的任务句柄。任务表全进程共享，id 是自增小整数——不校验归属
/// 的话任何线程都能读走别人的命令输出或杀掉别人的进程。owner 为空（旧版
/// sidecar 不带该字段）时放行：宁可宽松，也不能因为对端没升级就把长跑任务
/// 变成"查不到"。
fn owned_task<'a>(
    map: &'a HashMap<u32, BgTask>,
    id: u32,
    owner: &str,
) -> Result<&'a BgTask, String> {
    let task = map
        .get(&id)
        .ok_or_else(|| format!("no such background task: {id} (it may have been reaped after completion)"))?;
    if !owner.is_empty() && !task.owner.is_empty() && task.owner != owner {
        return Err(format!(
            "background task {id} belongs to another thread; it is not readable or stoppable from here. \
             Only task ids issued to this thread may be used."
        ));
    }
    Ok(task)
}

/// task_output：返回缓冲内的全部输出（≤256KB 尾部）+ 运行状态
/// （脱敏按任务启动时的 secrets 存档，见 BgTask.secrets）。
fn handle_task_output(p: &Value, owner: &str) -> Result<Value, String> {
    let id = p
        .get("taskId")
        .and_then(|v| v.as_u64())
        .ok_or("taskId is required")? as u32;
    let map = bg_tasks().lock().map_err(|_| "task registry poisoned")?;
    let task = owned_task(&map, id, owner)?;
    let out = task.combined.lock().map(|m| m.clone()).unwrap_or_default();
    let running = task.running.load(Ordering::Relaxed);
    let code = task.exit_code.lock().map(|c| *c).unwrap_or(None);
    let out = crate::secret_env::redact(&out, &task.secrets);
    let status = if running {
        "\n[still running]".to_string()
    } else {
        match code {
            Some(0) => "\n[exited cleanly]".to_string(),
            Some(c) => format!("\n[exited with code {c}]"),
            None => String::new(),
        }
    };
    Ok(json!({
        "output": format!("{}{}", out, status),
        "running": running,
        "exitCode": code,
    }))
}

/// task_stop：杀整棵进程树（同前台 kill_tree 路径）
fn handle_task_stop(p: &Value, owner: &str) -> Result<Value, String> {
    let id = p
        .get("taskId")
        .and_then(|v| v.as_u64())
        .ok_or("taskId is required")? as u32;
    let map = bg_tasks().lock().map_err(|_| "task registry poisoned")?;
    let task = owned_task(&map, id, owner)?;
    if !task.running.load(Ordering::Relaxed) {
        return Ok(json!({ "output": format!("task {id} already exited."), "running": false }));
    }
    task.killed.store(true, Ordering::Relaxed);
    kill_tree(task.pid);
    Ok(json!({
        "output": format!("task {id} killed: {}", task.command.chars().take(120).collect::<String>()),
        "running": false,
    }))
}

fn resolve_path(cwd: &str, p: &str) -> Result<String, String> {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        Ok(p.to_string())
    } else {
        Ok(std::path::Path::new(cwd).join(p).to_string_lossy().to_string())
    }
}

/// 按扩展名识别常见栅格图片 → MIME（与 sidecar image-parts.ts 白名单一致，svg 不放行）
fn image_mime(file_path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(file_path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn handle_read(p: &Value) -> Result<Value, String> {
    let file_path = str_param(p, "file_path")?;
    let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let (raw, _full) = read_text_file(cwd, &file_path)?;
    // 图片直接以 base64 返回，sidecar 转成 image 内容块让模型"看见"（工作区截图/
    // 生成图的查看路径）。2MiB 上限与 image-parts.ts 的 IMAGE_INLINE_MAX_BYTES 对齐。
    if let Some(mime) = image_mime(&file_path) {
        const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
        if raw.len() > MAX_IMAGE_BYTES {
            return Ok(json!({
                "output": format!(
                    "{file_path} is an image ({} KB) too large to attach inline (>2MiB). \
                     Downscale it first, e.g. `sips -Z 1600 \"{file_path}\" --out small.png`, \
                     then read the downscaled copy.",
                    raw.len() / 1024
                ),
            }));
        }
        use base64::Engine as _;
        return Ok(json!({
            "output": format!("Image attached: {mime}, {} KB", raw.len() / 1024),
            "base64": base64::engine::general_purpose::STANDARD.encode(&raw),
            "mimeType": mime,
            "bytes": raw.len(),
        }));
    }
    if raw.contains(&0u8) {
        return Err(format!("{file_path} is a binary file and cannot be read as text"));
    }
    let text = String::from_utf8_lossy(&raw);
    let all_lines: Vec<&str> = text.split('\n').collect();
    let offset = p.get("offset").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let limit = p.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
    let start = offset.saturating_sub(1);
    let end = (start + limit.unwrap_or(all_lines.len())).min(all_lines.len());
    let mut slice = all_lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{}\t{}", start + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    if slice.len() > MAX_READ_BYTES {
        let mut cut = MAX_READ_BYTES;
        while cut > 0 && !slice.is_char_boundary(cut) {
            cut -= 1;
        }
        slice.truncate(cut);
        slice.push_str("\n…[truncated]");
    }
    let more = if end < all_lines.len() {
        format!("\n…[{} more lines, total {}]", all_lines.len() - end, all_lines.len())
    } else {
        String::new()
    };
    Ok(json!({ "output": format!("{slice}{more}"), "totalLines": all_lines.len() }))
}

/// `.json` 落盘守门：内容解析不过就拒绝写入，错误回给 agent 让它当轮改正。
/// 动机：edit 对 JSON 做纯文本替换可以轻易吃掉结构符号（agent 把画布档改坏、
/// 面板"打开是空的"的事故源）；宁可工具报错也不留下坏档。非 .json 不受影响。
fn guard_json(file_path: &str, content: &str) -> Result<(), String> {
    if !file_path.rsplit('.').next().is_some_and(|ext| ext.eq_ignore_ascii_case("json")) {
        return Ok(());
    }
    serde_json::from_str::<Value>(content).map_err(|e| {
        format!("{file_path} would not be valid JSON after this change ({e}); write the whole file with corrected content instead of a partial edit")
    })?;
    Ok(())
}

fn handle_write(p: &Value) -> Result<Value, String> {
    let file_path = str_param(p, "file_path")?;
    let content = str_param(p, "content")?;
    guard_json(&file_path, &content)?;
    let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let full = resolve_path(cwd, &file_path)?;
    if let Some(parent) = std::path::Path::new(&full).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create dirs for {file_path}: {e}"))?;
    }
    std::fs::write(&full, content.as_bytes()).map_err(|e| format!("failed to write {file_path}: {e}"))?;
    Ok(json!({ "output": format!("Wrote {} bytes to {}", content.len(), file_path) }))
}

fn handle_edit(p: &Value) -> Result<Value, String> {
    let file_path = str_param(p, "file_path")?;
    let old_string = str_param(p, "old_string")?;
    let new_string = str_param(p, "new_string")?;
    let replace_all = p.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
    let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let (raw, full) = read_text_file(cwd, &file_path)?;
    if raw.contains(&0u8) {
        return Err(format!("{file_path} is a binary file and cannot be edited as text"));
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let occurrences = text.split(&old_string).count() - 1;
    if occurrences == 0 {
        return Err(format!("old_string not found in {file_path}"));
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "old_string appears {occurrences} times in {file_path}; provide more context or set replace_all=true"
        ));
    }
    let updated = if occurrences > 1 {
        text.replace(&old_string, &new_string)
    } else {
        text.replacen(&old_string, &new_string, 1)
    };
    // 先验后写：解析不过就整个拒绝，盘上原文件分毫不动
    guard_json(&file_path, &updated)?;
    std::fs::write(&full, updated.as_bytes()).map_err(|e| format!("failed to write {file_path}: {e}"))?;
    let count = if replace_all && occurrences > 1 { occurrences } else { 1 };
    Ok(json!({ "output": format!("Replaced {count} occurrence(s) in {file_path}") }))
}

/* ------------------------------ http（WebFetch / WebSearch 底座） ------------------------------ */

/// 文本类 content-type 判定（与原 TS 实现镜像：前缀 + "+json/+xml" 后缀）
fn is_textual_content_type(content_type: &str) -> bool {
    let ct = content_type.to_lowercase();
    const PREFIXES: [&str; 5] = [
        "text/",
        "application/json",
        "application/xml",
        "application/javascript",
        "application/x-www-form-urlencoded",
    ];
    const SUFFIXES: [&str; 2] = ["+json", "+xml"];
    PREFIXES.iter().any(|p| ct.starts_with(p)) || SUFFIXES.iter().any(|s| ct.contains(s))
}

/// 通用 HTTP 请求执行：网络层唯一出口在 Rust（sidecar 是裸 Node 子进程，不能碰
/// Tauri JS API），schema/裁剪在 sidecar http-tools.ts。行为对齐 harness-x：
/// - 文本类响应 → utf-8 解码；二进制 → base64（encoding 字段区分）
/// - 响应体按 maxResponseBytes 截断（默认 2MB，上限 10MB），超时默认 30s
/// - 非 2xx 不报错，原样返回（让模型自己决定怎么处置）
fn handle_http(p: &Value) -> Result<Value, String> {
    use base64::Engine as _;

    let url_s = str_param(p, "url")?;
    let url = reqwest::Url::parse(&url_s).map_err(|e| format!("invalid url: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("unsupported url scheme: {}", url.scheme()));
    }

    let method_s = p
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_uppercase();
    if !matches!(
        method_s.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        return Err(format!("unsupported method: {method_s}"));
    }
    let method = reqwest::Method::from_bytes(method_s.as_bytes())
        .map_err(|e| format!("invalid method: {e}"))?;

    // 请求头
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(map) = p.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in map {
            let value = v
                .as_str()
                .ok_or_else(|| format!("header {k}: value must be a string"))?;
            let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| format!("invalid header name {k}: {e}"))?;
            let value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|e| format!("invalid header value for {k}: {e}"))?;
            headers.insert(name, value);
        }
    }

    // 请求体：字符串原样；对象 JSON 化并补默认 Content-Type
    let body_bytes = match p.get("body") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone().into_bytes()),
        Some(v @ (Value::Object(_) | Value::Array(_))) => {
            if !headers.contains_key(reqwest::header::CONTENT_TYPE) {
                headers.insert(
                    reqwest::header::CONTENT_TYPE,
                    reqwest::header::HeaderValue::from_static("application/json"),
                );
            }
            Some(serde_json::to_vec(v).map_err(|e| format!("failed to encode body: {e}"))?)
        }
        Some(_) => return Err("body must be a string or object".into()),
    };

    let timeout_ms = p
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_HTTP_TIMEOUT_MS)
        .clamp(1, MAX_HTTP_TIMEOUT_MS);
    let max_bytes = p
        .get("maxResponseBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_MAX_RESPONSE_BYTES as u64)
        .clamp(1, MAX_RESPONSE_BYTES_CAP as u64) as usize;

    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))?;

    let mut req = client.request(method, url).headers(headers);
    if let Some(b) = body_bytes {
        req = req.body(b);
    }
    let mut resp = req.send().map_err(|e| {
        if e.is_timeout() {
            format!("request timed out after {timeout_ms}ms: {url_s}")
        } else {
            format!("request failed: {e}")
        }
    })?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let declared_total = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    let response_headers: serde_json::Map<String, Value> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), Value::String(v.to_str().unwrap_or("").to_string())))
        .collect();

    // 只读 max_bytes + 1 探测字节：超大响应不会整包进内存
    let mut buf: Vec<u8> = Vec::new();
    std::io::Read::by_ref(&mut resp)
        .take((max_bytes as u64) + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("failed to read response body: {e}"))?;
    let truncated = buf.len() > max_bytes;
    if truncated {
        buf.truncate(max_bytes);
    }

    let (output, encoding) = if is_textual_content_type(&content_type) {
        (String::from_utf8_lossy(&buf).to_string(), "utf-8")
    } else {
        (
            base64::engine::general_purpose::STANDARD.encode(&buf),
            "base64",
        )
    };

    Ok(json!({
        "output": output,
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or(""),
        "ok": status.is_success(),
        "url": final_url,
        "contentType": content_type,
        "headers": response_headers,
        "totalBytes": declared_total.unwrap_or(buf.len() as u64),
        "truncated": truncated,
        "encoding": encoding,
    }))
}

/* ------------------------------- 屏幕截图 ------------------------------- */

const SCREENSHOT_DEFAULT_MAX_DIM: u32 = 1920;
const SCREENSHOT_DEFAULT_QUALITY: u32 = 70;
/// 内联预算：sidecar 闸门是解码后 2MiB=2097152 字节（image-parts.ts
/// IMAGE_INLINE_MAX_BYTES），此处留 ~0.3MB 余量；压不进预算则交给闸门降级占位
const SCREENSHOT_INLINE_BUDGET_BYTES: usize = 1_800_000;

fn clamp_u32(v: Option<u64>, default: u32, min: u32, max: u32) -> u32 {
    v.map(|x| x.clamp(min as u64, max as u64) as u32)
        .unwrap_or(default)
}

/// 压缩重试阶梯：首档按用户请求值，随后同尺寸降质两档、再逐级缩尺寸。
/// Retina 全屏 PNG 常 3-8MB，光降质不够，尺寸才是主因，故末档压到 1024。
/// 抽成纯函数便于单测拼参逻辑（不触真截图）。
fn build_screenshot_ladder(max_dim: u32, quality: u32) -> Vec<(u32, u32)> {
    let mut ladder = vec![(max_dim, quality)];
    for q in [quality.saturating_sub(15), quality.saturating_sub(30)] {
        let q = q.max(35);
        if ladder.last().map_or(true, |&(_, last_q)| q != last_q) {
            ladder.push((max_dim, q));
        }
    }
    let mid_q = quality.min(60).max(45);
    for d in [1600u32, 1280, 1024] {
        if d < max_dim {
            ladder.push((d, mid_q));
        }
    }
    ladder
}

/// sips 参数：-Z 把最长边缩到 max_dim；format jpeg；formatOptions 质量 0-100
#[cfg(target_os = "macos")]
fn sips_args(max_dim: u32, quality: u32, input: &str, output: &str) -> Vec<String> {
    vec![
        "-Z".into(),
        max_dim.to_string(),
        "-s".into(),
        "format".into(),
        "jpeg".into(),
        "-s".into(),
        "formatOptions".into(),
        quality.to_string(),
        input.into(),
        "--out".into(),
        output.into(),
    ]
}

/// 尽力读取 jpg 尺寸（sips -g），失败回 0——仅供 alt 文案，不影响成图
#[cfg(target_os = "macos")]
fn query_dims_macos(path_s: &str) -> (u32, u32) {
    let mut c = Command::new("sips");
    c.args(["-g", "pixelWidth", "-g", "pixelHeight", path_s]);
    no_window(&mut c);
    let out = match c.output() {
        Ok(o) if o.status.success() => o,
        _ => return (0, 0),
    };
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    let grab = |key: &str| {
        s.lines()
            .find_map(|l| {
                l.trim()
                    .strip_prefix(key)
                    .and_then(|rest| rest.trim_start_matches(':').trim().parse::<u32>().ok())
            })
            .unwrap_or(0)
    };
    (grab("pixelWidth"), grab("pixelHeight"))
}

#[cfg(target_os = "macos")]
fn capture_macos(
    max_dim: u32,
    quality: u32,
    png_s: &str,
    jpg_s: &str,
) -> Result<Value, String> {
    use base64::Engine as _;

    // 1) 静默全屏抓无损 PNG，压缩交给下一步 sips
    let mut cap = Command::new("screencapture");
    cap.args(["-x", png_s]);
    no_window(&mut cap);
    let cap_out = cap
        .output()
        .map_err(|e| format!("failed to launch screencapture: {e}"))?;
    if !cap_out.status.success() {
        return Err(format!(
            "screencapture failed: {}",
            String::from_utf8_lossy(&cap_out.stderr).trim()
        ));
    }
    // 2) 阶梯压缩，命中预算即止；全超预算则取当前最小产出交给闸门降级
    let mut best: Option<Vec<u8>> = None;
    for (dim, q) in build_screenshot_ladder(max_dim, quality) {
        let mut conv = Command::new("sips");
        conv.args(sips_args(dim, q, png_s, jpg_s));
        no_window(&mut conv);
        let conv_out = match conv.output() {
            Ok(o) if o.status.success() => o,
            _ => continue,
        };
        let _ = conv_out;
        let bytes = match std::fs::read(jpg_s) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let take = best.as_ref().map_or(true, |b| bytes.len() < b.len());
        if take {
            best = Some(bytes);
        }
        if best.as_ref().map_or(false, |b| b.len() <= SCREENSHOT_INLINE_BUDGET_BYTES) {
            break;
        }
    }
    let bytes = best.ok_or("screenshot produced no output (sips failed at every tier)")?;
    let (width, height) = query_dims_macos(jpg_s);
    Ok(json!({
        "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mimeType": "image/jpeg",
        "bytes": bytes.len(),
        "width": width,
        "height": height,
    }))
}

/// 阶梯序列化成脚本内联的 JSON：与 macOS 分支共用同一份 build_screenshot_ladder，
/// 免得两边各写一套压缩策略日后走偏
fn screenshot_ladder_json(max_dim: u32, quality: u32) -> String {
    let tiers: Vec<Value> = build_screenshot_ladder(max_dim, quality)
        .into_iter()
        .map(|(d, q)| json!({ "d": d, "q": q }))
        .collect();
    serde_json::to_string(&tiers).unwrap_or_else(|_| "[]".to_string())
}

/// Windows 全屏截图：PowerShell 5.1 + System.Drawing。
///
/// 与 macOS 分支同样的做法——外壳调系统工具，而不是给宿主引入图像编解码依赖
/// （Cargo.toml 里没有 image/wic crate，Rust 侧无法缩放重编码）。区别在于压缩
/// 阶梯在脚本内一次做完：System.Drawing 自带 JPEG 编码器，脚本自己走阶梯、
/// 命中预算就停，stdout 吐一行 JSON，本函数原样解析。
///
/// 两个 Windows 特有的坑：
/// - DPI 感知：HiDPI 缩放下不先 SetProcessDPIAware，VirtualScreen 与
///   CopyFromScreen 会按逻辑像素工作，抓出来是错尺寸的半分辨率图
/// - 临时文件：整条链路在内存里（Bitmap → MemoryStream），不落盘，无需清理
///
/// 不加 #[cfg(windows)]：函数体只是按名字拉起一个可执行文件，在任何平台都能编译。
/// 加了门控就意味着这段代码只在 Windows 上被编译过——本机（macOS）的
/// cargo test / clippy 会完全跳过它，成了无人验证的盲区。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn capture_windows(max_dim: u32, quality: u32) -> Result<Value, String> {
    use base64::Engine as _;

    let script = windows_capture_script(&screenshot_ladder_json(max_dim, quality), SCREENSHOT_INLINE_BUDGET_BYTES);
    // -EncodedCommand 收 Base64(UTF-16LE)：绕开引号转义，也绕开 ExecutionPolicy
    // 的文件作用域限制（逐字面量拼一条 -Command 迟早会被路径/引号坑到）
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded,
    ]);
    no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("failed to launch powershell: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            format!("screenshot capture failed (exit {:?})", out.status.code())
        } else {
            format!("screenshot capture failed: {err}")
        });
    }
    // 取最后一行 JSON：脚本里 ConvertTo-Json -Compress 只输出一行，前面若有
    // 别的杂音（警告之类）也不会吃掉真正的结果
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .ok_or("powershell produced no screenshot JSON")?;
    serde_json::from_str(line).map_err(|e| format!("screenshot payload parse failed: {e}"))
}

/// 抓图脚本。`tiers_json` 是 build_screenshot_ladder 的序列化结果（只含整数，
/// 不存在注入面）；`budget` 是命中即停的内联预算字节数。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_capture_script(tiers_json: &str, budget: usize) -> String {
    // 单引号字面量：tiers_json 自身不含单引号
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KovaDpi {{ [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }}'
[void][KovaDpi]::SetProcessDPIAware()

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($vs.Width -le 0 -or $vs.Height -le 0) {{ throw 'virtual screen has no area' }}
$full = New-Object System.Drawing.Bitmap -ArgumentList $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($full)
try {{
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $full.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
}} finally {{ $g.Dispose() }}

$tiers = ConvertFrom-Json '{tiers_json}'
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {{ $_.MimeType -eq 'image/jpeg' }}
if ($null -eq $codec) {{ throw 'no JPEG encoder available' }}
$best = $null
foreach ($t in $tiers) {{
  $dim = [int]$t.d
  $scale = [Math]::Min(1.0, $dim / [double][Math]::Max($full.Width, $full.Height))
  $w = [int][Math]::Max(1, [Math]::Round($full.Width * $scale))
  $h = [int][Math]::Max(1, [Math]::Round($full.Height * $scale))
  $bmp = $null
  $ms = $null
  try {{
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    try {{
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g2.DrawImage($full, (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h))
    }} finally {{ $g2.Dispose() }}
    $enc = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
    $enc.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$t.q)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, $codec, $enc)
    $bytes = $ms.ToArray()
    if ($null -eq $best -or $bytes.Length -lt $best.bytes.Length) {{
      $best = [pscustomobject]@{{ bytes = $bytes; width = $w; height = $h }}
    }}
  }} finally {{
    if ($null -ne $ms) {{ $ms.Dispose() }}
    if ($null -ne $bmp) {{ $bmp.Dispose() }}
  }}
  if ($null -ne $best -and $best.bytes.Length -le {budget}) {{ break }}
}}
if ($null -eq $best) {{ throw 'screenshot produced no output at every tier' }}
$full.Dispose()
@{{
  base64 = [Convert]::ToBase64String($best.bytes)
  mimeType = 'image/jpeg'
  bytes = $best.bytes.Length
  width = $best.width
  height = $best.height
}} | ConvertTo-Json -Compress
}} catch {{
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}}
"#
    )
}

fn handle_screenshot(p: &Value) -> Result<Value, String> {
    let max_dim = clamp_u32(p.get("maxDim").and_then(|v| v.as_u64()), SCREENSHOT_DEFAULT_MAX_DIM, 640, 3840);
    let quality = clamp_u32(p.get("quality").and_then(|v| v.as_u64()), SCREENSHOT_DEFAULT_QUALITY, 30, 100);
    #[cfg(target_os = "macos")]
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("pi-shot-{}-{}", std::process::id(), stamp));
        let png = base.with_extension("png");
        let jpg = base.with_extension("jpg");
        let png_s = png.to_string_lossy().to_string();
        let jpg_s = jpg.to_string_lossy().to_string();
        let result = capture_macos(max_dim, quality, &png_s, &jpg_s);
        // 任何退出路径都清临时文件
        let _ = std::fs::remove_file(&png);
        let _ = std::fs::remove_file(&jpg);
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 运行期分派而非 #[cfg(windows)]：让 capture_windows 在本机也参与编译
        if cfg!(target_os = "windows") {
            capture_windows(max_dim, quality)
        } else {
            let _ = (max_dim, quality);
            Err("screenshot is only supported on macOS and Windows in this build".into())
        }
    }
}

/// 工具分发入口（host_query kind="tool"）：params = { name, cwd, params: {...} }。
/// `id` 为该 RPC 请求 id：登记进在飞表后，sidecar 的 host_cancel{id} 可中断长命令
/// （目前只有 bash 有子进程可杀；http 阻塞在 reqwest 里，取消由 JS 侧吞掉响应实现）
pub fn handle_tool(id: &str, p: &Value) -> Result<Value, String> {
    let guard = CancelGuard::new(id);
    let name = str_param(p, "name")?;
    let mut inner = p.get("params").cloned().unwrap_or(Value::Null);
    // read/write/edit 从各自参数里取 cwd 解析相对路径，但工具 schema 不含 cwd，
    // 必须把信封级 cwd 注入 inner，否则相对路径落到了 Rust 进程的工作目录
    if let Some(map) = inner.as_object_mut() {
        map.entry("cwd")
            .or_insert_with(|| p.get("cwd").cloned().unwrap_or(Value::Null));
    }
    // 后台任务的归属线程（sidecar 随信封带；旧版对端不带 → 空，放行）
    let envelope_owner = p
        .get("owner")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match name.as_str() {
        "bash" => {
            let cwd = p.get("cwd").and_then(|v| v.as_str()).unwrap_or(".").to_string();
            let command = str_param(&inner, "command")?;
            // 注入用的明文由 dispatch_host_query 预处理写在信封上（名字走
            // p.secretEnv，见 secret_env.rs）；读出来只喂给这一个派生进程
            let secrets = crate::secret_env::take_resolved(p);
            // 后台模式：立即返回句柄（跨回合存活，不受 host_cancel 影响）
            if inner.get("runInBackground").and_then(|v| v.as_bool()) == Some(true) {
                return run_bash_background(&cwd, &command, &secrets, &envelope_owner);
            }
            let timeout_ms = inner
                .get("timeout")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1_000, MAX_BASH_TIMEOUT_MS))
                .unwrap_or(DEFAULT_BASH_TIMEOUT_MS);
            run_bash(&cwd, &command, timeout_ms, &guard, &secrets)
        }
        // 后台任务查询/终止（配 bash runInBackground）
        "task_output" => handle_task_output(&inner, &envelope_owner),
        "task_stop" => handle_task_stop(&inner, &envelope_owner),
        "read" => handle_read(&inner),
        "write" => handle_write(&inner),
        "edit" => handle_edit(&inner),
        "http" => handle_http(&inner),
        // 屏幕截图（macOS screencapture+sips / Windows PowerShell+System.Drawing
        // 压缩成 JPEG）：见 handle_screenshot
        "screenshot" => handle_screenshot(&inner),
        // 面板浏览器驱动（browser.rs）：导航/快照/尺寸/点击/输入/滚动/后退
        "browser_navigate" | "browser_snapshot" | "browser_resize" | "browser_click"
        | "browser_type" | "browser_scroll" | "browser_back" => {
            crate::browser::run_tool(name.as_str(), &inner, &guard)
        }
        // 页面像素照（browser_shot.rs）：一次性无头 Chrome，相机而非第二个浏览器。
        // 与上面那组互不依赖——没有 Chrome 时这里报错，其余工具照常。
        "browser_shot" => {
            // 不让模型传 URL：它记得的是"自己上次导航到哪"，而用户可能
            // 已经在面板里手动跳走。相机只该对着面板眼前的这一页。
            let url = match inner.get("url").and_then(|v| v.as_str()) {
                Some(u) if !u.trim().is_empty() => u.trim().to_string(),
                _ => crate::browser::current_url(&guard)?,
            };
            let max_dim = inner.get("maxDim").and_then(|v| v.as_u64()).map(|v| v as u32);
            let quality = inner.get("quality").and_then(|v| v.as_u64()).map(|v| v as u32);
            crate::browser_shot::capture(&url, max_dim, quality, &guard)
        }
        _ => Err(format!("unknown host tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_formats_line_numbers_and_pagination() {
        let dir = std::env::temp_dir().join(format!("pi-tool-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.txt");
        std::fs::write(&file, "alpha\nbeta\ngamma\n").unwrap();
        let p = json!({ "file_path": file.to_string_lossy(), "offset": 2, "limit": 1 });
        let out = handle_read(&p).unwrap();
        assert_eq!(out["output"], "2\tbeta\n…[2 more lines, total 4]");
        assert_eq!(out["totalLines"], 4);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn read_rejects_binary() {
        let dir = std::env::temp_dir().join(format!("pi-tool-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("b.bin");
        std::fs::write(&file, [0x61, 0x00, 0x62]).unwrap();
        let p = json!({ "file_path": file.to_string_lossy() });
        assert!(handle_read(&p).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn write_rejects_broken_json_and_keeps_old_file() {
        let dir = std::env::temp_dir().join(format!("pi-tool-jsonguard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("d.canvas.json");
        std::fs::write(&file, r#"{"objects": []}"#).unwrap();
        // write 整档写坏：拒绝，原文件不动
        let p = json!({ "file_path": file.to_string_lossy(), "content": "{\"objects\": [}" });
        assert!(handle_write(&p).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"objects": []}"#);
        // edit 把结构符号吃掉：同样拒绝
        let pe = json!({
            "file_path": file.to_string_lossy(),
            "old_string": "[",
            "new_string": "",
            "replace_all": false
        });
        assert!(handle_edit(&pe).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"objects": []}"#);
        // 合法 JSON 正常通过
        let ok = json!({ "file_path": file.to_string_lossy(), "content": "{\"objects\": []}" });
        assert!(handle_write(&ok).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_creates_parents_and_reports_bytes() {
        let dir = std::env::temp_dir().join(format!("pi-tool-write-{}", std::process::id()));
        let file = dir.join("a/b/c.txt");
        let p = json!({ "file_path": file.to_string_lossy(), "content": "hello" });
        let out = handle_write(&p).unwrap();
        assert_eq!(out["output"], json!(format!("Wrote 5 bytes to {}", file.to_string_lossy())));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bash_runs_and_captures_output() {
        // Windows 下 Git Bash/cmd 都能跑 echo（bash.exe 缺失时回退 cmd.exe）
        let guard = CancelGuard::new("t-run-ok");
        let out = run_bash(".", "echo pi-smoke-bash-ok", 10_000, &guard, &[]).unwrap();
        assert_eq!(out["exitCode"], 0);
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("pi-smoke-bash-ok"), "output: {text}");
        assert!(!text.contains("exit code"), "output: {text}");
    }

    #[test]
    fn bash_timeout_kills_and_reports() {
        // 耗时 >1s 的命令：Windows 用 ping -n 3（Git Bash/cmd 都可用），
        // Unix 用 sleep 2（ping -n 在 BSD/macOS 是不同语义，会立即报错）
        let cmd = if cfg!(windows) { "ping -n 3 127.0.0.1" } else { "sleep 2" };
        let guard = CancelGuard::new("t-timeout");
        let out = run_bash(".", cmd, 300, &guard, &[]).unwrap();
        assert_eq!(out["exitCode"], Value::Null);
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[timeout after"), "output: {text}");
    }

    /// 密钥注入 + 脱敏的端到端（Rust 侧）：注入的明文能被命令读到，
    /// 但回给模型的输出里只有 [REDACTED:NAME]。
    #[test]
    fn bash_injects_secrets_and_redacts_output() {
        let guard = CancelGuard::new("t-secret-inject");
        let secrets = vec![("DEMO_TOKEN".to_string(), "s3cr3t-value-9x".to_string())];
        let cmd = if cfg!(windows) {
            "echo %DEMO_TOKEN%"
        } else {
            "printf %s \"$DEMO_TOKEN\""
        };
        let out = run_bash(".", cmd, 10_000, &guard, &secrets).unwrap();
        assert_eq!(out["exitCode"], 0);
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[REDACTED:DEMO_TOKEN]"), "output: {text}");
        assert!(!text.contains("s3cr3t-value-9x"), "plaintext leaked: {text}");
    }

    /// 未注入时不脱敏（值不在环境里，命令也读不到）——空 secrets 的全量回归
    #[test]
    fn bash_without_secrets_leaves_output_untouched() {
        let guard = CancelGuard::new("t-no-secret");
        let out = run_bash(".", "echo visible-token-abc", 10_000, &guard, &[]).unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("visible-token-abc"), "output: {text}");
        assert!(!text.contains("[REDACTED"), "output: {text}");
    }
    /// 取消在跑的 bash：cancel_tool(id) 置标志 + 杀进程树，run_bash 快速带 [cancelled] 返回
    #[test]
    fn bash_cancel_stops_running_command() {
        let id = "t-cancel-running";
        let guard = CancelGuard::new(id);
        let cmd = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };
        let id_owned = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            cancel_tool(&id_owned);
        });
        let start = Instant::now();
        let out = run_bash(".", cmd, 60_000, &guard, &[]).unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[cancelled]"), "output: {text}");
        assert_eq!(out["cancelled"], json!(true));
        // kill_tree 在三平台都收得掉进程树，取消必须在超时前很久就返回
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "cancel took {:?}",
            start.elapsed()
        );
        // guard 仍存活时不应残留登记？不：登记在 Drop 时注销，这里断言表里已无该 id 的前置
        // ——取消处理对已结束请求必须保持 no-op
    }

    /// 回归：命令派生出**孙进程**并由其持有 stdout 时，取消仍须快速返回。
    /// 旧实现只在 Windows 杀进程树，Unix 上孙进程变孤儿、管道永不 EOF，
    /// 读线程 join 一直阻塞——曾把一次 Chrome 无头截图拖成 135s RPC 超时，
    /// 且孤儿 Chrome 继续占着 SingletonLock 毒化后续所有重试。
    #[test]
    fn bash_cancel_kills_grandchildren_holding_stdout() {
        let id = "t-cancel-grandchild";
        let guard = CancelGuard::new(id);
        // 后台 sleep 是 bash 的子进程、命令的孙进程，且继承 stdout 管道
        let cmd = if cfg!(windows) {
            "start /B ping -n 30 127.0.0.1 & ping -n 30 127.0.0.1"
        } else {
            "sleep 30 & echo started; wait"
        };
        let id_owned = id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            cancel_tool(&id_owned);
        });
        let start = Instant::now();
        let out = run_bash(".", cmd, 60_000, &guard, &[]).unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[cancelled]"), "output: {text}");
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "grandchild kept the pipe open for {:?}",
            start.elapsed()
        );
    }

    /// 超时同理：不靠取消到达，光靠自身超时也必须连孙进程一起收、快速返回
    #[test]
    fn bash_timeout_kills_grandchildren() {
        let guard = CancelGuard::new("t-timeout-grandchild");
        let cmd = if cfg!(windows) {
            "start /B ping -n 30 127.0.0.1 & ping -n 30 127.0.0.1"
        } else {
            "sleep 30 & echo started; wait"
        };
        let start = Instant::now();
        let out = run_bash(".", cmd, 500, &guard, &[]).unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[timeout after"), "output: {text}");
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timeout path blocked for {:?}",
            start.elapsed()
        );
    }

    /// 钉住「真的杀掉了」而不只是「快速返回」：读线程有 2s 兜底上限，光断言
    /// 耗时会漏过「进程还活着、只是不再 join」这种假修复。这里让命令把孙进程
    /// pid 落盘，返回后直接查该 pid 是否还存活。
    #[cfg(unix)]
    #[test]
    fn bash_kill_leaves_no_orphan_process() {
        let pid_file = std::env::temp_dir().join(format!("kova-orphan-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pid_file);
        let guard = CancelGuard::new("t-orphan-check");
        let cmd = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
        let out = run_bash(".", &cmd, 500, &guard, &[]).unwrap();
        assert!(out["output"].as_str().unwrap().contains("[timeout after"));

        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("child pid file")
            .trim()
            .parse()
            .expect("numeric pid");
        // kill(pid, 0) 只做存在性探测：返回 -1 且 ESRCH 即已消失
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        assert!(!alive, "孙进程 {pid} 在超时后仍然存活（进程组没被收掉）");
        let _ = std::fs::remove_file(&pid_file);
    }

    /// 后台任务端到端：启动 → task_output 读到输出与运行态 → task_stop
    /// 杀掉 → 状态收敛为已退出（wait/读者线程均异步，轮询收敛）
    #[cfg(unix)]
    #[test]
    fn background_task_lifecycle_output_and_stop() {
        let started = run_bash_background(".", "echo bg-marker; sleep 30", &[], "thread-a").unwrap();
        let id = started["taskId"].as_u64().unwrap();
        let mut text = String::new();
        for _ in 0..40 {
            text = handle_task_output(&json!({ "taskId": id }), "thread-a").unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string();
            if text.contains("bg-marker") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(text.contains("bg-marker"), "output: {text}");
        assert!(text.contains("[still running]"), "output: {text}");
        let stopped = handle_task_stop(&json!({ "taskId": id }), "thread-a").unwrap();
        assert_eq!(stopped["running"], Value::Bool(false));
        let mut final_text = String::new();
        for _ in 0..40 {
            final_text = handle_task_output(&json!({ "taskId": id }), "thread-a").unwrap()["output"]
                .as_str()
                .unwrap()
                .to_string();
            if !final_text.contains("[still running]") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(final_text.contains("bg-marker"), "output: {final_text}");
        assert!(!final_text.contains("[still running]"), "output: {final_text}");
        // 兜底清理（正常路径上进程已被 task_stop 杀掉）
        let _ = handle_task_stop(&json!({ "taskId": id }), "thread-a");
    }

    /// 归属隔离：任务表全进程共享，别的线程既读不到输出也停不掉进程。
    /// 否则任意会话猜到一个自增小整数 taskId 就能窥探/破坏他人长跑命令。
    #[cfg(unix)]
    #[test]
    fn background_task_is_scoped_to_its_thread() {
        let started =
            run_bash_background(".", "echo owner-marker; sleep 30", &[], "thread-owner").unwrap();
        let id = started["taskId"].as_u64().unwrap();
        // 本线程可读可停
        assert!(handle_task_output(&json!({ "taskId": id }), "thread-owner").is_ok());
        // 别的线程两条路都拒
        let foreign_out = handle_task_output(&json!({ "taskId": id }), "thread-other")
            .expect_err("cross-thread task_output must be rejected");
        assert!(foreign_out.contains("another thread"), "{foreign_out}");
        let foreign_stop = handle_task_stop(&json!({ "taskId": id }), "thread-other")
            .expect_err("cross-thread task_stop must be rejected");
        assert!(foreign_stop.contains("another thread"), "{foreign_stop}");
        // 旧版 sidecar 不带 owner：不得因此把在跑任务变成"查不到"
        assert!(handle_task_output(&json!({ "taskId": id }), "").is_ok());
        let _ = handle_task_stop(&json!({ "taskId": id }), "thread-owner");
    }

    /// spawn 前就已取消：attach_pid 补杀进程树，结果同样报 [cancelled]（竞态窗口回归）
    #[test]
    fn bash_cancel_before_spawn() {
        let id = "t-cancel-early";
        let guard = CancelGuard::new(id);
        cancel_tool(id); // 模拟 host_cancel 先于 bash 启动到达
        let cmd = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };
        let out = run_bash(".", cmd, 60_000, &guard, &[]).unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("[cancelled]"), "output: {text}");
    }

    /// guard Drop 后登记表应清空：cancel_tool 对已完成请求是 no-op
    #[test]
    fn cancel_guard_drops_unregister_entry() {
        let id = "t-cancel-drop";
        {
            let _guard = CancelGuard::new(id);
            assert!(in_flight_tools().lock().unwrap().contains_key(id));
        }
        assert!(!in_flight_tools().lock().unwrap().contains_key(id));
        cancel_tool(id); // 不得 panic
        // 注意：此处不可调用 cancel_all_tools()——它 drain 全局在飞表，会把
        // 并行测试（如 bash_timeout_kills_and_reports）的 guard 一并标记取消，
        // 对方结果带 [cancelled] 而非 [timeout]——既有偶发失败的根源。
    }

    /// 起一个一次性 TCP 服务：收到请求后回写固定 HTTP 响应（无 TLS，http:// 即可）
    fn canned_server(response: &'static [u8]) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::Write;
                let mut buf = [0u8; 2048];
                let _ = std::io::Read::read(&mut stream, &mut buf); // 消费请求头，避免竞态 RST
                let _ = stream.write_all(response);
                let _ = stream.flush();
                std::thread::sleep(std::time::Duration::from_millis(250)); // 等客户端读完
            }
        });
        port
    }

    #[test]
    fn http_get_text_response() {
        let body = b"hello http";
        let resp = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 10\r\n\r\nhello http";
        assert_eq!(&resp[resp.len() - body.len()..], &body[..]);
        let port = canned_server(resp);
        let out = handle_http(&json!({ "url": format!("http://127.0.0.1:{port}/x") })).unwrap();
        assert_eq!(out["output"], "hello http");
        assert_eq!(out["status"], 200);
        assert_eq!(out["ok"], true);
        assert_eq!(out["contentType"], "text/plain");
        assert_eq!(out["encoding"], "utf-8");
        assert_eq!(out["truncated"], false);
        assert_eq!(out["totalBytes"], 10);
    }

    #[test]
    fn http_truncates_oversized_body() {
        let big = vec![b'a'; 4096];
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\n\r\n",
            big.len()
        );
        let mut resp = head.into_bytes();
        resp.extend_from_slice(&big);
        let resp: &'static [u8] = Box::leak(resp.into_boxed_slice());
        let port = canned_server(resp);
        let out = handle_http(&json!({
            "url": format!("http://127.0.0.1:{port}/big"),
            "maxResponseBytes": 100,
        }))
        .unwrap();
        assert_eq!(out["truncated"], true);
        assert_eq!(out["totalBytes"], 4096); // content-length 优先
        assert_eq!(out["output"].as_str().unwrap().len(), 100);
    }

    #[test]
    fn http_rejects_bad_url_and_method() {
        assert!(handle_http(&json!({ "url": "ftp://x/y" })).is_err());
        assert!(handle_http(&json!({ "url": "not a url" })).is_err());
        assert!(handle_http(&json!({
            "url": "http://127.0.0.1:1/x", "method": "BREW",
        }))
        .is_err());
    }

    #[test]
    fn textual_content_type_matches_ts_parity() {
        assert!(is_textual_content_type("text/html; charset=utf-8"));
        assert!(is_textual_content_type("application/json"));
        assert!(is_textual_content_type("application/feed+json"));
        assert!(is_textual_content_type("APPLICATION/XML"));
        assert!(!is_textual_content_type("image/png"));
        assert!(!is_textual_content_type("application/octet-stream"));
    }

    #[test]
    fn tool_dispatch_injects_envelope_cwd_for_relative_paths() {
        // 回归：read/write/edit 的参数里没有 cwd，分发入口必须把信封 cwd 注入，
        // 否则相对路径会按 Rust 进程的工作目录解析
        let dir = std::env::temp_dir().join(format!("pi-tool-relcwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rel.txt"), "one\ntwo\n").unwrap();
        let p = json!({
            "name": "read",
            "cwd": dir.to_string_lossy(),
            "params": { "file_path": "rel.txt" },
        });
        let out = handle_tool("t-dispatch", &p).unwrap();
        assert!(out["output"].as_str().unwrap().contains("two"), "output: {}", out["output"]);
        // write 的相对路径同样落在信封 cwd 下
        let w = json!({
            "name": "write",
            "cwd": dir.to_string_lossy(),
            "params": { "file_path": "sub/rel2.txt", "content": "x" },
        });
        handle_tool("t-dispatch-w", &w).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("sub/rel2.txt")).unwrap(), "x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_checks_occurrences() {
        let dir = std::env::temp_dir().join(format!("pi-tool-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("e.txt");
        std::fs::write(&file, "x\ny\nx\n").unwrap();
        let path_str = file.to_string_lossy().to_string();
        // 多处出现且未 replace_all → 报错
        let p = json!({ "file_path": path_str, "old_string": "x", "new_string": "z" });
        assert!(handle_edit(&p).is_err());
        // replace_all
        let p2 = json!({ "file_path": path_str, "old_string": "x", "new_string": "z", "replace_all": true });
        let out = handle_edit(&p2).unwrap();
        assert_eq!(out["output"], json!(format!("Replaced 2 occurrence(s) in {path_str}")));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "z\ny\nz\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn screenshot_ladder_starts_at_request_then_descends() {
        let l = build_screenshot_ladder(1920, 70);
        // 首档 = 用户请求值
        assert_eq!(l[0], (1920, 70));
        // 降质档不低于地板 35；且相邻档不重复
        for &(dim, q) in &l {
            assert!(q >= 35, "quality floor breached: {q}");
            assert!(dim <= 1920);
        }
        assert!(l.windows(2).all(|w| w[0] != w[1]), "no duplicate adjacent tiers");
        // 大尺寸源会引入更小的尺寸档
        assert!(l.iter().any(|&(dim, _)| dim < 1920), "has downsize tier for retina");
    }

    #[test]
    fn screenshot_ladder_small_input_has_no_downsize_tier() {
        // max_dim 已小于阶梯最小值 → 只有降质档，不追加尺寸档
        let l = build_screenshot_ladder(1000, 80);
        assert!(l.iter().all(|&(dim, _)| dim == 1000));
        assert!(l.len() >= 2);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sips_args_encode_format_and_paths() {
        let a = sips_args(1280, 60, "/tmp/in.png", "/tmp/out.jpg");
        let joined = a.join(" ");
        assert!(joined.contains("-Z 1280"));
        assert!(joined.contains("-s format jpeg"));
        assert!(joined.contains("-s formatOptions 60"));
        assert!(joined.contains("/tmp/in.png"));
        assert!(joined.ends_with("--out /tmp/out.jpg"));
    }

    /// 抓图脚本不依赖 Windows 也能验证：断言内联的阶梯/预算真的落进了脚本文本，
    /// 且 format! 的 {{ }} 转义没漏（漏一个会让脚本报语法错，而这段代码在 macOS
    /// 上永远不会执行）
    #[test]
    fn windows_capture_script_embeds_ladder_and_budget() {
        let script = windows_capture_script(&screenshot_ladder_json(1280, 60), 1234);
        assert!(script.contains(r#"[{"d":1280,"q":60},{"d":1280,"q":45},{"d":1280,"q":35},{"d":1024,"q":60}]"#));
        assert!(script.contains("-le 1234"));
        // 转义检查：单花括号在 PowerShell 里是变量插值，成对出现才合法
        assert!(!script.contains("{{"));
        assert!(!script.contains("}}"));
        assert_eq!(
            script.chars().filter(|&c| c == '{').count(),
            script.chars().filter(|&c| c == '}').count()
        );
        // 单引号必须成对，否则 tiers JSON 所在的那条语句会吞掉后面全部
        assert_eq!(script.matches('\'').count() % 2, 0);
    }

    #[test]
    fn windows_ladder_json_matches_shared_ladder() {
        let json = screenshot_ladder_json(1920, 70);
        let parsed: Vec<(u32, u32)> = serde_json::from_str::<Vec<Value>>(&json)
            .unwrap()
            .into_iter()
            .map(|t| {
                (
                    t["d"].as_u64().unwrap() as u32,
                    t["q"].as_u64().unwrap() as u32,
                )
            })
            .collect();
        assert_eq!(parsed, build_screenshot_ladder(1920, 70));
    }
}
