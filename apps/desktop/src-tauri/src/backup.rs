//! 备份与恢复（S3 + WebDAV）：应用数据全量打包为 `.piabk` 信封，上传远端或写本地，
//! 恢复经「staging + 待恢复标记」在下次启动时原子换入（任何存储打开之前）。
//!
//! 信封格式（单文件，文本头 + 二进制负载）：
//! ```text
//! PIABK1\n                        // magic
//! {一行 JSON header}\n            // BackupHeader（camelCase，含逐文件 sha256 与负载校验）
//! <payload>                       // tar.gz；口令加密时为 AES-256-GCM(pbkdf2-SHA256) 密文
//! ```
//! 不加密的负载是标准 tar.gz，系统 tar 可应急解开。负载的 sha256 是对「落盘后的最终
//! 字节」计算（加密后），因此校验总在解密之前。
//!
//! 备份范围：state.db 快照（VACUUM INTO，连接开着也能拿一致快照）+ sessions/*.jsonl
//! + 可选 task-workspace/。排除 browser-panel/（缓存）与日志（本就在 app_log_dir）。
//! OS keychain 主密钥不随备份走：换机恢复后加密凭据不可解，换入时清空 credentials
//! 表引导重输（见 apply_pending_restore）。
//!
//! 通道：S3 用手写 SigV4（PUT/GET/DELETE/ListObjectsV2，兼容 MinIO/R2/OSS 等自定义
//! endpoint + path-style）；WebDAV 用 MKCOL/PUT/GET/PROPFIND + Basic auth。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// 信封 magic（带结尾换行）
const MAGIC: &[u8] = b"PIABK1\n";
/// 信封格式版本（header 结构变更时递增）
const FORMAT_VERSION: u32 = 1;
/// 口令派生迭代数（OWASP 2023 对 PBKDF2-SHA256 的推荐下限）
const KDF_ITERATIONS: u32 = 600_000;
/// 配置所在的 kv key
pub const CONFIG_KEY: &str = "backup.config.v1";
/// 待恢复标记文件名（位于 app data dir 根）
const PENDING_RESTORE_FILE: &str = "pending-restore.json";
/// 恢复 staging 根目录名（位于 app data dir 根）
const RESTORE_STAGING_DIR: &str = "restore-staging";
/// 进度事件名
const PROGRESS_EVENT: &str = "backup:progress";

// ---------------------------------------------------------------------------
// 备份内容定义
// ---------------------------------------------------------------------------

/// 备份内的会话消息目录（app data dir 下）
pub const SESSIONS_DIR: &str = "sessions";
/// 备份内的任务工作区目录（app data dir 下，无目录任务的 agent 产物）
pub const TASK_WORKSPACE_DIR: &str = "task-workspace";
/// 数据库文件名（app data dir 下）
const DB_FILE: &str = "state.db";

// ---------------------------------------------------------------------------
// 信封 header
// ---------------------------------------------------------------------------

fn b64() -> impl base64::Engine {
    base64::engine::general_purpose::STANDARD
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// 包内相对路径（/ 分隔）
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algo: String,
    /// base64 salt
    pub salt: String,
    pub iterations: u32,
    /// base64 nonce
    pub nonce: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupHeader {
    pub format_version: u32,
    pub schema_version: u32,
    pub created_at: String,
    pub device: String,
    pub app_version: String,
    pub encrypted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kdf: Option<KdfParams>,
    pub files: Vec<FileEntry>,
    pub payload_sha256: String,
    pub payload_size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupHeaderSummary {
    pub created_at: String,
    pub device: String,
    pub app_version: String,
    pub encrypted: bool,
    pub file_count: usize,
}

impl From<&BackupHeader> for BackupHeaderSummary {
    fn from(h: &BackupHeader) -> Self {
        Self {
            created_at: h.created_at.clone(),
            device: h.device.clone(),
            app_version: h.app_version.clone(),
            encrypted: h.encrypted,
            file_count: h.files.len(),
        }
    }
}

// ---------------------------------------------------------------------------
// 哈希 / 加密
// ---------------------------------------------------------------------------

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, hex::encode(hasher.finalize())))
}

/// PBKDF2-SHA256 派生 32B 密钥
fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, KDF_ITERATIONS, &mut key);
    key
}

/// 12B nonce：UUIDv4 拼接取字节（与 secret.rs 同款，免 rand 依赖）
fn random_bytes12() -> [u8; 12] {
    let mut out = [0u8; 12];
    let mut filled = 0;
    while filled < out.len() {
        let b = uuid::Uuid::new_v4().into_bytes();
        let take = (out.len() - filled).min(b.len());
        out[filled..filled + take].copy_from_slice(&b[..take]);
        filled += take;
    }
    out
}

fn encrypt_payload(plain: Vec<u8>, passphrase: &str) -> Result<(Vec<u8>, KdfParams), String> {
    let salt: [u8; 16] = uuid::Uuid::new_v4().into_bytes()[..16]
        .try_into()
        .expect("uuid bytes >= 16");
    let nonce = random_bytes12();
    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain.as_ref())
        .map_err(|e| format!("encrypt payload: {e}"))?;
    Ok((
        ct,
        KdfParams {
            algo: "PBKDF2-SHA256".into(),
            salt: b64().encode(salt),
            iterations: KDF_ITERATIONS,
            nonce: b64().encode(nonce),
        },
    ))
}

fn decrypt_payload(ct: &[u8], kdf: &KdfParams, passphrase: &str) -> Result<Vec<u8>, String> {
    let salt = b64().decode(&kdf.salt).map_err(|e| format!("bad kdf salt: {e}"))?;
    let nonce = b64().decode(&kdf.nonce).map_err(|e| format!("bad kdf nonce: {e}"))?;
    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(&nonce), ct)
        .map_err(|_| "口令错误或备份已损坏（GCM 校验失败）".to_string())
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

fn collect_dir_files(dir: &Path, rel_base: &str, out: &mut Vec<(PathBuf, String)>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let rel = format!("{}/{}", rel_base, entry.file_name().to_string_lossy());
        if path.is_dir() {
            collect_dir_files(&path, &rel, out);
        } else if path.is_file() {
            out.push((path, rel));
        }
    }
}

/// 打包备份信封到临时目录，返回（信封路径，header）。
/// `db_snapshot` 为调用方已就绪的数据库一致快照（VACUUM INTO 产物或普通文件）。
#[allow(clippy::too_many_arguments)]
pub fn pack_backup(
    db_snapshot: &Path,
    data_dir: &Path,
    include_workspace: bool,
    passphrase: Option<&str>,
    device: &str,
    app_version: &str,
    progress: &dyn Fn(u64, u64, &str),
) -> Result<(PathBuf, BackupHeader), String> {
    // 1. 收集文件清单（state.db 快照 + sessions + 可选 workspace），排除 wal/shm
    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    entries.push((db_snapshot.to_path_buf(), DB_FILE.to_string()));
    collect_dir_files(&data_dir.join(SESSIONS_DIR), SESSIONS_DIR, &mut entries);
    if include_workspace {
        collect_dir_files(
            &data_dir.join(TASK_WORKSPACE_DIR),
            TASK_WORKSPACE_DIR,
            &mut entries,
        );
    }
    entries.sort_by(|a, b| a.1.cmp(&b.1));

    let tmp = std::env::temp_dir().join(format!("piabk-pack-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).map_err(|e| format!("create temp dir: {e}"))?;
    let tar_path = tmp.join("payload.tar.gz");
    // 逐文件先快照拷贝再哈希再入包：sessions JSONL 由 sidecar 流式追加，
    // 直接对原文件「先哈希后打包」会在两次读取之间被追加，恢复时校验失败
    let snapshot_dir = tmp.join("snapshot");

    // 2. 写 tar.gz（流式），并逐文件记录 sha256/size
    let tar_file = fs::File::create(&tar_path).map_err(|e| format!("create tar: {e}"))?;
    let gz = flate2::write::GzEncoder::new(tar_file, flate2::Compression::default());
    let mut builder = tar::Builder::new(gz);
    let mut file_entries: Vec<FileEntry> = Vec::with_capacity(entries.len());
    let total = entries.len() as u64;
    for (idx, (abs, rel)) in entries.iter().enumerate() {
        let snap = snapshot_dir.join(rel);
        if let Some(parent) = snap.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("snapshot dir {rel}: {e}"))?;
        }
        fs::copy(abs, &snap).map_err(|e| format!("snapshot {rel}: {e}"))?;
        let (size, hash) = sha256_file(&snap).map_err(|e| format!("hash {rel}: {e}"))?;
        builder
            .append_path_with_name(&snap, rel)
            .map_err(|e| format!("pack {rel}: {e}"))?;
        file_entries.push(FileEntry {
            path: rel.clone(),
            size,
            sha256: hash,
        });
        progress(idx as u64 + 1, total, rel);
    }
    let gz = builder
        .into_inner()
        .map_err(|e| format!("finish tar: {e}"))?;
    gz.finish().map_err(|e| format!("finish gzip: {e}"))?;

    // 3. 读回 tar.gz 作为明文负载（压缩后体积，通常远小于原始数据）
    let plain = fs::read(&tar_path).map_err(|e| format!("read tar.gz: {e}"))?;
    let _ = fs::remove_file(&tar_path);

    // 4. 可选加密
    let (payload, kdf) = match passphrase.filter(|p| !p.is_empty()) {
        Some(pass) => {
            progress(0, 1, "加密负载…");
            let (ct, kdf) = encrypt_payload(plain, pass)?;
            (ct, Some(kdf))
        }
        None => (plain, None),
    };

    // 5. 组装信封
    let header = BackupHeader {
        format_version: FORMAT_VERSION,
        schema_version: 1,
        created_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%z").to_string(),
        device: device.to_string(),
        app_version: app_version.to_string(),
        encrypted: kdf.is_some(),
        kdf,
        payload_sha256: sha256_hex(&payload),
        payload_size: payload.len() as u64,
        files: file_entries,
    };
    let file_name = format!("pi-backup-{}.piabk", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let envelope_path = tmp.join(&file_name);
    write_envelope(&envelope_path, &header, &payload)?;

    Ok((envelope_path, header))
}

fn write_envelope(path: &Path, header: &BackupHeader, payload: &[u8]) -> Result<(), String> {
    let header_line = serde_json::to_string(header).map_err(|e| format!("encode header: {e}"))?;
    let mut file = fs::File::create(path).map_err(|e| format!("create envelope: {e}"))?;
    file.write_all(MAGIC).map_err(|e| format!("write magic: {e}"))?;
    file.write_all(header_line.as_bytes())
        .map_err(|e| format!("write header: {e}"))?;
    file.write_all(b"\n").map_err(|e| format!("write header sep: {e}"))?;
    file.write_all(payload).map_err(|e| format!("write payload: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 解包
// ---------------------------------------------------------------------------

/// 从信封前若干字节解析 header（远端列表 / 本地文件 peek 用）
pub fn parse_header_from_prefix(prefix: &[u8]) -> Result<BackupHeader, String> {
    let text = prefix;
    let first = text
        .iter()
        .position(|&b| b == b'\n')
        .ok_or("不是有效的备份包（缺 magic 换行）")?;
    if &text[..first] != &MAGIC[..MAGIC.len() - 1] {
        return Err("不是有效的备份包（magic 不匹配）".into());
    }
    let rest = &text[first + 1..];
    let second = rest
        .iter()
        .position(|&b| b == b'\n')
        .ok_or("不是有效的备份包（header 未完整）")?;
    serde_json::from_slice(&rest[..second]).map_err(|e| format!("解析 header 失败: {e}"))
}

/// 解包信封到 dest_dir（不覆盖已存在的同名文件以外的校验），逐文件校验 sha256，
/// 并修剪 sessions/*.jsonl 末尾未写完的残行（sidecar 流式追加在拷贝瞬间可能截断）。
pub fn unpack_backup(
    envelope: &Path,
    dest_dir: &Path,
    passphrase: Option<&str>,
    progress: &dyn Fn(u64, u64, &str),
) -> Result<BackupHeader, String> {
    let mut file = fs::File::open(envelope).map_err(|e| format!("open {}: {e}", envelope.display()))?;
    // magic + header 两行（逐字节跳过 magic 行，收集 header 行）
    let mut header_bytes = Vec::new();
    let mut byte = [0u8; 1];
    let mut newlines = 0;
    while newlines < 2 {
        match file.read(&mut byte) {
            Ok(0) => return Err("不是有效的备份包（header 截断）".into()),
            Ok(_) => {
                if byte[0] == b'\n' {
                    newlines += 1;
                } else if newlines == 1 {
                    header_bytes.push(byte[0]);
                }
            }
            Err(e) => return Err(format!("read envelope: {e}")),
        }
    }
    let header: BackupHeader = serde_json::from_slice(&header_bytes)
        .map_err(|e| format!("解析 header 失败: {e}"))?;

    // 负载（压缩后体积读入内存——v1 接受；超大工作区用户可关掉开关）
    let mut payload = Vec::with_capacity(header.payload_size as usize);
    file.read_to_end(&mut payload).map_err(|e| format!("read payload: {e}"))?;
    if header.payload_sha256 != sha256_hex(&payload) {
        return Err("负载校验失败（sha256 不匹配，下载不完整或文件损坏）".into());
    }

    let tar_bytes = match (&header.kdf, passphrase.filter(|p| !p.is_empty())) {
        (Some(kdf), Some(pass)) => decrypt_payload(&payload, kdf, pass)?,
        (Some(_), None) => return Err("该备份已加密，需要口令".into()),
        (None, _) => payload,
    };

    fs::create_dir_all(dest_dir).map_err(|e| format!("create dest: {e}"))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(&tar_bytes[..]));
    archive
        .unpack(dest_dir)
        .map_err(|e| format!("解包失败: {e}"))?;

    // 逐文件校验
    let total = header.files.len() as u64;
    for (idx, fe) in header.files.iter().enumerate() {
        let abs = dest_dir.join(&fe.path);
        let (_, hash) = sha256_file(&abs).map_err(|e| format!("校验 {}: {e}", fe.path))?;
        if hash != fe.sha256 {
            return Err(format!("文件校验失败: {}", fe.path));
        }
        progress(idx as u64 + 1, total, &fe.path);
    }

    trim_torn_jsonl_tails(dest_dir);
    Ok(header)
}

/// 丢弃 JSONL 末尾没有换行符的残行（流式追加在备份瞬间可能截断半行）
fn trim_torn_jsonl_tails(root: &Path) {
    let Ok(rd) = fs::read_dir(root.join(SESSIONS_DIR)) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(content) = fs::read(&path) else { continue };
        if content.is_empty() || content.last() == Some(&b'\n') {
            continue;
        }
        // 末行无换行 = 备份瞬间被截断的残行：截到最后一个完整行；
        // 整个文件都没有换行则清空
        match content.iter().rposition(|&b| b == b'\n') {
            Some(pos) => {
                let _ = fs::write(&path, &content[..=pos]);
            }
            None => {
                let _ = fs::write(&path, b"");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupConfig {
    /// off | s3 | webdav
    pub provider: String,
    pub include_workspace: bool,
    pub device_name: String,
    // S3
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_prefix: String,
    pub s3_access_key_id: String,
    /// 落库为 enc:v1: 密文；空串 = 未设置
    pub s3_secret_access_key: String,
    pub s3_path_style: bool,
    // WebDAV
    pub dav_url: String,
    pub dav_username: String,
    /// 落库为 enc:v1: 密文；空串 = 未设置
    pub dav_password: String,
    pub dav_subdir: String,
    pub remember_passphrase: bool,
    /// 备份口令（remember 时落库为 enc:v1: 密文）
    pub passphrase: String,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            provider: "off".into(),
            include_workspace: true,
            device_name: "desktop".into(),
            s3_endpoint: String::new(),
            s3_region: "us-east-1".into(),
            s3_bucket: String::new(),
            s3_prefix: String::new(),
            s3_access_key_id: String::new(),
            s3_secret_access_key: String::new(),
            s3_path_style: true,
            dav_url: String::new(),
            dav_username: String::new(),
            dav_password: String::new(),
            dav_subdir: String::new(),
            remember_passphrase: false,
            passphrase: String::new(),
        }
    }
}

/// 返回给前端的视图：秘密值不外发，只给 *_set 布尔
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfigView {
    pub provider: String,
    pub include_workspace: bool,
    pub device_name: String,
    pub s3_endpoint: String,
    pub s3_region: String,
    pub s3_bucket: String,
    pub s3_prefix: String,
    pub s3_access_key_id: String,
    pub s3_secret_access_key_set: bool,
    pub s3_path_style: bool,
    pub dav_url: String,
    pub dav_username: String,
    pub dav_password_set: bool,
    pub dav_subdir: String,
    pub remember_passphrase: bool,
    pub passphrase_set: bool,
}

impl From<&BackupConfig> for BackupConfigView {
    fn from(c: &BackupConfig) -> Self {
        Self {
            provider: c.provider.clone(),
            include_workspace: c.include_workspace,
            device_name: c.device_name.clone(),
            s3_endpoint: c.s3_endpoint.clone(),
            s3_region: c.s3_region.clone(),
            s3_bucket: c.s3_bucket.clone(),
            s3_prefix: c.s3_prefix.clone(),
            s3_access_key_id: c.s3_access_key_id.clone(),
            s3_secret_access_key_set: !c.s3_secret_access_key.is_empty(),
            s3_path_style: c.s3_path_style,
            dav_url: c.dav_url.clone(),
            dav_username: c.dav_username.clone(),
            dav_password_set: !c.dav_password.is_empty(),
            dav_subdir: c.dav_subdir.clone(),
            remember_passphrase: c.remember_passphrase,
            passphrase_set: !c.passphrase.is_empty(),
        }
    }
}

fn load_config(app: &AppHandle) -> BackupConfig {
    match crate::store::kv_get_global(app, CONFIG_KEY) {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => BackupConfig::default(),
    }
}

fn save_config(app: &AppHandle, cfg: &BackupConfig) -> Result<(), String> {
    let raw = serde_json::to_string(cfg).map_err(|e| format!("encode config: {e}"))?;
    crate::store::kv_set_global(app, CONFIG_KEY, &raw)
}

/// 新值空串 = 保留旧值；enc:v1: 前缀 = 原样；否则加密落库
fn merge_secret(old: &str, new: &str) -> String {
    if new.is_empty() {
        old.to_string()
    } else if new.starts_with(crate::secret::PREFIX) {
        new.to_string()
    } else {
        crate::secret::encrypt(new)
    }
}

fn merge_config(old: &BackupConfig, new: &BackupConfig) -> BackupConfig {
    let mut c = new.clone();
    c.s3_secret_access_key = merge_secret(&old.s3_secret_access_key, &new.s3_secret_access_key);
    c.dav_password = merge_secret(&old.dav_password, &new.dav_password);
    c.passphrase = if new.remember_passphrase {
        merge_secret(&old.passphrase, &new.passphrase)
    } else {
        // 不记住：不落盘，前端每次操作随参数携带
        String::new()
    };
    c
}

// ---------------------------------------------------------------------------
// S3（手写 SigV4）
// ---------------------------------------------------------------------------

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as hmac::Mac>::new_from_slice(key).expect("hmac accepts any key len");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// RFC3986 百分号编码（unreserved 之外全编码）
fn uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex_str = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex_str, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            _ => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// SigV4：返回 Authorization 头。只签 host + extra + x-amz-content-sha256 + x-amz-date
/// （S3 允许未签名的额外头如 range；x-amz-* 必须全签，这里恰好只有这两个）。
#[allow(clippy::too_many_arguments)]
fn sigv4_authorization(
    method: &str,
    url: &reqwest::Url,
    query: &[(String, String)],
    extra_headers: &[(String, String)],
    payload_hash: &str,
    access_key: &str,
    secret_key: &str,
    region: &str,
    amz_date: &str,
    date_stamp: &str,
) -> String {
    // host（含非默认端口）
    let mut host = url.host_str().unwrap_or("").to_string();
    if let Some(port) = url.port() {
        host.push_str(&format!(":{port}"));
    }
    let mut headers: Vec<(String, String)> = vec![
        ("host".to_string(), host),
        ("x-amz-content-sha256".to_string(), payload_hash.to_string()),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ];
    for (k, v) in extra_headers {
        headers.push((k.to_lowercase(), v.trim().to_string()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let signed_headers = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    // 规范头块：每行末尾都带 \n（末行亦然），使 header 块与 SignedHeaders
    // 之间恰好隔一个空行——这是 SigV4 规范要求，漏掉会导致签名不一致
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| format!("{k}:{v}\n"))
        .collect::<String>();

    // 规范 URI：路径逐段编码（/ 保留）
    let canonical_uri = url
        .path_segments()
        .map(|segs| {
            segs.map(|s| uri_encode(s, false))
                .collect::<Vec<_>>()
                .join("/")
        })
        .map(|joined| format!("/{joined}"))
        .unwrap_or_else(|| "/".to_string());
    let canonical_uri = if canonical_uri.is_empty() {
        "/".to_string()
    } else {
        canonical_uri
    };

    let mut sorted_query = query.to_vec();
    sorted_query.sort();
    let canonical_query = sorted_query
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date_stamp}/{region}/s3/aws4_request");    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

#[derive(Clone, Debug)]
struct S3Config {
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    secret_access_key: String,
    path_style: bool,
}

impl S3Config {
    fn from(c: &BackupConfig) -> Result<Self, String> {
        if c.s3_bucket.trim().is_empty() {
            return Err("S3 bucket 未配置".into());
        }
        let secret = if c.s3_secret_access_key.is_empty() {
            String::new()
        } else {
            crate::secret::decrypt(&c.s3_secret_access_key).unwrap_or_default()
        };
        if c.s3_access_key_id.trim().is_empty() || secret.is_empty() {
            return Err("S3 访问密钥未配置或无法解密（请重新填写）".into());
        }
        Ok(Self {
            endpoint: c.s3_endpoint.trim().trim_end_matches('/').to_string(),
            region: if c.s3_region.trim().is_empty() {
                "us-east-1".into()
            } else {
                c.s3_region.trim().to_string()
            },
            bucket: c.s3_bucket.trim().to_string(),
            prefix: c.s3_prefix.trim().trim_matches('/').to_string(),
            access_key_id: c.s3_access_key_id.trim().to_string(),
            secret_access_key: secret,
            path_style: c.s3_path_style,
        })
    }

    fn key(&self, name: &str) -> String {
        if self.prefix.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", self.prefix, name)
        }
    }

    fn object_url(&self, key: &str) -> String {
        let enc_key = key.split('/').map(|s| uri_encode(s, false)).collect::<Vec<_>>().join("/");
        if self.endpoint.is_empty() {
            if self.path_style {
                return format!("https://s3.{}.amazonaws.com/{}/{}", self.region, self.bucket, enc_key);
            }
            return format!("https://{}.s3.{}.amazonaws.com/{}", self.bucket, self.region, enc_key);
        }
        let base = if self.endpoint.starts_with("http://") || self.endpoint.starts_with("https://") {
            self.endpoint.clone()
        } else {
            format!("https://{}", self.endpoint)
        };
        if self.path_style {
            format!("{base}/{}/{}", self.bucket, enc_key)
        } else {
            // 从 base 提取 scheme+host，bucket 作为子域
            if let Ok(u) = reqwest::Url::parse(&base) {
                let scheme = u.scheme();
                let host = u.host_str().unwrap_or("");
                let port = match u.port() {
                    Some(p) => format!(":{p}"),
                    None => String::new(),
                };
                format!("{scheme}://{bucket}.{host}{port}/{key}", bucket = self.bucket, key = enc_key)
            } else {
                format!("{base}/{}/{}", self.bucket, enc_key)
            }
        }
    }

    fn dir_url(&self) -> String {
        let url = self.object_url("");
        // object_url("") 会以 / 结尾
        url
    }
}

struct S3Client {
    http: reqwest::blocking::Client,
    cfg: S3Config,
}

impl S3Client {
    fn new(cfg: S3Config, timeout: Duration) -> Result<Self, String> {
        let http = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(timeout)
            // 不自动跟随重定向：AWS 的 301（region 错误等）重定向后 Authorization
            // 签名对新 host 无效，跟着走只会得到难懂的 403/405——直接把 301 和
            // Location 报给用户
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("build http client: {e}"))?;
        Ok(Self { http, cfg })
    }

    /// 签名并执行请求；非 2xx 返回带状态码与响应片段的错误。
    /// 查询串由这里统一拼进 URL（用与规范请求相同的编码），避免 reqwest 的
    /// form 编码（空格→+）与 SigV4 规范编码（%20）不一致导致签名不匹配。
    #[allow(clippy::too_many_arguments)]
    fn signed_request(
        &self,
        method: &str,
        url_str: &str,
        query: &[(String, String)],
        extra_headers: &[(String, String)],
        body: Option<Vec<u8>>,
        extra_ok: &[u16],
    ) -> Result<reqwest::blocking::Response, String> {
        let full_url = if query.is_empty() {
            url_str.to_string()
        } else {
            let mut sorted = query.to_vec();
            sorted.sort();
            let qs = sorted
                .iter()
                .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
                .collect::<Vec<_>>()
                .join("&");
            format!("{url_str}?{qs}")
        };
        let url = reqwest::Url::parse(&full_url).map_err(|e| format!("bad url: {e}"))?;
        let now = chrono::Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();
        let (payload_hash, body_opt) = match &body {
            Some(b) => (sha256_hex(b), body),
            None => (EMPTY_SHA256.to_string(), None),
        };
        let auth = sigv4_authorization(
            method,
            &url,
            query,
            extra_headers,
            &payload_hash,
            &self.cfg.access_key_id,
            &self.cfg.secret_access_key,
            &self.cfg.region,
            &amz_date,
            &date_stamp,
        );
        let mut req = match method {
            "PUT" => self.http.put(url.clone()),
            "DELETE" => self.http.delete(url.clone()),
            _ => self.http.get(url.clone()),
        };
        req = req
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("Authorization", auth);
        for (k, v) in extra_headers {
            // x-amz-* 已在上面设置/签名，其余（range）直接带上
            if !k.eq_ignore_ascii_case("host") {
                req = req.header(k.as_str(), v.as_str());
            }
        }
        if let Some(b) = body_opt {
            req = req.body(b);
        }
        let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
        check_status(resp, "S3", method, &full_url, extra_ok)
    }

    fn put_object(&self, key: &str, bytes: Vec<u8>) -> Result<(), String> {
        let url = self.cfg.object_url(key);
        self.signed_request("PUT", &url, &[], &[], Some(bytes), &[])?;
        Ok(())
    }

    fn get_object_to_file(&self, key: &str, dest: &Path) -> Result<u64, String> {
        let url = self.cfg.object_url(key);
        let mut resp = self.signed_request("GET", &url, &[], &[], None, &[])?;
        let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
        std::io::copy(&mut resp, &mut file).map_err(|e| format!("写入下载文件失败: {e}"))
    }

    /// 读对象前 max_bytes 字节（header peek 用，Range 头未签名——S3 允许）
    fn get_object_prefix(&self, key: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        let url = self.cfg.object_url(key);
        let resp = self.signed_request(
            "GET",
            &url,
            &[],
            &[("Range".to_string(), format!("bytes=0-{}", max_bytes - 1))],
            None,
            &[],
        )?;
        let mut buf = Vec::new();
        resp.take(max_bytes).read_to_end(&mut buf).ok();
        Ok(buf)
    }

    /// 删除对象。S3 规范本就幂等（不存在也回 204），部分实现回 404——
    /// 一律视为成功，返回是否原本存在。
    fn delete_object(&self, key: &str) -> Result<bool, String> {
        let url = self.cfg.object_url(key);
        let resp = self.signed_request("DELETE", &url, &[], &[], None, &[404])?;
        Ok(resp.status().as_u16() != 404)
    }

    fn list_objects(&self, prefix: &str) -> Result<Vec<(String, u64, String)>, String> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("max-keys".to_string(), "1000".to_string()),
                ("prefix".to_string(), prefix.to_string()),
            ];
            if let Some(t) = &token {
                query.push(("continuation-token".to_string(), t.clone()));
            }
            let url = self.cfg.dir_url();
            let resp = self.signed_request("GET", &url, &query, &[], None, &[])?;
            let text = resp.text().map_err(|e| format!("读取列表响应: {e}"))?;
            for contents in xml_blocks(&text, "Contents") {
                let key = xml_first(&contents, "Key").unwrap_or_default();
                let size: u64 = xml_first(&contents, "Size")
                    .and_then(|s| s.trim().parse().ok())
                    .unwrap_or(0);
                let modified = xml_first(&contents, "LastModified").unwrap_or_default();
                if !key.is_empty() {
                    out.push((percent_decode(&key), size, modified));
                }
            }
            let truncated = xml_first(&text, "IsTruncated")
                .map(|s| s.trim().eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            token = xml_first(&text, "NextContinuationToken").map(|s| s.trim().to_string());
            if !truncated || token.is_none() {
                break;
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct DavConfig {
    url: String,
    username: String,
    password: String,
    subdir: String,
}

impl DavConfig {
    fn from(c: &BackupConfig) -> Result<Self, String> {
        if c.dav_url.trim().is_empty() {
            return Err("WebDAV URL 未配置".into());
        }
        let password = if c.dav_password.is_empty() {
            String::new()
        } else {
            crate::secret::decrypt(&c.dav_password).unwrap_or_default()
        };
        Ok(Self {
            url: c.dav_url.trim().trim_end_matches('/').to_string(),
            username: c.dav_username.trim().to_string(),
            password,
            subdir: c.dav_subdir.trim().trim_matches('/').to_string(),
        })
    }

    fn dir_url(&self) -> String {
        if self.subdir.is_empty() {
            format!("{}/", self.url)
        } else {
            format!("{}/{}/", self.url, self.subdir)
        }
    }

    fn file_url(&self, name: &str) -> String {
        format!("{}{}", self.dir_url(), name.split('/').map(|s| uri_encode(s, false)).collect::<Vec<_>>().join("/"))
    }
}

struct DavClient {
    http: reqwest::blocking::Client,
    cfg: DavConfig,
}

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

/// 405 的通用解释：不少 NAS（如绿联 UGOS）把共享目录挂在 WebDAV 根下且根目录
/// 只读——MKCOL/PUT 都会 405。引导用户把子目录填到可写共享目录之内。
const DAV_405_HINT: &str = "HTTP 405 多见于 URL 指向只读根目录（NAS 通常把共享目录挂在根下，根目录禁止写入）：请把「子目录」设置为某个可写共享目录下的路径，例如 home/pi-backups";

impl DavClient {
    fn new(cfg: DavConfig, timeout: Duration) -> Result<Self, String> {
        let http = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(timeout)
            // 不自动跟随重定向：301/302 重定向时 reqwest 会把非 GET 方法改成
            // GET、丢弃 body，表现为莫名其妙的 405；改为直接报出重定向目标
            // （见 check_status），引导用户把 URL 改成最终地址
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("build http client: {e}"))?;
        Ok(Self { http, cfg })
    }

    fn auth(&self) -> Option<String> {
        if self.cfg.username.is_empty() && self.cfg.password.is_empty() {
            return None;
        }
        let raw = format!("{}:{}", self.cfg.username, self.cfg.password);
        Some(format!("Basic {}", b64().encode(raw.as_bytes())))
    }

    fn request(
        &self,
        method: &str,
        url: &str,
        body: Option<&str>,
        extra_ok: &[u16],
    ) -> Result<reqwest::blocking::Response, String> {
        let mut req = match method {
            "PUT" => self.http.put(url),
            "MKCOL" => self.http.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), url),
            "PROPFIND" => self.http.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url),
            "DELETE" => self.http.delete(url),
            _ => self.http.get(url),
        };
        if let Some(auth) = self.auth() {
            req = req.header("Authorization", auth);
        }
        if let Some(b) = body {
            req = req.header("Content-Type", "application/xml").body(b.to_string());
        }
        let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
        check_status(resp, "WebDAV", method, url, extra_ok)
    }

    /// PROPFIND Depth:0 判断资源是否存在（405 消歧用：部分服务器对"已存在"
    /// 的 MKCOL 也回 405）
    fn collection_exists(&self, url: &str) -> Result<bool, String> {
        let auth = self.auth();
        let mut req = self
            .http
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
            .header("Depth", "0")
            .header("Content-Type", "application/xml")
            .body(PROPFIND_BODY.to_string());
        if let Some(auth) = auth {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
        match resp.status().as_u16() {
            207 => Ok(true),
            404 => Ok(false),
            _ => {
                check_status(resp, "WebDAV", "PROPFIND", url, &[207])?;
                Ok(true)
            }
        }
    }

    fn with_405_hint(err: String) -> String {
        if err.contains("HTTP 405") {
            format!("{err}\n{DAV_405_HINT}")
        } else {
            err
        }
    }

    /// 逐级 MKCOL 建目录。MKCOL 失败不直接当作"已存在"跳过——用 PROPFIND
    /// 确认确实存在才继续，否则把原始错误（含 405 提示）抛出。
    fn mkcol_deep(&self) -> Result<(), String> {
        let base = reqwest::Url::parse(&format!("{}/", self.cfg.url.trim_end_matches('/')))
            .map_err(|e| format!("bad dav url: {e}"))?;
        let base_path = base.path().trim_end_matches('/');
        let target_path = reqwest::Url::parse(&self.cfg.dir_url())
            .map_err(|e| format!("bad dav dir url: {e}"))?
            .path()
            .trim_end_matches('/')
            .to_string();
        if !target_path.starts_with(base_path) {
            return Err("WebDAV 子目录必须位于 URL 路径之内".into());
        }
        let mut acc = base_path.to_string();
        let rel = &target_path[base_path.len()..];
        for seg in rel.split('/').filter(|s| !s.is_empty()) {
            acc = format!("{acc}/{seg}");
            let url = format!("{}://{}{}{}", base.scheme(), base.host_str().unwrap_or(""), base.port().map(|p| format!(":{p}")).unwrap_or_default(), acc);
            match self.request("MKCOL", &url, None, &[]) {
                Ok(_) => {}
                Err(e) => {
                    if !matches!(self.collection_exists(&url), Ok(true)) {
                        return Err(Self::with_405_hint(e));
                    }
                }
            }
        }
        Ok(())
    }

    fn put(&self, name: &str, bytes: Vec<u8>) -> Result<(), String> {
        let url = self.cfg.file_url(name);
        let auth = self.auth();
        let mut req = self.http.put(&url).body(bytes);
        if let Some(auth) = auth {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
        check_status(resp, "WebDAV", "PUT", &url, &[]).map_err(Self::with_405_hint)?;
        Ok(())
    }

    fn get_to_file(&self, name: &str, dest: &Path) -> Result<u64, String> {
        let url = self.cfg.file_url(name);
        let mut resp = self.request("GET", &url, None, &[])?;
        let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
        std::io::copy(&mut resp, &mut file).map_err(|e| format!("写入下载文件失败: {e}"))
    }

    fn get_prefix(&self, name: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        let url = self.cfg.file_url(name);
        let auth = self.auth();
        let mut req = self
            .http
            .get(&url)
            .header("Range", format!("bytes=0-{}", max_bytes - 1));
        if let Some(auth) = auth {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
        let resp = check_status(resp, "WebDAV", "GET", &url, &[])?;
        let mut buf = Vec::new();
        resp.take(max_bytes).read_to_end(&mut buf).ok();
        Ok(buf)
    }

    /// 删除文件。404（远端已不存在，如在 NAS 上手动删除过）视为成功，
    /// 返回是否原本存在——删除是幂等操作，不该因"已经删了"而报错。
    fn delete(&self, name: &str) -> Result<bool, String> {
        let url = self.cfg.file_url(name);
        let resp = self.request("DELETE", &url, None, &[404])?;
        Ok(resp.status().as_u16() != 404)
    }

    fn list(&self) -> Result<Vec<(String, u64, String)>, String> {
        let url = self.cfg.dir_url();
        let auth = self.auth();
        let mut req = self
            .http
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .body(PROPFIND_BODY.to_string());
        if let Some(auth) = auth {
            req = req.header("Authorization", auth);
        }
        let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
        if resp.status().as_u16() == 404 {
            // 目录尚不存在：视作空列表（上传时会先 MKCOL）
            return Ok(Vec::new());
        }
        let resp = check_status(resp, "WebDAV", "PROPFIND", &url, &[207])?;
        let text = resp.text().map_err(|e| format!("读取列表响应: {e}"))?;
        let mut out = Vec::new();
        for response in xml_blocks(&text, "response") {
            let href = percent_decode(&xml_first(&response, "href").unwrap_or_default());
            let is_dir = xml_first(&response, "resourcetype")
                .map(|rt| {
                    let lower = rt.to_lowercase();
                    lower.contains("collection") || lower.contains("<dir")
                })
                .unwrap_or(false)
                || href.ends_with('/');
            if is_dir || href.is_empty() {
                continue;
            }
            let name = href.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let size: u64 = xml_first(&response, "getcontentlength")
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            let modified = xml_first(&response, "getlastmodified").unwrap_or_default();
            out.push((name, size, modified));
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// 极简 XML 扫描（只面向 S3 ListBucketResult / DAV multistatus 两种固定形状，
// 按 local name 大小写不敏感匹配，避免引入 XML 解析器依赖）
// ---------------------------------------------------------------------------

/// 返回 xml 中所有 `<…:tag …>inner</…:tag>` 的 inner（大小写不敏感 local name）
fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let lower = xml.to_lowercase();
    let tag_lower = tag.to_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        // 解析开标签名（含命名空间前缀），跳过 </ 与 <?
        if bytes.get(i + 1) == Some(&b'/') || bytes.get(i + 1) == Some(&b'?') || bytes.get(i + 1) == Some(&b'!') {
            i += 1;
            continue;
        }
        let name_start = i + 1;
        let mut j = name_start;
        while j < bytes.len() && bytes[j] != b'>' && bytes[j] != b' ' && bytes[j] != b'/' && bytes[j] != b'\t' && bytes[j] != b'\n' {
            j += 1;
        }
        let raw_name = &lower[name_start..j];
        let local = raw_name.rsplit(':').next().unwrap_or(raw_name);
        if local != tag_lower {
            i = j;
            continue;
        }
        // 找对应闭标签（同层不嵌套同名标签，取下一个即匹配）
        let mut k = j;
        let mut found = None;
        while let Some(pos) = lower[k..].find("</") {
            let abs = k + pos;
            let end = lower[abs..].find('>').map(|p| abs + p).unwrap_or(abs);
            let inner_name = &lower[abs + 2..end.min(lower.len())];
            let inner_local = inner_name.trim().rsplit(':').next().unwrap_or("").trim();
            if inner_local == tag_lower {
                found = Some((abs, end + 1));
                break;
            }
            k = abs + 2;
        }
        match found {
            Some((close_start, close_end)) => {
                // inner 从开标签 '>' 之后开始
                let open_end = xml[j..].find('>').map(|p| j + p + 1).unwrap_or(j);
                if close_start >= open_end {
                    out.push(&xml[open_end..close_start]);
                }
                i = close_end;
            }
            None => break,
        }
    }
    out
}

/// 取第一个匹配标签的 inner 文本
fn xml_first(xml: &str, tag: &str) -> Option<String> {
    xml_blocks(xml, tag).into_iter().next().map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// 远端通道抽象 + 列表项
// ---------------------------------------------------------------------------

/// 统一的非 2xx 错误文案：带上方法与 URL（排障关键——405/403 这类错误只有
/// 配上具体请求才有意义），3xx 时给出 Location 并停止跟随。
fn check_status(
    resp: reqwest::blocking::Response,
    channel: &str,
    method: &str,
    url: &str,
    extra_ok: &[u16],
) -> Result<reqwest::blocking::Response, String> {
    let status = resp.status();
    if status.is_success() || extra_ok.contains(&status.as_u16()) {
        return Ok(resp);
    }
    if status.is_redirection() {
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        return Err(format!(
            "{channel} {method} {url} 返回 HTTP {}（服务器要求重定向到 {loc}；已停止自动跟随，请把 URL 改成最终地址）",
            status.as_u16()
        ));
    }
    let text = resp.text().unwrap_or_default();
    let snippet: String = text.chars().take(300).collect();
    Err(format!(
        "{channel} {method} {url} 返回 HTTP {}: {snippet}",
        status.as_u16()
    ))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub name: String,
    pub size: u64,
    pub modified: String,
    pub encrypted: bool,
}

enum RemoteChannel {
    S3(S3Client),
    Dav(DavClient),
}

impl RemoteChannel {
    fn from_config(cfg: &BackupConfig, timeout: Duration) -> Result<Self, String> {
        match cfg.provider.as_str() {
            "s3" => Ok(Self::S3(S3Client::new(S3Config::from(cfg)?, timeout)?)),
            "webdav" => Ok(Self::Dav(DavClient::new(DavConfig::from(cfg)?, timeout)?)),
            other => Err(format!("未知的备份通道: {other}")),
        }
    }

    /// S3 的 key 需要拼上配置前缀；WebDAV 的 file_url 已含子目录（见各方法）
    fn put(&self, name: &str, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Self::S3(c) => c.put_object(&c.cfg.key(name), bytes),
            Self::Dav(c) => c.put(name, bytes),
        }
    }

    fn get_to_file(&self, name: &str, dest: &Path) -> Result<u64, String> {
        match self {
            Self::S3(c) => c.get_object_to_file(&c.cfg.key(name), dest),
            Self::Dav(c) => c.get_to_file(name, dest),
        }
    }

    fn get_prefix(&self, name: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
        match self {
            Self::S3(c) => c.get_object_prefix(&c.cfg.key(name), max_bytes),
            Self::Dav(c) => c.get_prefix(name, max_bytes),
        }
    }

    fn delete(&self, name: &str) -> Result<bool, String> {
        match self {
            Self::S3(c) => c.delete_object(&c.cfg.key(name)),
            Self::Dav(c) => c.delete(name),
        }
    }

    fn list(&self) -> Result<Vec<(String, u64, String)>, String> {
        match self {
            Self::S3(c) => {
                // prefix 目录 + /，空 prefix 时列整个 bucket；key 映射回文件名
                // （与 put/get/delete 只传文件名、由 full key 拼装保持一致）
                let p = if c.cfg.prefix.is_empty() {
                    String::new()
                } else {
                    format!("{}/", c.cfg.prefix)
                };
                Ok(c.list_objects(&p)?
                    .into_iter()
                    .map(|(key, size, modified)| {
                        let name = key.rsplit('/').next().unwrap_or(&key).to_string();
                        (name, size, modified)
                    })
                    .collect())
            }
            Self::Dav(c) => c.list(),
        }
    }
}

fn list_remote_backups(cfg: &BackupConfig) -> Result<Vec<RemoteBackup>, String> {
    let channel = RemoteChannel::from_config(cfg, Duration::from_secs(600))?;
    let mut items = channel
        .list()?
        .into_iter()
        .filter(|(name, _, _)| name.ends_with(".piabk"))
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = Vec::with_capacity(items.len());
    for (name, size, modified) in items {
        let encrypted = match channel.get_prefix(&name, 4096) {
            Ok(prefix) => parse_header_from_prefix(&prefix).map(|h| h.encrypted).unwrap_or(false),
            Err(_) => false,
        };
        out.push(RemoteBackup {
            name,
            size,
            modified,
            encrypted,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 数据库快照
// ---------------------------------------------------------------------------

/// 在现有连接上做一致快照：先 checkpoint 收缩 WAL，再 VACUUM INTO 到临时文件。
/// app 未管理 DbState（store 初始化失败）时退化为直接拷贝 db 文件。
fn snapshot_database(app: &AppHandle, dest: &Path) -> Result<(), String> {
    if let Some(db) = app.try_state::<crate::store::DbState>() {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_row| Ok(()));
        let dest_str = dest.to_string_lossy().to_string();
        // VACUUM INTO 要求目标不存在
        let _ = fs::remove_file(dest);
        conn.execute("VACUUM INTO ?1", [dest_str.as_str()])
            .map_err(|e| format!("VACUUM INTO 失败: {e}"))?;
        return Ok(());
    }
    // 退化路径
    if let Some(src) = app_data_dir(app).ok().map(|d| d.join(DB_FILE)) {
        fs::copy(&src, dest).map_err(|e| format!("copy state.db: {e}"))?;
        Ok(())
    } else {
        Err("无法解析应用数据目录".into())
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

fn emit_progress(app: &AppHandle, phase: &str, done: u64, total: u64, message: &str) {
    let _ = app.emit(
        PROGRESS_EVENT,
        serde_json::json!({"phase": phase, "done": done, "total": total, "message": message}),
    );
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn backup_config_get(app: AppHandle) -> Result<BackupConfigView, String> {
    Ok(BackupConfigView::from(&load_config(&app)))
}

#[tauri::command]
pub fn backup_config_set(app: AppHandle, config: BackupConfig) -> Result<BackupConfigView, String> {
    // 基本校验
    match config.provider.as_str() {
        "off" => {}
        "s3" | "webdav" => {}
        other => return Err(format!("未知的备份通道: {other}")),
    }
    let old = load_config(&app);
    let merged = merge_config(&old, &config);
    save_config(&app, &merged)?;
    Ok(BackupConfigView::from(&merged))
}

/// 连通性检查：列出目标（S3 max-keys=1 / WebDAV PROPFIND，目录不存在则建）
#[tauri::command]
pub async fn backup_test(app: AppHandle) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&handle);
        match cfg.provider.as_str() {
            "s3" => {
                let client = S3Client::new(S3Config::from(&cfg)?, Duration::from_secs(20))?;
                let prefix = if cfg.s3_prefix.trim().is_empty() {
                    String::new()
                } else {
                    format!("{}/", cfg.s3_prefix.trim().trim_matches('/'))
                };
                let _ = client.list_objects(&prefix)?;
                Ok("S3 连接成功".into())
            }
            "webdav" => {
                let client = DavClient::new(DavConfig::from(&cfg)?, Duration::from_secs(20))?;
                // 目录不存在则建（NAS 只读根目录下会在此处明确报错）
                client.mkcol_deep()?;
                // 写入探测文件验证真实可写——PROPFIND 通不代表 PUT 通
                let probe = format!("pi-backup-probe-{}.txt", uuid::Uuid::new_v4());
                client.put(&probe, b"probe".to_vec()).map_err(DavClient::with_405_hint)?;
                let _ = client.delete(&probe);
                client.list()?;
                Ok("WebDAV 连接成功（已验证可写入）".into())
            }
            other => Err(format!("请先选择备份通道（当前: {other}）")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunResult {
    pub file_name: String,
    pub size: u64,
    pub file_count: usize,
    pub encrypted: bool,
    pub remote: bool,
    /// 仅远端上传时有值
    pub device: String,
    pub created_at: String,
}

/// 执行备份：target = "remote"（按配置的通道上传）或 "local"（写到 local_path）
#[tauri::command]
pub async fn backup_run(
    app: AppHandle,
    target: String,
    local_path: Option<String>,
    passphrase: Option<String>,
) -> Result<BackupRunResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&handle);
        let remote = match target.as_str() {
            "remote" => true,
            "local" => false,
            other => return Err(format!("未知备份目标: {other}")),
        };
        if remote && cfg.provider == "off" {
            return Err("请先在设置中选择备份通道（S3 / WebDAV）".into());
        }
        if remote && cfg.provider == "webdav" {
            // 目录不存在时先建（部分服务器 MKCOL 父目录必须逐级）
            DavClient::new(DavConfig::from(&cfg)?, Duration::from_secs(20))?.mkcol_deep()?;
        }

        let data_dir = app_data_dir(&handle)?;
        emit_progress(&handle, "db", 0, 1, "生成数据库快照…");
        let tmp = std::env::temp_dir().join(format!("piabk-run-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).map_err(|e| format!("create temp dir: {e}"))?;
        let db_snapshot = tmp.join("state.db");
        snapshot_database(&handle, &db_snapshot)?;

        let pass = passphrase
            .filter(|p| !p.is_empty())
            .or(if cfg.remember_passphrase && !cfg.passphrase.is_empty() {
                crate::secret::decrypt(&cfg.passphrase).ok()
            } else {
                None
            })
            .filter(|p| !p.is_empty());
        emit_progress(&handle, "pack", 0, 1, "打包备份…");
        let (envelope, header) = pack_backup(
            &db_snapshot,
            &data_dir,
            cfg.include_workspace,
            pass.as_deref(),
            if cfg.device_name.trim().is_empty() { "desktop" } else { cfg.device_name.trim() },
            handle.package_info().version.to_string().as_str(),
            &|done, total, msg| emit_progress(&handle, "pack", done, total, msg),
        )?;
        let _ = fs::remove_file(&db_snapshot);

        let size = fs::metadata(&envelope).map(|m| m.len()).unwrap_or(0);
        let result = BackupRunResult {
            file_name: envelope
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            size,
            file_count: header.files.len(),
            encrypted: header.encrypted,
            remote,
            device: header.device.clone(),
            created_at: header.created_at.clone(),
        };

        if remote {
            let channel = RemoteChannel::from_config(&cfg, Duration::from_secs(600))?;
            emit_progress(&handle, "upload", 0, size, "上传备份…");
            let bytes = fs::read(&envelope).map_err(|e| format!("read envelope: {e}"))?;
            channel.put(&result.file_name, bytes)?;
            emit_progress(&handle, "upload", size, size, "上传完成");
        } else {
            let dest = local_path.ok_or("缺少本地保存路径")?;
            emit_progress(&handle, "save", 0, size, "写入本地文件…");
            if let Some(parent) = Path::new(&dest).parent() {
                fs::create_dir_all(parent).ok();
            }
            fs::copy(&envelope, &dest).map_err(|e| format!("写入备份文件失败: {e}"))?;
            emit_progress(&handle, "save", size, size, "写入完成");
        }
        // 清理临时目录（envelope 在 pack 的临时目录里，db 快照在 run 的临时目录里）
        if let Some(parent) = envelope.parent() {
            let _ = fs::remove_dir_all(parent);
        }
        let _ = fs::remove_dir_all(&tmp);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_list_remote(app: AppHandle) -> Result<Vec<RemoteBackup>, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&handle);
        list_remote_backups(&cfg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_download(app: AppHandle, name: String, save_path: String) -> Result<u64, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&handle);
        if name.contains('/') || name.contains("..") {
            return Err("非法的备份文件名".into());
        }
        let channel = RemoteChannel::from_config(&cfg, Duration::from_secs(1800))?;
        emit_progress(&handle, "download", 0, 1, &format!("下载 {name}…"));
        let n = channel.get_to_file(&name, Path::new(&save_path)).map_err(|e| {
            if e.contains("返回 HTTP 404") {
                format!("{e}\n远端备份可能已被删除，请刷新列表")
            } else {
                e
            }
        })?;
        emit_progress(&handle, "download", 1, 1, "下载完成");
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_delete_remote(app: AppHandle, name: String) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&handle);
        if name.contains('/') || name.contains("..") {
            return Err("非法的备份文件名".into());
        }
        let channel = RemoteChannel::from_config(&cfg, Duration::from_secs(60))?;
        // 删除是幂等操作：远端已被手动删掉（404）不算错误
        let existed = channel.delete(&name)?;
        if existed {
            Ok("已删除".into())
        } else {
            Ok("远端已不存在，已视为删除".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSource {
    /// 远端备份文件名（与 local_path 二选一）
    pub remote_name: Option<String>,
    /// 本地备份包路径
    pub local_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStagedResult {
    pub header: BackupHeaderSummary,
    /// 需要重启应用完成换入
    pub needs_restart: bool,
}

/// 恢复第一步：下载/校验/解包到 staging，写待恢复标记；实际换入在下次启动
/// （apply_pending_restore，早于任何存储打开）。
#[tauri::command]
pub async fn backup_restore(app: AppHandle, source: RestoreSource) -> Result<RestoreStagedResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config(&handle);
        let data_dir = app_data_dir(&handle)?;
        let staging_root = data_dir.join(RESTORE_STAGING_DIR);
        let staging_content = staging_root.join("content");
        let _ = fs::remove_dir_all(&staging_root);
        fs::create_dir_all(&staging_content).map_err(|e| format!("create staging: {e}"))?;

        let envelope_tmp = staging_root.join("source.piabk");
        match (&source.remote_name, &source.local_path) {
            (Some(name), _) if !name.is_empty() => {
                if name.contains('/') || name.contains("..") {
                    return Err("非法的备份文件名".into());
                }
                let channel = RemoteChannel::from_config(&cfg, Duration::from_secs(1800))?;
                emit_progress(&handle, "download", 0, 1, &format!("下载 {name}…"));
                channel.get_to_file(name, &envelope_tmp).map_err(|e| {
                    if e.contains("返回 HTTP 404") {
                        format!("{e}\n远端备份可能已被删除，请刷新列表")
                    } else {
                        e
                    }
                })?;
                emit_progress(&handle, "download", 1, 1, "下载完成");
            }
            (None, Some(path)) if !path.is_empty() => {
                fs::copy(path, &envelope_tmp).map_err(|e| format!("读取备份文件失败: {e}"))?;
            }
            _ => return Err("缺少恢复来源".into()),
        }

        emit_progress(&handle, "unpack", 0, 1, "解包与校验…");
        let pass = source
            .passphrase
            .filter(|p| !p.is_empty())
            .or(if cfg.remember_passphrase && !cfg.passphrase.is_empty() {
                crate::secret::decrypt(&cfg.passphrase).ok()
            } else {
                None
            })
            .filter(|p| !p.is_empty());
        let header = unpack_backup(&envelope_tmp, &staging_content, pass.as_deref(), &|done, total, msg| {
            emit_progress(&handle, "unpack", done, total, msg)
        })
        .map_err(|e| {
            let _ = fs::remove_dir_all(&staging_root);
            e
        })?;
        let _ = fs::remove_file(&envelope_tmp);

        // 校验通过才写标记
        let marker = serde_json::json!({
            "staging": format!("{RESTORE_STAGING_DIR}/content"),
            "createdAt": header.created_at,
            "device": header.device,
            "fileCount": header.files.len(),
        });
        fs::write(
            data_dir.join(PENDING_RESTORE_FILE),
            serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("写入待恢复标记失败: {e}"))?;

        Ok(RestoreStagedResult {
            header: BackupHeaderSummary::from(&header),
            needs_restart: true,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取本地备份包 header（恢复前 UI 判断是否需要口令）
#[tauri::command]
pub async fn backup_peek_header(path: String) -> Result<BackupHeaderSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut file =
            fs::File::open(&path).map_err(|e| format!("打开 {path}: {e}"))?;
        let mut prefix = vec![0u8; 8192];
        let n = file.read(&mut prefix).map_err(|e| e.to_string())?;
        prefix.truncate(n);
        let header = parse_header_from_prefix(&prefix)?;
        Ok(BackupHeaderSummary::from(&header))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn backup_restart_app(app: AppHandle) {
    app.restart();
}

// ---------------------------------------------------------------------------
// 启动期换入
// ---------------------------------------------------------------------------

/// setup 阶段（store::init 之前）调用：存在待恢复标记时，把当前数据挪到
/// pre-restore-<ts>/，staging 内容就位，删除标记。返回 Some(摘要) = 已换入。
///
/// 换入内容：state.db（连带删除旧 -wal/-shm，防止旧 WAL 应用到新库）、sessions/、
/// task-workspace/（staging 里有什么换什么）。随后清空 credentials——OS keychain
/// 主密钥不随备份走，换机后密文不可解，引导用户重输 API key。
pub fn apply_pending_restore(app: &AppHandle) -> Result<Option<String>, String> {
    let data_dir = app_data_dir(app)?;
    let marker_path = data_dir.join(PENDING_RESTORE_FILE);
    if !marker_path.exists() {
        return Ok(None);
    }
    let marker_raw = fs::read_to_string(&marker_path).unwrap_or_default();
    let staging_rel = serde_json::from_str::<serde_json::Value>(&marker_raw)
        .ok()
        .and_then(|v| v.get("staging").and_then(|s| s.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| format!("{RESTORE_STAGING_DIR}/content"));
    if staging_rel.contains("..") {
        return Err("待恢复标记包含非法路径".into());
    }
    let staging = data_dir.join(&staging_rel);
    if !staging.exists() {
        // staging 丢失（如用户手动清理）：删标记，按无恢复继续
        let _ = fs::remove_file(&marker_path);
        return Ok(None);
    }

    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let aside = data_dir.join(format!("pre-restore-{ts}"));
    fs::create_dir_all(&aside).map_err(|e| format!("create pre-restore dir: {e}"))?;

    // 可换入项：staging 有什么换什么；当前有的先进 aside
    let candidates = [DB_FILE, "state.db-wal", "state.db-shm", SESSIONS_DIR, TASK_WORKSPACE_DIR];
    for name in candidates {
        let current = data_dir.join(name);
        if current.exists() {
            fs::rename(&current, aside.join(name)).map_err(|e| format!("移出旧 {name}: {e}"))?;
        }
        let staged = staging.join(name);
        if staged.exists() {
            fs::rename(&staged, &current).map_err(|e| format!("换入 {name}: {e}"))?;
        }
    }

    // 换机恢复：OS keychain 主密钥不随备份走，旧密文在新机器不可解。
    // 本函数先于 store::init 执行，用独立连接清空 credentials 引导重输
    // （custom_providers 等非密配置完整保留）。
    let restored_db = data_dir.join(DB_FILE);
    if restored_db.exists() {
        if let Ok(conn) = rusqlite::Connection::open(&restored_db) {
            let _ = conn.execute("DELETE FROM credentials", []);
        }
    }

    let _ = fs::remove_dir_all(staging_root_dir(&data_dir, &staging_rel));
    let _ = fs::rename(&marker_path, aside.join("pending-restore.json.done"));
    let summary = serde_json::from_str::<serde_json::Value>(&marker_raw)
        .ok()
        .map(|v| {
            format!(
                "device={}, fileCount={}",
                v.get("device").and_then(|d| d.as_str()).unwrap_or("?"),
                v.get("fileCount").and_then(|f| f.as_u64()).unwrap_or(0)
            )
        })
        .unwrap_or_else(|| "ok".into());
    log::info!("[backup] pending restore applied: {summary}");
    Ok(Some(summary))
}

fn staging_root_dir(data_dir: &Path, staging_rel: &str) -> PathBuf {
    // staging_rel = "restore-staging/content" → 根 = 第一段
    let first = staging_rel.split('/').next().unwrap_or(RESTORE_STAGING_DIR);
    data_dir.join(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop_progress(_: u64, _: u64, _: &str) {}

    /// 搭一个迷你数据目录：假 state.db + 会话 JSONL（末行截断）+ 任务工作区
    fn fixture_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("piabk-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("sessions")).unwrap();
        fs::create_dir_all(dir.join("task-workspace")).unwrap();
        fs::write(dir.join("state.db"), b"fake-db-bytes").unwrap();
        fs::write(dir.join("sessions").join("s1.jsonl"), b"{\"type\":\"message\"}\n{\"type\":\"message\"}\n{\"torn\"").unwrap();
        fs::write(dir.join("task-workspace").join("a.txt"), b"agent output").unwrap();
        dir
    }

    #[test]
    fn roundtrip_plain_and_encrypted() {
        let src = fixture_dir("src");
        let (envelope, header) = pack_backup(
            &src.join("state.db"),
            &src,
            true,
            Some("口令-secret-42"),
            "test-device",
            "0.0.0-test",
            &noop_progress,
        )
        .unwrap();
        assert!(header.encrypted);
        assert!(header.kdf.is_some());
        assert_eq!(header.files.len(), 3); // state.db + s1.jsonl + a.txt
        assert_eq!(header.device, "test-device");

        // 正确口令：解包成功，内容一致，截断残行被修剪
        let dst = std::env::temp_dir().join(format!("piabk-dst-{}", uuid::Uuid::new_v4()));
        let hdr2 = unpack_backup(&envelope, &dst, Some("口令-secret-42"), &noop_progress).unwrap();
        assert_eq!(hdr2.payload_sha256, header.payload_sha256);
        assert_eq!(fs::read(dst.join("state.db")).unwrap(), b"fake-db-bytes");
        assert_eq!(fs::read(dst.join("task-workspace").join("a.txt")).unwrap(), b"agent output");
        let jsonl = fs::read(dst.join("sessions").join("s1.jsonl")).unwrap();
        assert_eq!(jsonl, b"{\"type\":\"message\"}\n{\"type\":\"message\"}\n");

        // 错误口令：GCM 校验失败
        let dst_bad = std::env::temp_dir().join(format!("piabk-dstbad-{}", uuid::Uuid::new_v4()));
        let err = unpack_backup(&envelope, &dst_bad, Some("wrong"), &noop_progress);
        assert!(err.is_err());

        // 前缀解析（header peek）识别加密标记
        let prefix = fs::read(&envelope).unwrap();
        let peeked = parse_header_from_prefix(&prefix[..4096.min(prefix.len())]).unwrap();
        assert!(peeked.encrypted);

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
        let _ = fs::remove_dir_all(&dst_bad);
        let _ = fs::remove_file(&envelope);
    }

    #[test]
    fn roundtrip_unencrypted_excludes_workspace_when_disabled() {
        let src = fixture_dir("src2");
        let (envelope, header) = pack_backup(
            &src.join("state.db"),
            &src,
            false,
            None,
            "d",
            "v",
            &noop_progress,
        )
        .unwrap();
        assert!(!header.encrypted);
        assert_eq!(header.files.len(), 2); // 无 task-workspace

        let dst = std::env::temp_dir().join(format!("piabk-dst2-{}", uuid::Uuid::new_v4()));
        unpack_backup(&envelope, &dst, None, &noop_progress).unwrap();
        assert!(!dst.join("task-workspace").join("a.txt").exists());
        assert_eq!(fs::read(dst.join("state.db")).unwrap(), b"fake-db-bytes");

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
        let _ = fs::remove_file(&envelope);
    }

    /// AWS SigV4 官方文档测试向量（S3 GET Object 示例）
    /// https://docs.aws.amazon.com/zh_cn/AmazonS3/latest/userguide/RESTAuthentication.html
    #[test]
    fn sigv4_aws_documented_vector() {
        let url = reqwest::Url::parse("https://examplebucket.s3.amazonaws.com/test.txt").unwrap();
        let auth = sigv4_authorization(
            "GET",
            &url,
            &[],
            &[("Range".to_string(), "bytes=0-9".to_string())],
            EMPTY_SHA256,
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "20130524T000000Z",
            "20130524",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn xml_scanner_handles_namespace_and_blocks() {
        let xml = r#"<ListBucketResult><IsTruncated>false</IsTruncated>
            <Contents><Key>backups/pi-backup-1.piabk</Key><Size>12</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>
            <Contents><Key>backups/pi-backup-2.piabk</Key><Size>34</Size><LastModified>2026-01-02T00:00:00.000Z</LastModified></Contents>
            </ListBucketResult>"#;
        let blocks = xml_blocks(xml, "Contents");
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            xml_first(&blocks[0], "Key").unwrap(),
            "backups/pi-backup-1.piabk"
        );
        assert_eq!(xml_first(&blocks[0], "Size").unwrap().trim(), "12");
        assert_eq!(
            xml_first(xml, "IsTruncated").unwrap().trim(),
            "false"
        );

        let dav = r#"<D:multistatus xmlns:D="DAV:">
            <D:response><D:href>/dav/dir/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
            <D:response><D:href>/dav/dir/pi-backup-3.piabk</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>99</D:getcontentlength><D:getlastmodified>Mon, 01 Sep 2026 00:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
            </D:multistatus>"#;
        let responses = xml_blocks(dav, "response");
        assert_eq!(responses.len(), 2);
        assert_eq!(xml_first(&responses[1], "getcontentlength").unwrap().trim(), "99");
    }

    #[test]
    fn s3_object_url_shapes() {        let mut cfg = BackupConfig::default();
        cfg.s3_bucket = "mybucket".into();
        cfg.s3_region = "us-west-2".into();
        let s3 = S3Config::from(&cfg).unwrap_err(); // 无密钥应报错
        assert!(s3.contains("密钥"));

        cfg.s3_access_key_id = "AK".into();
        cfg.s3_secret_access_key = "enc:v1:fake".into(); // 解密失败视为未配置
        assert!(S3Config::from(&cfg).is_err());

        // 用一个已解密形式直接构造，验证 URL 形状
        let s3 = S3Config {
            endpoint: String::new(),
            region: "us-west-2".into(),
            bucket: "mybucket".into(),
            prefix: "bk".into(),
            access_key_id: "AK".into(),
            secret_access_key: "SK".into(),
            path_style: false,
        };
        assert_eq!(
            s3.object_url(&s3.key("pi-backup-1.piabk")),
            "https://mybucket.s3.us-west-2.amazonaws.com/bk/pi-backup-1.piabk"
        );
        let s3p = S3Config {
            path_style: true,
            endpoint: "http://127.0.0.1:9000".into(),
            ..s3
        };
        assert_eq!(
            s3p.object_url(&s3p.key("pi-backup-1.piabk")),
            "http://127.0.0.1:9000/mybucket/bk/pi-backup-1.piabk"
        );
    }

    /// 端到端回归：对着本地最小 WebDAV 服务器（tests/webdav-server.mjs，需 node）
    /// 跑完整链路。运行：cargo test webdav_roundtrip -- --ignored
    #[test]
    #[ignore]
    fn webdav_roundtrip_against_local_server() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};

        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/webdav-server.mjs");
        let mut child = Command::new("node")
            .arg(&script)
            .env("DAV_USER", "user")
            .env("DAV_PASS", "pass")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("启动 node webdav 服务器失败（需要 node）");
        let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).expect("读取端口失败");
        let port: u16 = line.trim().parse().expect("端口解析失败");

        // 等端口就绪
        let mut ready = false;
        for _ in 0..50 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(ready, "webdav server did not start");

        let cfg = BackupConfig {
            provider: "webdav".into(),
            dav_url: format!("http://127.0.0.1:{port}/dav"),
            dav_username: "user".into(),
            dav_password: "pass".into(), // 明文兼容路径：decrypt 原样返回
            dav_subdir: "backups/deep".into(),
            ..Default::default()
        };
        let client = DavClient::new(DavConfig::from(&cfg).unwrap(), Duration::from_secs(10)).unwrap();

        // 建目录（逐级）→ 上传 → 列表 → 下载 → peek → 删除
        client.mkcol_deep().unwrap();
        let payload: Vec<u8> = (0..64 * 1024).map(|i| (i % 251) as u8).collect();
        client.put("pi-backup-test.piabk", payload.clone()).unwrap();

        let listed = client.list().unwrap();
        let hit = listed
            .iter()
            .find(|(n, s, _)| n == "pi-backup-test.piabk" && *s == payload.len() as u64);
        assert!(hit.is_some(), "上传后未在列表中找到: {listed:?}");

        let dst = std::env::temp_dir().join(format!("dav-dl-{}", uuid::Uuid::new_v4()));
        client.get_to_file("pi-backup-test.piabk", &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), payload);

        let prefix = client.get_prefix("pi-backup-test.piabk", 16).unwrap();
        assert_eq!(&prefix[..16], &payload[..16]);

        client.delete("pi-backup-test.piabk").unwrap();
        // 幂等：再删一次（已不存在）应返回 Ok(false) 而非报错
        assert!(!client.delete("pi-backup-test.piabk").unwrap());
        assert!(client
            .list()
            .unwrap()
            .iter()
            .all(|(n, _, _)| n != "pi-backup-test.piabk"));

        // 错误凭据 → 401 带上下文的错误
        let bad_cfg = BackupConfig {
            dav_username: "wrong".into(),
            ..cfg.clone()
        };
        let bad = DavClient::new(DavConfig::from(&bad_cfg).unwrap(), Duration::from_secs(5)).unwrap();
        let err = bad.list().err().expect("错误凭据应报错");
        assert!(err.contains("401"), "错误信息应包含状态码: {err}");
        assert!(err.contains("/dav/backups"), "错误信息应包含 URL: {err}");

        let _ = fs::remove_file(&dst);
        child.kill().ok();
    }

    /// 真实 WebDAV 服务器冒烟（凭据只从环境变量读，代码里不落任何密钥）：
    ///   DAV_URL=http://host:5005 DAV_USER=xxx DAV_PASS=xxx DAV_SUBDIR=home/pi-backups \
    ///   cargo test webdav_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn webdav_real_server_smoke() {
        let dav_url = std::env::var("DAV_URL").expect("设置 DAV_URL / DAV_USER / DAV_PASS 后运行");
        let cfg = BackupConfig {
            provider: "webdav".into(),
            dav_url,
            dav_username: std::env::var("DAV_USER").unwrap_or_default(),
            dav_password: std::env::var("DAV_PASS").unwrap_or_default(),
            dav_subdir: std::env::var("DAV_SUBDIR").unwrap_or_default(),
            ..Default::default()
        };
        let client =
            DavClient::new(DavConfig::from(&cfg).unwrap(), Duration::from_secs(20)).unwrap();

        client.mkcol_deep().unwrap();
        let probe_name = format!("pi-backup-probe-{}.piabk", uuid::Uuid::new_v4());
        let payload: Vec<u8> = (0..16 * 1024).map(|i| (i % 251) as u8).collect();
        client.put(&probe_name, payload.clone()).unwrap();

        let listed = client.list().unwrap();
        assert!(
            listed
                .iter()
                .any(|(n, s, _)| *n == probe_name && *s == payload.len() as u64),
            "列表缺少探测文件: {listed:?}"
        );

        let dst = std::env::temp_dir().join(&probe_name);
        client.get_to_file(&probe_name, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), payload);
        let prefix = client.get_prefix(&probe_name, 32).unwrap();
        assert_eq!(&prefix[..32], &payload[..32]);

        client.delete(&probe_name).unwrap();
        // 幂等：再删一次（已不存在）应返回 Ok(false) 而非报错
        assert!(!client.delete(&probe_name).unwrap());
        let _ = fs::remove_file(&dst);
        println!("real server smoke ok: {}/", cfg.dav_url,);
    }
}
