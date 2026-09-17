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
