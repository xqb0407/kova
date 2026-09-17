//! 真终端（PTY）后端：Windows 走 ConPTY、unix 走 forkpty（portable-pty）。
//! 输出以字节数组经 ipc::Channel 流给前端 xterm.js，空数组 = 子进程退出标记；
//! 输入/缩放/销毁按会话 id 寻址。shell 固定 PowerShell / $SHELL，与
//! tool_exec.rs 的单发命令解析无关（那个服务 agent bash 工具）。
//! webview 刷新/关闭后 channel 失效 → 读线程退出并杀壳，不留孤儿进程。

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

/// 会话表用进程级 static（tool_exec.rs in_flight_tools 同款）：
/// 读线程结束时也要自摘除，State<'_> 进不了 owned 闭包
fn sessions() -> &'static Mutex<HashMap<String, PtyHandle>> {
    static TABLE: OnceLock<Mutex<HashMap<String, PtyHandle>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        return ("powershell.exe".into(), vec!["-NoLogo".into()]);
    }
    match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => (s, Vec::new()),
        _ => ("/bin/bash".into(), Vec::new()),
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(2),
        rows: rows.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn lock_table() -> Result<std::sync::MutexGuard<'static, HashMap<String, PtyHandle>>, String> {
    sessions().lock().map_err(|_| "pty table poisoned".into())
}

#[tauri::command]
pub fn pty_open(
    id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
) -> Result<(), String> {
    // 同 id 已有活会话：先杀掉（前端刷新竞态时的自愈路径）
    if let Some(mut old) = lock_table()?.remove(&id) {
        let _ = old.killer.kill();
    }

    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|e| format!("openpty failed: {e}"))?;
    let (file, args) = default_shell();
    let mut cmd = CommandBuilder::new(&file);
    cmd.args(&args);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.filter(|c| !c.is_empty()) {
        cmd.cwd(dir);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {file} failed: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    {
        let id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF：子进程已退（exit / Ctrl-D）
                    Ok(n) => {
                        // channel 报错 = webview 已刷新/销毁：break 后杀壳回收
                        if on_data.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Ok(mut map) = sessions().lock() {
                map.remove(&id);
            }
            let _ = on_data.send(Vec::new()); // 退出标记（channel 已死则忽略）
        });
    }

    lock_table()?.insert(id, PtyHandle {
        writer,
        master: pair.master,
        killer,
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(id: String, data: String) -> Result<(), String> {
    let mut map = lock_table()?;
    let h = map.get_mut(&id).ok_or("pty session not found")?;
    h.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    h.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let mut map = lock_table()?;
    let h = map.get_mut(&id).ok_or("pty session not found")?;
    h.master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_close(id: String) -> Result<(), String> {
    // 摘除即杀壳：读线程随 EOF 退出；重复 close / 已退出会话静默幂等
    if let Some(mut h) = lock_table()?.remove(&id) {
        let _ = h.killer.kill();
    }
    Ok(())
}
