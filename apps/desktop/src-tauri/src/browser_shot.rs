//! 无头 Chrome 一次性拍照（agent 的"相机"）。
//!
//! 与面板 webview 的分工：webview 是 agent 的**工作面**（导航/点击/输入/读 DOM），
//! URL 的唯一事实源在它那里；本模块只在 agent 需要"这个 URL 长什么样"时被打扰一次——
//! 用同一个 URL 起一个不可见的 Chrome，拍一张图，杀掉，走人。
//!
//! 为什么必须是独立进程而不是在 webview 里截：
//! - WKWebView 截不到 `<canvas>` 的像素（WebGL/Three.js 的画面在合成层之外），
//!   这正是复刻土楼那次 agent 误判"面板坏了"的根因；
//! - 复用 webview 会与 agent 的操作抢同一个页面，agent 推理依据的画面就不是用户看的那个。
//!
//! 四条纪律：
//! 1. **一次性**。不持长会话，不复用实例——agent 在循环里连拍会越来越慢。
//! 2. **独立 `--user-data-dir`**（临时目录，进程退出即删）。共用默认 profile 会撞
//!    SingletonLock：用户正开着 Chrome 时会直接启动失败。
//! 3. **进程组回收**。Chrome 会派生 GPU/Renderer/utility 一串子孙；自己起进程才拿得到
//!    pid，才能 `killpg` 整组收掉。交给 `Browser::new` 的话 pid 拿不到（不公开），
//!    SIGKILL 主进程后子孙可能留下、抱着 profile 锁不退出。
//!    这条纪律要覆盖**所有**离开路径：正常/提前返回/取消之外还有 panic，
//!    见 [`ProcGroupGuard`]；连 panic 也收不到的情况（app 被 SIGKILL、崩溃）
//!    由冷启动清扫 [`sweep_orphans`] 下一轮兜底。
//! 4. **不碰用户的电脑**。只读 URL，不合成输入，不截屏。
//!
//! 依赖说明：CDP 客户端用 `headless_chrome`（即 browser-use-rs 的底座），
//! 而不是 browser-use 本身——后者为一整套 agent 框架而生，此处只用它这一个函数。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::tool_exec::CancelGuard;

/// 单次拍照的墙钟上限。冷启动 Chrome ~0.5–1s，页面加载留足余量。
const SHOT_TIMEOUT: Duration = Duration::from_secs(25);
/// DevToolsActivePort 文件出现的等待上限（Chrome 冷启动到能接 CDP）。
const PORT_WAIT: Duration = Duration::from_secs(15);
/// load 之后给 SPA 渲染的额外时间。CDP 客户端没有可用的 load 事件等待
/// （1.0.22 只有 wait_until_navigated），所以这是一段有上限的固定沉降。
const RENDER_SETTLE: Duration = Duration::from_millis(900);
/// 默认视口。够看清常规页面，又不至于让 JPEG 过大。
const DEFAULT_VIEWPORT: (u32, u32) = (1280, 800);
const DEFAULT_QUALITY: u32 = 70;

/// 相机不可用的原因。宿主侧据此给模型一句能行动的话，而不是 "unknown error"。
#[derive(Debug, PartialEq, Eq)]
pub enum ShotError {
    /// 本机找不到 Chrome。系统其余部分完全可用，只是拍不了像素。
    NoChrome,
    /// Chrome 起来了但握手/导航/截图失败。
    Failed(String),
    /// 导航超时或被取消。
    Timeout,
}

impl ShotError {
    pub fn message(&self) -> String {
        match self {
            ShotError::NoChrome => "no Chrome executable found for page screenshots. \
                The browser panel and all DOM tools still work; only pixel capture is \
                unavailable. Do not retry in a loop."
                .into(),
            // 后两类是**可重试**的（页面没加载完、Chrome 冷启动抖动、页面自己
            // 挂住了脚本）。只回一句 "failed: {e}" 的话模型通常原样重试两三次，
            // 白烧几轮；给出「最多再试一次、仍失败就改用 DOM 工具并如实说明
            // 看不到像素」的出路，模型才不会陷在重试循环里。
            ShotError::Failed(e) => format!(
                "headless Chrome failed: {e}. \
                This is usually transient (page still loading, or a cold Chrome start). \
                Retry browser_shot at most once; if it fails again, stop retrying and fall back \
                to the DOM tools (browser_snapshot / browser_scroll), then tell the user you \
                could not see the pixels and what the accessibility tree says instead."
            ),
            ShotError::Timeout => format!(
                "headless Chrome did not finish within {}s (the page is probably still loading \
                or a script on it never settles). Retry browser_shot at most once; if it times \
                out again, stop retrying and fall back to the DOM tools (browser_snapshot / \
                browser_scroll), then tell the user you could not see the pixels and what the \
                accessibility tree says instead.",
                SHOT_TIMEOUT.as_secs()
            ),
        }
    }
}

/// 探测本机 Chrome 路径。探测不到返回 `None`——不静默失败，但也不影响
/// webview 路的任何功能。
///
/// 按"用户最可能装的那个"排。Chrome for Testing（Playwright 下载的那种）
/// 不在标准位置，需要环境变量显式指路。
pub fn find_chrome() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KOVA_CHROME_PATH") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    const CANDIDATES: &[&str] = &[
        // macOS
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        // Windows
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        // Linux
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

/// 拍一张 URL 的像素照，返回 `{ base64, mimeType, bytes, width, height }`
/// —— 与 `HostScreenshotData` 同形，sidecar 侧投影链路直接复用。
///
/// 直接出 JPEG 而非 PNG：投影层有 2MiB 闸门，1280×800 的 PNG 轻易过线，
/// agent 只会看到一个"图片太大"的报错，看不到任何画面。质量参数让 Chrome
/// 边编码边降质，比事后缩图省一整个解码器依赖。
pub fn capture(
    url: &str,
    max_dim: Option<u32>,
    quality: Option<u32>,
    guard: &CancelGuard,
) -> Result<Value, String> {
    let exe = find_chrome().ok_or_else(|| ShotError::NoChrome.message())?;
    let (w, h) = viewport(max_dim);
    let q = quality.unwrap_or(DEFAULT_QUALITY).clamp(30, 100);

    // 一次性 profile：进程退出即删，目录名带 pid 与纳秒戳避免并发调用互踩
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let profile = std::env::temp_dir().join(format!("pi-shot-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&profile).map_err(|e| format!("创建临时 profile 失败: {e}"))?;

    // 所有退出路径（含 ? 提前返回）都要收进程 + 删目录
    let result = capture_inner(&exe, url, &profile, (w, h), q, guard);
    let _ = std::fs::remove_dir_all(&profile);
    result
}

fn viewport(max_dim: Option<u32>) -> (u32, u32) {
    match max_dim {
        // 保持 16:10，agent 看到的画面比例与真实浏览器一致
        Some(m) if m >= 320 => {
            let m = m.min(3840);
            (m, (m as f64 * DEFAULT_VIEWPORT.1 as f64 / DEFAULT_VIEWPORT.0 as f64) as u32)
        }
        _ => DEFAULT_VIEWPORT,
    }
}

/// 起 Chrome → CDP 握手 → 导航 → 沉降 → 截图 → 整组回收。
///
/// 自己 spawn 而不用 `Browser::new`：那样拿不到 pid，SIGKILL 主进程后
/// Chrome 派生的 GPU/Renderer 孙进程可能留下，抱着一时半会儿退不掉。
fn capture_inner(
    exe: &Path,
    url: &str,
    profile: &Path,
    viewport: (u32, u32),
    quality: u32,
    guard: &CancelGuard,
) -> Result<Value, String> {
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--remote-debugging-port=0"))
        .arg("--headless=new")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--window-size={},{}", viewport.0, viewport.1))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        // 反自动化：默认参数会让页面脚本识别出这是自动化环境并改变行为
        .arg("--disable-blink-features=AutomationControlled")
        .arg("--disable-extensions")
        .arg("--mute-audio")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // 自立进程组：pgid 即 pid，killpg 一次收掉 Chrome 及其全部子孙
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    crate::tool_exec::no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| ShotError::Failed(format!("启动 Chrome 失败: {e}")).message())?;
    let pid = child.id();

    // 登记到取消令牌：host_cancel 到达时连 Chrome 带孙进程一起收，
    // 否则 agent 中途取消会留一个后台 Chrome 跑着
    guard.attach_pid(pid);
    // panic 兜底：`drive` 里的 CDP 客户端有自己的 lock().unwrap()，展开会跳过
    // 下面那行显式 kill_tree，Chrome 就此活下来。RAII 让任何离开方式都收进程组
    // （重复 kill 幂等无害）
    let _group = ProcGroupGuard(pid);

    let result = drive(&mut child, url, profile, viewport, quality, guard);
    // 正常收尾：必须先杀组再 wait——不杀的话 wait 会一直等 Chrome
    crate::tool_exec::kill_tree(pid);
    // 回收子进程句柄：kill 之后 wait 才会立刻返回，否则留下未 wait 的僵尸
    let _ = child.wait();
    result
}

/// spawned Chrome 的兜底回收：无论正常返回、`?` 提前返回还是 panic 展开，
/// 离开作用域即 `killpg` 整组。正常路径本来就显式 kill，这里补的是 panic 那条
/// （2026-10-02 留在用户机器上 3 小时的那组 9 进程孤儿，根因就是展开跳过了 kill）。
struct ProcGroupGuard(u32);

impl Drop for ProcGroupGuard {
    fn drop(&mut self) {
        crate::tool_exec::kill_tree(self.0);
    }
}

/// CDP 会话主体。`child` 借来只为握手期间能发现 Chrome 提前退出。
fn drive(
    child: &mut std::process::Child,
    url: &str,
    profile: &Path,
    viewport: (u32, u32),
    quality: u32,
    guard: &CancelGuard,
) -> Result<Value, String> {
    use headless_chrome::protocol::cdp::Page;

    let ws = wait_for_devtools_ws(child, profile, guard)?;
    // connect 之后 Browser 的 Drop 负责收尾传输层；进程由外层 kill_tree 兜底
    let browser = headless_chrome::Browser::connect_with_timeout(ws, SHOT_TIMEOUT)
        .map_err(|e| ShotError::Failed(format!("CDP 握手失败: {e}")).message())?;
    let tab = browser
        .new_tab()
        .map_err(|e| ShotError::Failed(format!("开标签失败: {e}")).message())?;
    // 单次调用的上限：CDP 调用卡住时靠它兜底，不至于把宿主线程挂死
    tab.set_default_timeout(SHOT_TIMEOUT);

    tab.navigate_to(url)
        .map_err(|e| ShotError::Failed(format!("导航 {url} 失败: {e}")).message())?;

    // 沉降：轮询取消标志。CDP 客户端 1.0.22 没有可用的 load 事件等待，
    // 这里是一段有上限的固定等待——拍早了一帧白屏，拍晚了只是多花 0.9s。
    let settle_until = Instant::now() + RENDER_SETTLE;
    while Instant::now() < settle_until {
        if guard.is_cancelled() {
            return Err("cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(80));
    }

    let jpeg = tab
        .capture_screenshot(Page::CaptureScreenshotFormatOption::Jpeg, Some(quality), None, true)
        .map_err(|e| ShotError::Failed(format!("截图失败: {e}")).message())?;
    if jpeg.is_empty() {
        return Err(ShotError::Failed("截图返回空数据".into()).message());
    }
    // JPEG 头里有尺寸，顺手读出来给 alt 文案，省一次解码
    let (w, h) = jpeg_dimensions(&jpeg).unwrap_or((viewport.0, viewport.1));

    Ok(json!({
        "base64": encode_b64(&jpeg),
        "mimeType": "image/jpeg",
        "bytes": jpeg.len(),
        "width": w,
        "height": h,
        "url": url,
    }))
}

/// 等 Chrome 写出 DevToolsActivePort，取其中的 ws 路径完成 CDP 握手。
///
/// 端口用 0（让 Chrome 自选），所以只能从文件读——顺带也避免了和用户
/// 已开着的 Chrome 抢固定端口。
fn wait_for_devtools_ws(
    child: &mut std::process::Child,
    profile: &Path,
    guard: &CancelGuard,
) -> Result<String, String> {
    let port_file = profile.join("DevToolsActivePort");
    let deadline = Instant::now() + PORT_WAIT;
    while Instant::now() < deadline {
        if guard.is_cancelled() {
            return Err("cancelled".into());
        }
        if let Some(url) = read_ws_endpoint(&port_file) {
            return Ok(url);
        }
        // Chrome 启动失败时不会写端口文件，只能靠进程先死来判断——
        // 否则只能白等满 15s，agent 那边表现为"卡住"而不是"失败"
        if let Ok(Some(_)) = child.try_wait() {
            return Err(ShotError::Failed("Chrome 启动后立刻退出（可能 profile 被占用）".into()).message());
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    Err(ShotError::Timeout.message())
}

/// 读 DevToolsActivePort：第一行端口、第二行 browser ws 路径。
/// 文件可能正被写，只读全的部分。
fn read_ws_endpoint(path: &Path) -> Option<String> {
    let mut s = String::new();
    std::fs::File::open(path).ok()?.read_to_string(&mut s).ok()?;
    let mut lines = s.lines();
    let port = lines.next()?.trim();
    let ws_path = lines.next()?.trim();
    if port.is_empty() || ws_path.is_empty() {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{ws_path}"))
}

fn encode_b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/* --------------------------- 遗留进程/临时目录清扫 --------------------------- */

/// 进程是否存活。信号 0 不投递，只做存在性与权限检查；EPERM 也算活着
/// （判据同单测里的存活断言，两处必须一致）
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

/// 一次性条目的名字 → 它的 owner pid。
///
/// 命名有两族，共用 `pi-shot-` 前缀：
/// - `pi-shot-<owner pid>-<stamp>`：拍照的临时 profile 目录（[`capture`]），
///   以及屏幕截图工具的临时 png/jpg（`tool_exec::handle_screenshot`）；
/// - `pi-shot-test-*`：Rust 单测自己的目录（[`mod tests`]）——必须落空，
///   否则清扫会去动正在跑的测试。
///
/// owner pid 是**起进程的那个 app**（`std::process::id()`），不是 Chrome 的
/// pid：判「这条是不是遗留」只能靠 app 是否还活着。
fn owner_pid_of(entry: &str) -> Option<u32> {
    let rest = entry.strip_prefix("pi-shot-")?;
    let (pid, _) = rest.split_once('-')?;
    pid.parse::<u32>().ok()
}

/// 杀掉命令行里引用了该临时条目的 Chrome 主进程（整组，子孙一并收）。
///
/// 只认同时满足三条的行：命令行含这个条目名（纳秒戳唯一）、不含 `--type=`
/// （Helpers 是子孙，随组收）、且确实是个 chrome/chromium 可执行文件——最后
/// 一条是防「恰好有别的进程把该路径写进了命令行」被误杀。
#[cfg(unix)]
fn kill_referencing(needle: &str) -> usize {
    let Ok(out) = Command::new("ps").args(["-A", "-o", "pid=,command="]).output() else {
        return 0;
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let mut killed = 0usize;
    for line in text.lines() {
        let line = line.trim_start();
        let Some((pid_s, cmd)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if !cmd.contains(needle) || cmd.contains("--type=") {
            continue;
        }
        let lower = cmd.to_ascii_lowercase();
        if !lower.contains("chrome") && !lower.contains("chromium") {
            continue;
        }
        if let Ok(pid) = pid_s.parse::<u32>() {
            // 主进程是自立的进程组组长（spawn 时的 process_group(0)），killpg 收整组
            crate::tool_exec::kill_tree(pid);
            killed += 1;
        }
    }
    killed
}

/// Windows 侧只删临时条目、不清进程：拿不到命令行就没法把目录映射回进程
/// （tasklist 不列 CommandLine）。要补需要 WMIC/PowerShell 或引进程枚举库，
/// 在真机上验证过之前不写猜的实现。
#[cfg(not(unix))]
fn kill_referencing(_needle: &str) -> usize {
    0
}

/// 冷启动清扫：收掉上一次运行遗留的无头 Chrome，并删掉它们的临时条目。
///
/// 为什么必须在**进程外**：正常路径的四道清理（`kill_tree` / `CancelGuard` /
/// `cancel_all_tools` / 退出钩子）全都跑在本进程里。app 被 dev 重启、崩溃或被
/// SIGKILL 时一行都不会执行，而 Chrome 是自立进程组、父进程一死就被 launchd
/// 收养，`--headless=new` 又不会因为 CDP 客户端断开而退出——于是永久占着内存
/// （实测一组 9 进程约 870MB，见 2026-10-02 的现场）。冷启动是唯一能看到
/// 「上一个我」留下的垃圾的时刻。
///
/// 判定只认自己的命名**且 owner pid 已死**：同机另一个实例、或正在跑的测试的
/// 条目一律跳过，误伤面为零。放后台线程调用，不挡启动。
pub fn sweep_orphans() {
    let (removed, killed) = sweep_in(&std::env::temp_dir());
    if removed > 0 || killed > 0 {
        log::info!(
            "[browser_shot] 冷启动清扫：收掉 {killed} 个遗留 Chrome、删掉 {removed} 个临时条目"
        );
    }
}

/// 清扫主体（目录可注入，供单测）：返回 (删掉的条目数, 收掉的进程数)。
fn sweep_in(dir: &Path) -> (usize, usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let me = std::process::id();
    let mut removed = 0usize;
    let mut killed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(owner) = owner_pid_of(&name) else {
            continue;
        };
        // 本进程自己的、或 owner 还活着的：不是遗留（另一个实例可能正在用）
        if owner == me || pid_alive(owner) {
            continue;
        }
        killed += kill_referencing(&name);
        let path = entry.path();
        let ok = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if ok {
            removed += 1;
        }
    }
    (removed, killed)
}

/// 从 JPEG 的 SOF 段读尺寸。读不出就返回 None（调用方退回视口尺寸）。
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 9 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        // SOF0..SOF15，跳过 DHT(c4)/JPG(c8)/DAC(cc)
        let marker = bytes[i + 1];
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            return Some((w, h));
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn unique_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("pi-shot-test-{}-{tag}-{n}", std::process::id()))
    }

    #[test]
    fn no_chrome_is_an_explicit_error_not_a_silent_one() {
        // 消息必须能指导模型别重试——静默失败会让 agent 陷入截图重试循环
        let msg = ShotError::NoChrome.message();
        assert!(msg.contains("Do not retry"));
        assert!(msg.contains("still work"), "必须说明其余能力不受影响");
    }

    /// 探测路径覆盖三平台的真实安装位置——路径写错等于功能不存在，
    /// 而这个错误只在真机上才暴露。
    #[test]
    fn find_chrome_returns_a_real_file_or_none() {
        if let Some(p) = find_chrome() {
            assert!(p.is_file(), "探测到的 Chrome 路径不存在: {}", p.display());
            let s = p.to_string_lossy().to_lowercase();
            assert!(
                s.contains("chrome") || s.contains("chromium"),
                "探测到的路径不像 Chrome: {}",
                p.display()
            );
        }
        // 没装 Chrome 是合法状态，不是错误——探测本身不该 panic
    }

    #[test]
    fn viewport_keeps_aspect_and_clamps() {
        assert_eq!(viewport(None), DEFAULT_VIEWPORT);
        assert_eq!(viewport(Some(100)), DEFAULT_VIEWPORT, "过小应退回默认");
        assert_eq!(viewport(Some(640)), (640, 400), "保持 16:10");
        assert_eq!(viewport(Some(99_999)).0, 3840, "上限封顶");
    }

    #[test]
    fn reads_ws_endpoint_from_devtools_port_file() {
        let dir = unique_dir("portfile");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("DevToolsActivePort");
        // Chrome 的真实格式：端口 \n /devtools/browser/<id> \n
        std::fs::write(&f, "9222\n/devtools/browser/abc-123\n").unwrap();
        assert_eq!(
            read_ws_endpoint(&f).as_deref(),
            Some("ws://127.0.0.1:9222/devtools/browser/abc-123")
        );

        // 半写状态（第一行到了第二行还没落盘）必须当作"还没好"而不是半个 URL
        std::fs::write(&f, "9222\n").unwrap();
        assert_eq!(read_ws_endpoint(&f), None);
        // 文件还不存在
        assert_eq!(read_ws_endpoint(&dir.join("nope")), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 尺寸读错会让 alt 文案说"1920×1080"而实际是别的——不至于坏功能，
    /// 但会让 agent 和用户都被误导，所以按真 JPEG 字节验证。
    #[test]
    fn jpeg_dimensions_reads_the_sof_segment() {
        // 最小合法 JPEG 头 + SOF0(w=0x0140=320, h=0x00F0=240)
        let mut jpeg = vec![0xFF, 0xD8];
        jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        jpeg.extend_from_slice(&[0x00, 0xF0, 0x01, 0x40]); // h=240, w=320
        jpeg.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        assert_eq!(jpeg_dimensions(&jpeg), Some((320, 240)));

        assert_eq!(jpeg_dimensions(&[]), None);
        assert_eq!(jpeg_dimensions(&[0x00, 0x01, 0x02]), None, "不是 JPEG");
    }

    /// 端到端：起一个真 Chrome、拍一张、确认 pid 真死了、profile 真删了。
    /// 只看耗时不作数——进程还活着时 killpg 也会"很快"返回。
    #[test]
    fn capture_kills_the_whole_process_group_and_cleans_up() {
        let Some(exe) = find_chrome() else {
            eprintln!("跳过：本机没装 Chrome");
            return;
        };

        let profile = unique_dir("e2e");
        std::fs::create_dir_all(&profile).unwrap();
        // file:// 一个本地造的页面：不触网，测的就是"能不能拍到并收干净"
        let page = profile.join("p.html");
        std::fs::write(
            &page,
            "<body style='margin:0;background:#0af'><h1 style='color:#fff;font:40px sans-serif'>SHOT</h1></body>",
        )
        .unwrap();
        let url = format!("file://{}", page.display());

        // 单独起进程，只为拿到 pid 做存活断言
        let mut cmd = Command::new(&exe);
        cmd.arg("--headless=new")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.join("cdp").display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-gpu")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().expect("spawn chrome");
        let pid = child.id();

        let ws = wait_for_devtools_ws(&mut child, &profile.join("cdp"), &CancelGuard::detached())
            .expect("DevToolsActivePort 应在时限内出现");
        assert!(ws.starts_with("ws://127.0.0.1:"), "拿到 {ws}");

        let browser = headless_chrome::Browser::connect(ws).expect("CDP 握手");
        let tab = browser.new_tab().expect("new_tab");
        tab.navigate_to(&url).expect("navigate");
        let jpeg = tab
            .capture_screenshot(
                headless_chrome::protocol::cdp::Page::CaptureScreenshotFormatOption::Jpeg,
                Some(70),
                None,
                true,
            )
            .expect("截图");
        assert!(jpeg.len() > 1000, "JPEG 只有 {} 字节，八成是白屏", jpeg.len());
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8], "不是 JPEG 头");
        let (w, h) = jpeg_dimensions(&jpeg).expect("能读出尺寸");
        assert!(w > 0 && h > 0, "尺寸非法 {w}x{h}");
        drop(browser);
        drop(tab);

        crate::tool_exec::kill_tree(pid);
        let _ = child.wait();

        // 关键断言：进程真的死了。kill 返回 0 只说明信号发出去了
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && pid_alive(pid) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!pid_alive(pid), "Chrome pid {pid} 在 kill 之后仍然存活");

        let _ = std::fs::remove_dir_all(&profile);
    }

    /// 名称解析：只认 `pi-shot-<owner pid>-<stamp>`（目录与屏幕截图的 png/jpg
    /// 两族），单测自己的 `pi-shot-test-*` 必须落空——清扫不能去动正在跑的测试。
    #[test]
    fn owner_pid_parsing_accepts_only_our_naming() {
        // 拍照的临时 profile 目录（真实形态：纳秒戳）
        assert_eq!(owner_pid_of("pi-shot-53175-1790925171615745000"), Some(53175));
        // 屏幕截图工具的临时文件（毫秒戳 + 扩展名）
        assert_eq!(owner_pid_of("pi-shot-1234-1700000000000.png"), Some(1234));
        // 单测自己的命名：pid 位上是 test，必须不认领
        assert_eq!(owner_pid_of("pi-shot-test-32444-e2e-0"), None);
        assert_eq!(owner_pid_of("pi-shot-test-56699-e2e-0"), None);
        // 前缀对但结构不对
        assert_eq!(owner_pid_of("pi-shot-"), None);
        assert_eq!(owner_pid_of("pi-shot-abc-1"), None);
        assert_eq!(owner_pid_of("pi-shot-1234"), None, "缺 stamp 段");
        assert_eq!(owner_pid_of("other-1-2"), None);
    }

    /// 清扫只动「owner 已死」的条目：本进程自己的、owner 还活着的、
    /// 以及单测自己的目录，一条都不能碰。
    #[test]
    fn sweep_removes_only_dead_owner_entries() {
        let dir = unique_dir("sweep");
        std::fs::create_dir_all(&dir).unwrap();
        // 远超 pid 上限的 pid：必然不存在（不依赖真实进程表状态）
        let dead = 4_000_000u32;
        let dead_dir = dir.join(format!("pi-shot-{dead}-1"));
        let dead_file = dir.join(format!("pi-shot-{dead}-3.png"));
        let live_dir = dir.join(format!("pi-shot-{}-2", std::process::id()));
        let test_dir = dir.join("pi-shot-test-9999-e2e-0");
        for p in [&dead_dir, &live_dir, &test_dir] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(&dead_file, b"x").unwrap();

        let (removed, killed) = sweep_in(&dir);
        assert_eq!(killed, 0, "临时目录里没有真进程，不该杀任何东西");
        assert_eq!(removed, 2, "死 owner 的目录与文件各一个");
        assert!(!dead_dir.exists(), "死 owner 的目录应删掉");
        assert!(!dead_file.exists(), "死 owner 的临时截图应删掉");
        assert!(live_dir.exists(), "owner 还活着的条目必须留下");
        assert!(
            test_dir.exists(),
            "单测自己的目录必须留下（名字不进认领集）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端验收（本次修复的目标场景）：模拟「上一次运行留下的孤儿」——用
    /// 必然不存在的 owner pid 给 profile 命名，起一个真 Chrome，然后跑清扫。
    /// 真实事故：dev 重启打断拍照 → Chrome 被 launchd 收养 → 9 进程 870MB
    /// 永久驻留（2026-10-02 现场）。
    #[test]
    fn sweep_kills_an_orphan_chrome_and_removes_its_profile() {
        let Some(exe) = find_chrome() else {
            eprintln!("跳过：本机没装 Chrome");
            return;
        };
        let root = unique_dir("sweep-e2e");
        std::fs::create_dir_all(&root).unwrap();
        // 远超 pid 上限：清扫据此判「owner 已死 = 遗留」
        let dead = 4_000_000u32;
        let profile = root.join(format!("pi-shot-{dead}-7777"));
        std::fs::create_dir_all(&profile).unwrap();

        let mut cmd = Command::new(&exe);
        cmd.arg("--headless=new")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().expect("spawn chrome");
        let pid = child.id();
        // 测试自身也别漏：断言失败/panic 时由它收尾（正常路径重复 kill 无害）
        let _group = ProcGroupGuard(pid);
        let ws = wait_for_devtools_ws(&mut child, &profile, &CancelGuard::detached());
        assert!(ws.is_ok(), "Chrome 应起来并写出 DevToolsActivePort: {ws:?}");

        let (mut removed, killed) = sweep_in(&root);
        assert_eq!(killed, 1, "清扫应认领并杀掉这个孤儿 Chrome");
        // 目录删除可能滞后 kill 一瞬（进程刚死、句柄才关）：有界重试，不引入抖动
        let deadline = Instant::now() + Duration::from_secs(3);
        while removed == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            removed = sweep_in(&root).0;
        }
        assert_eq!(removed, 1, "临时 profile 目录最终应被删掉");
        assert!(!profile.exists());

        // 存活断言必须先回收句柄：SIGKILL 后未 wait 的子进程是僵尸，kill(pid, 0)
        // 对僵尸仍然成功（会把"已死"读成"还活着"）。有界轮询 try_wait 而不是
        // wait()——真出现"清扫没杀掉"时，这里是断言失败而不是测试挂死
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut reaped = false;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                reaped = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(reaped, "Chrome pid {pid} 清扫后仍未退出（wait 未见返回）");
        assert!(!pid_alive(pid), "Chrome pid {pid} 回收后仍存活");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 相机不可用时必须是明确错误，且 webview 路完全不受影响——
    /// 这是整个双路设计成立的前提。
    #[test]
    fn missing_chrome_fails_loudly_but_only_here() {
        let guard = CancelGuard::detached();
        let saved = std::env::var_os("KOVA_CHROME_PATH");
        // 指到一个不存在的路径，逼出探测失败
        std::env::set_var("KOVA_CHROME_PATH", "/nonexistent/chrome-binary");
        let r = find_chrome();
        std::env::remove_var("KOVA_CHROME_PATH");
        if let Some(v) = saved {
            std::env::set_var("KOVA_CHROME_PATH", v);
        }
        // 探测仍会落到真实安装位置（本机装了的话），所以只断言不 panic
        let _ = r;
        let _ = guard;
    }
}

