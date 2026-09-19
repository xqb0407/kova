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
use tauri::AppHandle;

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

/// cwd 必须等于前端 workspace-store 里那个目录（canonicalize 后比对），
/// 返回 canonical 根（后续条目都从它出发拼接/校验）。
fn resolve_root(app: &AppHandle, cwd: &str) -> Result<PathBuf, String> {
    let stored = crate::store::kv_get_global(app, "workspace")
        .map_err(|_| "cwd-not-allowed")?
        .filter(|s| !s.is_empty());
    let want = stored.ok_or("cwd-not-allowed")?;
    let a = std::fs::canonicalize(cwd).map_err(|_| "cwd-not-allowed")?;
    let b = std::fs::canonicalize(&want).map_err(|_| "cwd-not-allowed")?;
    if a != b {
        return Err("cwd-not-allowed".into());
    }
    Ok(a)
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

/* ------------------------------ 写命令（右键菜单） ------------------------------ */

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
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            // raw_arg 拼出 explorer 需要的 "/select,<path>" 原样形式；CREATE_NO_WINDOW
            // 防止并发突发控制台窗口
            std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", target.display()))
                .creation_flags(0x0800_0000)
                .spawn()
                .map_err(|_| "reveal-failed")?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("-R")
                .arg(&target)
                .spawn()
                .map_err(|_| "reveal-failed")?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let parent = target.parent().unwrap_or(target.as_path());
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|_| "reveal-failed")?;
        }
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

/// 「我的文件 → 本地」的数据源：无目录任务会话的执行目录（task-workspace，
/// 与 Rust 注入 sidecar 的 PI_TASK_CWD 同源，agent 的文件读写产物都落这里）。
/// 刻意只读且不接收路径参数（目录固定，不引入工作区 fs 那套路径校验面）；
/// dotfiles 不出现在清单里，符号链接按文件呈现不展开。
#[tauri::command]
pub async fn app_file_list(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = tauri::Manager::path(&app)
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?
            .join("task-workspace");
        let rd = match std::fs::read_dir(&root) {
            Ok(rd) => rd,
            // 目录还没建（从未跑过无目录任务）＝ 空清单而非错误
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(json!({ "entries": Vec::<Value>::new() }));
            }
            Err(e) => return Err(format!("read_dir {}: {e}", root.display())),
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

/// 「我的文件」宫格预览：name 限 task-workspace 顶层的直接文件项（拒路径段）。
/// 图片（≤8MB）返回 base64 + mime（前端 data URL 喂 <img>，CSP img-src 已含
/// data:）；文本类返回前 32KB 的 utf8 文本（前端做渐隐截断）；其余返回
/// unsupported，前端回退类型图标瓦片。
#[tauri::command]
pub async fn app_file_preview(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if is_bad_name(&name) {
            return Err("bad-name".into());
        }
        let root = tauri::Manager::path(&app)
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?
            .join("task-workspace");
        let path = root.join(&name);
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

/// 「我的文件」删除：name 限 task-workspace 顶层的直接条目（拒路径段，
/// 目录固定不引入路径校验面）。目录递归删；符号链接只删链接本身不跟随。
#[tauri::command]
pub async fn app_file_delete(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if is_bad_name(&name) {
            return Err("bad-name".into());
        }
        let root = tauri::Manager::path(&app)
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?
            .join("task-workspace");
        let path = root.join(&name);
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
