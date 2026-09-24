//! 文件树数据源：workspace 内的单层列目录 + 文件内容读取。
//! 不走第三方 fs 插件（tauri_plugin_fs 权限粒度是全局 path glob，难以钉死在
//! workspace），也不复用 git.rs 的 resolve_workspace（那个绑定了 ensure_git，
//! 文件树不应依赖 git 可用性）。
//!
//! 安全约束（与 git.rs 同款）：
//! - cwd 必须与 workspace-store（kv "workspace"）canonicalize 后一致；
//! - dir/path 只能是 workspace 相对路径：拒绝绝对段与 `..`，目标已存在时
//!   再 canonicalize 校验仍落在根内（挡符号链接逃逸）。
//!
//! 性能约束：
//! - 全部走 spawn_blocking：目录遍历/读盘不在 Tauri 主线程（事件循环）发生；
//! - 列目录不逐项 stat：DirEntry::file_type() 在 Unix 靠 d_type 零额外系统调用，
//!   因此只回传 name+dir，不带 size/mtime（IPC 载荷与前端缓存占用最小）；
//!   符号链接按文件呈现、不展开（既省一次 resolve，也杜绝软链成环）；
//! - 条目数封顶 MAX_LIST_ENTRIES（node_modules 级别的巨型目录不全量过 IPC，
//!   渲染层也接不住），截断标志交 UI 提示；
//! - 读文件封顶 MAX_READ_BYTES，用 take 截读，超大文件不会被整体载入内存，
//!   二进制嗅探只采样前 BINARY_SNIFF_BYTES。

use std::io::Read as _;
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Local, SecondsFormat};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager as _};

/// 单次列目录返回条目上限
const MAX_LIST_ENTRIES: usize = 5000;
/// 单文件内容读取上限（字节）
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
/// 二进制嗅探采样字节数
const BINARY_SNIFF_BYTES: usize = 8192;
/// 原始字节预览读取上限（字节）：base64 过 IPC 体积再 ×4/3，图片超限不如不去预览
const MAX_PREVIEW_BYTES: usize = 20 * 1024 * 1024;
/// 列目录跳过的第三方巨树目录（条目常达十万级，过 IPC 只有害处）
const SKIP_DIRS: &[&str] = &[".git", "node_modules"];

/* ------------------------------ 路径守卫 ------------------------------ */

/// cwd 必须命中两个可信根之一（canonicalize 后比对），返回 canonical 根：
///   1. 前端 workspace-store 里选中的工作区；
///   2. app 数据目录下的 task-workspace —— 无目录任务会话（PI_TASK_CWD）的落盘点，
///      UI 插件面板在没有工作区时也以它为 cwd（否则"工作"模式下插件完全不可用）。
fn resolve_root(app: &AppHandle, cwd: &str) -> Result<PathBuf, String> {
    let stored = crate::store::kv_get_global(app, "workspace")
        .map_err(|_| "cwd-not-allowed")?
        .filter(|s| !s.is_empty());
    let a = std::fs::canonicalize(cwd).map_err(|_| "cwd-not-allowed")?;
    if let Some(want) = stored {
        if let Ok(b) = std::fs::canonicalize(&want) {
            if a == b {
                return Ok(a);
            }
        }
    }
    // 第二个可信根：任务工作区（与 pi_agent.rs 注入的 PI_TASK_CWD 同一路径）
    if let Ok(dir) = app.path().app_data_dir() {
        let task = dir.join("task-workspace");
        if let Ok(t) = std::fs::canonicalize(&task) {
            if a == t {
                return Ok(a);
            }
        }
    }
    Err("cwd-not-allowed".into())
}

/// 校验相对段并入根。root 已是 canonical；目标存在时再 canonical 一次，
/// 确认没有被符号链接带出根外。
fn join_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("bad-path".into());
    }
    let joined = root.join(p);
    if let Ok(can) = std::fs::canonicalize(&joined) {
        if !can.starts_with(root) {
            return Err("bad-path".into());
        }
    }
    Ok(joined)
}

/* ------------------------------ 命令 ------------------------------ */

/// 列 dir（workspace 相对路径，"" = 根）一层条目：目录在前、同类忽略大小写排序。
#[tauri::command]
pub async fn fs_list_dir(app: AppHandle, cwd: String, dir: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &dir)?;
        let rd = std::fs::read_dir(&target).map_err(|_| "not-a-directory")?;

        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        let mut truncated = false;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if dirs.len() + files.len() >= MAX_LIST_ENTRIES {
                truncated = true;
                break;
            }
            let is_dir = matches!(e.file_type(), Ok(t) if t.is_dir());
            if is_dir {
                dirs.push(name);
            } else {
                files.push(name);
            }
        }
        let by_name = |a: &String, b: &String| {
            a.to_lowercase().cmp(&b.to_lowercase()).then(a.cmp(b))
        };
        dirs.sort_by(by_name);
        files.sort_by(by_name);
        let entries: Vec<Value> = dirs
            .into_iter()
            .map(|name| json!({ "name": name, "dir": true }))
            .chain(files.into_iter().map(|name| json!({ "name": name, "dir": false })))
            .collect();
        Ok(json!({ "entries": entries, "truncated": truncated }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 读 workspace 相对路径的文件内容（UTF-8 lossy），带截断/二进制标志。
#[tauri::command]
pub async fn fs_read_file(app: AppHandle, cwd: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        let mut f = std::fs::File::open(&target).map_err(|_| "read-failed")?;
        // take 封顶：不把超限文件整体读进内存（多读 1 字节用于判截断）
        let mut bytes: Vec<u8> = Vec::new();
        f.by_ref()
            .take((MAX_READ_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "read-failed")?;
        let truncated = bytes.len() > MAX_READ_BYTES;
        if truncated {
            bytes.truncate(MAX_READ_BYTES);
        }
        let sniff = bytes.len().min(BINARY_SNIFF_BYTES);
        if bytes[..sniff].contains(&0u8) {
            return Ok(json!({ "content": "", "truncated": truncated, "binary": true }));
        }
        let mut s = String::from_utf8_lossy(&bytes).to_string();
        if truncated {
            // 截断点可能劈开多字节字符（lossy 已替换，这里退到行首更干净）
            match s.rfind('\n') {
                Some(idx) if idx > s.len() / 2 => s.truncate(idx),
                _ => {}
            }
        }
        Ok(json!({ "content": s, "truncated": truncated, "binary": false }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 读文件原始字节并以 base64 返回（面板图片预览用；不判文本/二进制，字节直传）。
/// 超 MAX_PREVIEW_BYTES 报 too-large，与 fs_read_file 的静默截断语义不同：
/// 图片截半不如整张不显示。
#[tauri::command]
pub async fn fs_read_file_base64(
    app: AppHandle,
    cwd: String,
    path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        let f = std::fs::File::open(&target).map_err(|_| "read-failed")?;
        let len = f.metadata().map_err(|_| "read-failed")?.len() as usize;
        if len > MAX_PREVIEW_BYTES {
            return Err("too-large".into());
        }
        let mut bytes: Vec<u8> = Vec::with_capacity(len);
        f.take((MAX_PREVIEW_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "read-failed")?;
        Ok(json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "size": bytes.len(),
        }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/* ------------------------------ 写命令（右键菜单 + 面板文档） ------------------------------ */

/// 写文件内容（workspace 相对路径，base64 字节）：UI 插件面板的文档保存通道。
/// 父目录自动创建（面板可把图片资产写进 `<doc>-assets/` 子目录）；超限报
/// too-large；路径守卫与读命令同款（cwd 信任 + 相对段 + canonicalize 防逃逸）。
/// 覆盖写（truncate 语义）——写权交给调用方（前端桥已做权限门控与 rev 协商）。
const MAX_WRITE_BYTES: usize = 32 * 1024 * 1024;

#[tauri::command]
pub async fn fs_write_file(
    app: AppHandle,
    cwd: String,
    path: String,
    base64: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64.trim())
            .map_err(|_| "bad-base64")?;
        if bytes.len() > MAX_WRITE_BYTES {
            return Err("too-large".into());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "write-failed")?;
        }
        // 目标若已存在且是目录，write 自然失败 → write-failed
        std::fs::write(&target, &bytes).map_err(|_| "write-failed")?;
        Ok(json!({ "ok": true, "size": bytes.len() }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 新建目录（workspace 相对路径，父目录一并创建；已存在报 already-exists）。
#[tauri::command]
pub async fn fs_mkdir(app: AppHandle, cwd: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        if target.symlink_metadata().is_ok() {
            return Err("already-exists".into());
        }
        std::fs::create_dir_all(&target).map_err(|_| "mkdir-failed")?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 新建空文件（create_new 语义：已存在报 already-exists，不截断不覆盖）。
#[tauri::command]
pub async fn fs_touch(app: AppHandle, cwd: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        let r = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target);
        match r {
            Ok(_) => Ok(json!({ "ok": true })),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err("already-exists".into()),
            Err(_) => Err("write-failed".into()),
        }
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 重命名：只在原父目录内改名（new_name 必须是纯名字，目标已存在报 already-exists）。
#[tauri::command]
pub async fn fs_rename(
    app: AppHandle,
    cwd: String,
    path: String,
    new_name: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        if is_bad_name(&new_name) {
            return Err("bad-name".into());
        }
        let parent = target.parent().ok_or("bad-path")?;
        let dest = parent.join(&new_name);
        if dest.symlink_metadata().is_ok() {
            return Err("already-exists".into());
        }
        std::fs::rename(&target, &dest).map_err(|_| "rename-failed")?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 删除文件/目录（目录递归；根不可删）。永久删除不进回收站，UI 侧负责确认。
#[tauri::command]
pub async fn fs_delete(app: AppHandle, cwd: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        if target == root {
            return Err("bad-path".into());
        }
        let meta = std::fs::symlink_metadata(&target).map_err(|_| "not-found")?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&target).map_err(|_| "delete-failed")?;
        } else {
            std::fs::remove_file(&target).map_err(|_| "delete-failed")?;
        }
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 在系统文件管理器中呈现目标：open_dir=true 直接打开目录本身（「打开
/// 文件夹」语义），false 显示并选中该项（目录/文件均可）。Windows explorer
/// 需 raw_arg 拼 "/select,<path>" 原样形式，CREATE_NO_WINDOW 防控制台闪现；
/// Linux 无统一"选中"语义，文件退化为打开父目录。
fn reveal_in_file_manager(target: &Path, open_dir: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        let arg = if open_dir {
            format!("\"{}\"", target.display())
        } else {
            format!("/select,\"{}\"", target.display())
        };
        std::process::Command::new("explorer")
            .raw_arg(arg)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|_| "reveal-failed")?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if !open_dir {
            cmd.arg("-R");
        }
        cmd.arg(target).spawn().map_err(|_| "reveal-failed")?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if open_dir {
            target
        } else {
            target.parent().unwrap_or(target.as_path())
        };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|_| "reveal-failed")?;
    }
    Ok(())
}

/// 在系统文件管理器中显示（Windows 资源管理器选中该项；macOS open -R；
/// Linux 无统一"选中"语义，退化为打开父目录）。
#[tauri::command]
pub async fn fs_reveal(app: AppHandle, cwd: String, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_root(&app, &cwd)?;
        let target = join_rel(&root, &path)?;
        if !target.exists() {
            return Err("not-found".into());
        }
        reveal_in_file_manager(&target, false)?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 文件/目录名的单段合法性（不含路径分隔符与 Windows 保留字符）。
fn is_bad_name(name: &str) -> bool {
    name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
}

/* ------------------------------ 我的文件：AI 产物 ------------------------------ */

/// 「我的文件」根目录：app_data/task-workspace（无目录任务会话的执行目录，
/// 与注入 sidecar 的 PI_TASK_CWD 同源）。
fn app_task_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    tauri::Manager::path(app)
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))
        .map(|p| p.join("task-workspace"))
}

/// 「我的文件 → 本地」的数据源：无目录任务会话的执行目录（task-workspace，
/// 与 Rust 注入 sidecar 的 PI_TASK_CWD 同源，agent 的文件读写产物都落这里）。
/// rel 为根内相对路径（"" = 根），支持逐层下钻；校验复用 join_rel（拒 `..`
/// 与绝对路径，canonicalize 防符号链接逃逸）。dotfiles 不出现在清单里，
/// 符号链接按文件呈现不展开。
#[tauri::command]
pub async fn app_file_list(app: tauri::AppHandle, rel: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app_task_workspace_root(&app)?;
        let target = join_rel(&root, &rel)?;
        let rd = match std::fs::read_dir(&target) {
            Ok(rd) => rd,
            // 目录还没建（从未跑过无目录任务）＝ 空清单而非错误
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({ "entries": Vec::<Value>::new() }));
            }
            Err(e) => return Err(format!("read_dir {}: {e}", target.display())),
        };
        let mut out: Vec<Value> = Vec::new();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            let is_dir = ft.is_dir();
            let meta = e.metadata().ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| DateTime::<Local>::from(t).to_rfc3339_opts(SecondsFormat::Secs, false));
            out.push(json!({
                "name": name,
                "dir": is_dir,
                // 目录不递归算体积，恒 0（前端显示 "—"）
                "size": if is_dir { 0 } else { meta.map(|m| m.len()).unwrap_or(0) },
                "modified": modified,
            }));
        }
        out.sort_by_key(|v| {
            (
                !v["dir"].as_bool().unwrap_or(false),
                v["name"].as_str().unwrap_or("").to_lowercase(),
            )
        });
        Ok(json!({ "entries": out }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 「我的文件」宫格预览：rel 限 task-workspace 根内相对路径（子目录文件可
/// 直接预览，路径守卫同 app_file_list）。
/// 图片（≤8MB）返回 base64 + mime（前端 data URL 喂 <img>，CSP img-src 已含
/// data:）；文本类返回前 32KB 的 utf8 文本（前端做渐隐截断）；其余返回
/// unsupported，前端回退类型图标瓦片。
#[tauri::command]
pub async fn app_file_preview(app: tauri::AppHandle, rel: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app_task_workspace_root(&app)?;
        let path = join_rel(&root, &rel)?;
        if !path.is_file() {
            return Err("not-a-file".into());
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        const IMAGE_MIME: &[(&str, &str)] = &[
            ("png", "image/png"),
            ("jpg", "image/jpeg"),
            ("jpeg", "image/jpeg"),
            ("gif", "image/gif"),
            ("webp", "image/webp"),
            ("bmp", "image/bmp"),
            ("svg", "image/svg+xml"),
        ];
        if let Some((_, mime)) = IMAGE_MIME.iter().find(|(e, _)| *e == ext) {
            const MAX_IMAGE: u64 = 8 * 1024 * 1024;
            let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if len > MAX_IMAGE {
                return Ok(json!({ "kind": "unsupported" }));
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            use base64::Engine as _;
            return Ok(json!({
                "kind": "image",
                "mime": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }));
        }
        const TEXT_EXTS: &[&str] = &[
            "md", "txt", "json", "csv", "ts", "tsx", "js", "jsx", "py", "rs", "go", "html",
            "css", "sh", "toml", "yaml", "yml", "log", "xml",
        ];
        // HTML 单独成类：前端用 iframe srcDoc 渲染成页面（而非文本查看）。
        // 上限 1MB——srcDoc 无法解析相对资源，超大文件截断读前 1MB（残页可看）。
        if matches!(ext.as_str(), "html" | "htm") {
            const MAX_HTML: u64 = 1024 * 1024;
            let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if len <= MAX_HTML {
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                return Ok(json!({ "kind": "html", "text": String::from_utf8_lossy(&bytes) }));
            }
            let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; MAX_HTML as usize];
            let n = std::io::Read::read(&mut f, &mut buf).map_err(|e| e.to_string())?;
            buf.truncate(n);
            return Ok(json!({ "kind": "html", "text": String::from_utf8_lossy(&buf) }));
        }
        if TEXT_EXTS.contains(&ext.as_str()) {
            const PREVIEW_BYTES: usize = 32 * 1024;
            let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; PREVIEW_BYTES];
            let n = std::io::Read::read(&mut f, &mut buf).map_err(|e| e.to_string())?;
            buf.truncate(n);
            return Ok(json!({ "kind": "text", "text": String::from_utf8_lossy(&buf) }));
        }
        Ok(json!({ "kind": "unsupported" }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 「我的文件」删除：rel 限 task-workspace 根内相对路径（路径守卫同
/// app_file_list；根本身不可删）。目录递归删；符号链接只删链接本身不跟随。
#[tauri::command]
pub async fn app_file_delete(app: tauri::AppHandle, rel: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app_task_workspace_root(&app)?;
        let path = join_rel(&root, &rel)?;
        if path == root {
            return Err("bad-path".into());
        }
        // symlink_metadata 不跟随链接：目录符号链接按文件处理，绝不递归进目标
        let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("stat: {e}"))?;
        if meta.is_symlink() {
            std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
        } else if meta.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| format!("remove_dir: {e}"))?;
        } else {
            std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
        }
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/// 「我的文件」在系统文件管理器中打开/显示：目录直接打开该目录，文件在其
/// 所在目录中选中显示。路径守卫同 app_file_list。
#[tauri::command]
pub async fn app_file_reveal(app: tauri::AppHandle, rel: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app_task_workspace_root(&app)?;
        let target = join_rel(&root, &rel)?;
        if !target.exists() {
            return Err("not-found".into());
        }
        reveal_in_file_manager(&target, target.is_dir())?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}

/* ------------------------------ 文档附件中转 ------------------------------ */

/// 中转目录的积累控制。参考 ZCode（cli/image-cache/sess_<id>/，内容 hash 命名、
/// 归入 toolOutputs 清理类别）：
/// - 目录按线程分（attachments/<threadId>/），将来清会话可整目录带走
/// - 文件名 = 内容 SHA-256（前端算）：同一份文档反复粘贴只存一份
/// - 保留天数用户可配（通用设置，kv "attachments.retentionDays"，0 = 不清理），
///   默认 7 天；目录总量另有 256MB 硬顶（仅在有清理策略时生效），超限删最旧
const ATTACHMENT_STAGE_MAX_BYTES: usize = 24 * 1024 * 1024;
const ATTACHMENT_STAGE_MAX_TOTAL: u64 = 256 * 1024 * 1024;
const ATTACHMENT_RETENTION_KV_KEY: &str = "attachments.retentionDays";
const ATTACHMENT_RETENTION_DEFAULT_DAYS: u64 = 7;

/// 文件名消毒（与 sidecar 同语义）：取 basename、去控制字符；空/点名回退
fn sanitize_attachment_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "document".into();
    }
    trimmed.chars().take(120).collect()
}

/// threadId 消毒：只留字母数字下划线连字符（目录名拼接，防路径穿越）；
/// 空回退 "misc"，长度截 80
fn sanitize_thread_id(thread_id: &str) -> String {
    let cleaned: String = thread_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(80)
        .collect();
    if cleaned.is_empty() {
        "misc".into()
    } else {
        cleaned
    }
}

/// hash 消毒：只留十六进制字符；空回退 None（调用方退回时间戳命名）
fn sanitize_hash(hash: &str) -> Option<String> {
    let cleaned: String = hash
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(64)
        .collect();
    if cleaned.len() >= 8 {
        Some(cleaned)
    } else {
        None
    }
}

/// 小写扩展名（含点）；无扩展名回退 ".bin"
fn attachment_ext(name: &str) -> String {
    let norm = name.to_lowercase();
    let dot = norm.rfind('.');
    match dot {
        Some(i) if i + 1 < norm.len() && !norm[i + 1..].contains('/') => norm[i..].to_string(),
        _ => ".bin".into(),
    }
}

/// 附件中转目录：app_data/attachments（粘贴的文档唯一副本落这里，prompt 帧
/// 只带路径；sidecar 引用原位不复制）
fn attachment_stage_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(tauri::Manager::path(app)
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("attachments"))
}

/// 保留天数：kv "attachments.retentionDays"（前端通用设置写入）；0 = 不清理
fn attachment_retention_days(app: &tauri::AppHandle) -> Option<u64> {
    match crate::store::kv_get_global(app, ATTACHMENT_RETENTION_KV_KEY) {
        Ok(Some(raw)) => raw.trim().parse::<u64>().ok(),
        _ => Some(ATTACHMENT_RETENTION_DEFAULT_DAYS),
    }
}

/// 中转目录现状收集：递归两层（root 直接文件 = 旧版平铺遗留；root/<tid>/ 文件
/// = 现行布局），返回 (路径, 修改时间, 字节数, 是否目录)
fn collect_stage_entries(root: &Path) -> Vec<(PathBuf, std::time::SystemTime, u64, bool)> {
    let mut out: Vec<(PathBuf, std::time::SystemTime, u64, bool)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            // 线程子目录：只收其下的直接文件
            let Ok(sub) = std::fs::read_dir(e.path()) else { continue };
            for se in sub.flatten() {
                let Ok(smeta) = se.metadata() else { continue };
                if smeta.is_dir() {
                    continue;
                }
                out.push((
                    se.path(),
                    smeta.modified().unwrap_or(std::time::SystemTime::now()),
                    smeta.len(),
                    false,
                ));
            }
        } else {
            out.push((
                e.path(),
                meta.modified().unwrap_or(std::time::SystemTime::now()),
                meta.len(),
                false,
            ));
        }
    }
    out
}

/// 按策略清理中转目录：先删超期文件，再把总量压回上限内（最旧优先），
/// 最后删空的线程目录。days = None/0 时不清理。
fn prune_stage_dir(root: &Path, days: Option<u64>) {
    let Some(days) = days.filter(|d| *d > 0) else { return };
    let now = std::time::SystemTime::now();
    let cutoff = now - std::time::Duration::from_secs(days * 24 * 60 * 60);

    let mut keep: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    for (path, modified, size, _is_dir) in collect_stage_entries(root) {
        if modified < cutoff {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        keep.push((path, modified, size));
    }
    let total: u64 = keep.iter().map(|(_, _, size)| size).sum();
    if total > ATTACHMENT_STAGE_MAX_TOTAL {
        keep.sort_by_key(|(_, modified, _)| *modified);
        let mut acc = total;
        for (path, _, size) in keep {
            if acc <= ATTACHMENT_STAGE_MAX_TOTAL {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                acc = acc.saturating_sub(size);
            }
        }
    }
    // 清掉已空的线程目录（根目录本身的旧版平铺遗留不受影响）
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        if e.file_type().map(|f| f.is_dir()).unwrap_or(false)
            && std::fs::read_dir(e.path()).map(|mut d| d.next().is_none()).unwrap_or(false)
        {
            let _ = std::fs::remove_dir(e.path());
        }
    }
}

/// 中转清理入口：读配置天数 → 清理。启动 / 每小时定时 / 每次 stage 三处触发
pub fn prune_attachments_scheduled(app: &tauri::AppHandle) {
    let days = attachment_retention_days(app);
    let Ok(root) = attachment_stage_root(app) else { return };
    prune_stage_dir(&root, days);
}

/// 前端文档附件中转：把文档字节（裸 base64）按 <threadId>/<hash>.<ext> 写进
/// app_data/attachments/（threadId 分目录 + 内容 hash 去重，同 ZCode 的
/// image-cache 思路），返回绝对路径。prompt 帧只带路径不带字节——请求体与
/// Rust 重放缓冲（16MiB）不被附件撑爆；sidecar 引用原位不复制，agent 直接
/// 用文件工具读取。网页端无本地 FS 不走此命令（内联回退）。
#[tauri::command]
pub async fn attachment_stage(
    app: tauri::AppHandle,
    name: String,
    data_base64: String,
    thread_id: Option<String>,
    hash: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        if data_base64.trim().is_empty() {
            return Err("empty".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64.trim())
            .map_err(|_| "bad-base64".to_string())?;
        if bytes.len() > ATTACHMENT_STAGE_MAX_BYTES {
            return Err("too-large".to_string());
        }
        let root = attachment_stage_root(&app)?;
        let dir = root.join(sanitize_thread_id(thread_id.as_deref().unwrap_or("")));
        std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir: {e}"))?;
        let ext = attachment_ext(&sanitize_attachment_name(&name));
        // 内容 hash 命名：同字节文档反复粘贴只存一份；hash 缺失退回时间戳名
        let fname = match sanitize_hash(hash.as_deref().unwrap_or("")) {
            Some(hex) => format!("{hex}{ext}"),
            None => {
                let d = chrono::Local::now();
                format!(
                    "{}-{}{ext}",
                    d.format("%Y%m%d%H%M%S%3f"),
                    uuid::Uuid::new_v4().simple()
                )
            }
        };
        let path = dir.join(&fname);
        // 已存在 = 同内容同位置：跳过写入（去重），直接复用
        if !path.is_file() {
            std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
        }
        prune_stage_dir(&root, attachment_retention_days(&app));
        Ok(json!({ "path": path.to_string_lossy() }))
    })
    .await
    .map_err(|e| format!("fs task join error: {e}"))?
}
