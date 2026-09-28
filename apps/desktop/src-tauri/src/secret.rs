//! 敏感数据落盘加密：AES-256-GCM，主密钥 32B 随机生成、存 OS keychain
//! （Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
//!
//! 密文格式 `enc:v1:<base64(nonce‖ciphertext)>`（12B 随机 nonce + GCM tag）。
//! 无此前缀的存量值按旧明文读取（兼容），首次写回时自动升级为密文——
//! 因此本模块不提供"解密失败回退明文"，失败就是失败（调用方按缺失处理）。
//!
//! 降级：keychain 完全不可用（如无 libsecret 的 Linux 会话）时主密钥无法
//! 生成/读取，加密退化为明文透传并 warn 一次；期间新写入保持明文、不损坏
//! 既有密文（解密带密文时读不到主密钥会显式报错）。绝不静默丢数据。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use base64::Engine as _;
use std::sync::OnceLock;

const SERVICE: &str = "com.kova.assistant";
const ACCOUNT: &str = "master.key";
/// 密文值前缀；无前缀 = 旧明文
pub const PREFIX: &str = "enc:v1:";

fn b64() -> impl base64::Engine {
    base64::engine::general_purpose::STANDARD
}

/// 12B nonce / 32B 主密钥均由 UUIDv4 拼接取字节：OS CSPRNG，熵充足，
/// 免去 rand/aead 的 rand_core 跨版本互操作问题。
fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let mut filled = 0;
    while filled < N {
        let b = uuid::Uuid::new_v4().into_bytes();
        let take = (N - filled).min(b.len());
        out[filled..filled + take].copy_from_slice(&b[..take]);
        filled += take;
    }
    out
}

fn encrypt_with(key: &[u8; 32], plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = random_bytes::<12>();
    let ct = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);
    Ok(format!("{}{}", PREFIX, b64().encode(blob)))
}

fn decrypt_with(key: &[u8; 32], stored: &str) -> Result<String, String> {
    let rest = stored
        .strip_prefix(PREFIX)
        .ok_or("value is not encrypted")?;
    let blob = b64().decode(rest).map_err(|e| format!("bad base64: {e}"))?;
    if blob.len() < 13 {
        return Err("ciphertext too short".into());
    }
    let (nonce, ct) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(nonce), ct)
        .map_err(|_| "decrypt failed (wrong key or tampered data)")?;
    String::from_utf8(plain).map_err(|e| format!("not utf8: {e}"))
}

fn load_or_create_master_key() -> Result<[u8; 32], String> {
    // dev 构建：主密钥放本地文件而非 OS keychain——每次重编译二进制签名都会变，
    // macOS Keychain 会因 ACL 拒读，旧实现读失败后误轮换主钥导致全部密文报废
    // （"重输就好、重启又 401"死循环）。release 构建签名稳定，仍走 keychain。
    #[cfg(debug_assertions)]
    if let Some(path) = dev_master_key_path() {
        return load_or_create_dev_key(path);
    }
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(b64key) => {
            if let Ok(bytes) = b64().decode(&b64key) {
                if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    return Ok(key);
                }
            }
            // 内容损坏/格式不认识：旧钥已不可读，只能重新生成（密文按缺失处理）
            log::warn!("[secret] master key content invalid, regenerating");
        }
        Err(keyring::Error::NoEntry) => {} // 首次运行：生成新钥
        // 读取失败≠不存在（ACL 拒绝/服务不可用）：绝不覆盖轮换——轮换会让
        // 既有密文全部不可解，宁降级为明文透传（见 master_key()）
        Err(e) => return Err(format!("cannot read master key: {e}")),
    }
    let key = random_bytes::<32>();
    entry
        .set_password(&b64().encode(key))
        .map_err(|e| format!("cannot store master key: {e}"))?;
    Ok(key)
}

/// dev 主密钥文件路径：与 Tauri app_data_dir 同位（与 tauri.dev.conf.json 的
/// dev identifier 保持一致；dev 构建必须经 `bun run tauri:dev` 启动，
/// 裸 `cargo run` 不带 --config 会落回正式 identifier）。
/// 已知取舍：dev 密钥在文件、release 在 keychain，二者密文互不可读——
/// 从 dev 切到 release 首次需要重输凭据（反之亦然），属可接受的代价。
#[cfg(debug_assertions)]
fn dev_master_key_path() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    const IDENTIFIER: &str = "com.kova.assistant.dev";
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)?
        .join("Library/Application Support");
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join(IDENTIFIER).join("master.dev.key"))
}

/// dev 构建：从本地文件读/建主密钥（0600 语义由目录权限兜底，仅 dev 使用）
#[cfg(debug_assertions)]
fn load_or_create_dev_key(path: std::path::PathBuf) -> Result<[u8; 32], String> {
    use std::fs;
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(bytes) = b64().decode(content.trim()) {
            if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Ok(key);
            }
        }
        log::warn!("[secret] dev master key file invalid, regenerating");
    }
    let key = random_bytes::<32>();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, b64().encode(key)).map_err(|e| e.to_string())?;
    Ok(key)
}

/// 缓存主密钥；None = keychain 不可用（降级模式）。仅成功加载一次。
fn master_key() -> Option<&'static [u8; 32]> {
    static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    KEY.get_or_init(|| match load_or_create_master_key() {
        Ok(k) => Some(k),
        Err(e) => {
            log::warn!("[secret] master key unavailable, secrets stored as plaintext: {e}");
            None
        }
    })
    .as_ref()
}

/// 主密钥是否可用（降级模式下迁移等批量操作可整体跳过）
pub fn available() -> bool {
    master_key().is_some()
}

pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// 加密；keychain 不可用时明文透传（降级，不损坏数据）。
/// 已是密文（带前缀）的值原样返回，幂等。
pub fn encrypt(plain: &str) -> String {
    if is_encrypted(plain) {
        return plain.to_string();
    }
    let Some(key) = master_key() else {
        return plain.to_string();
    };
    match encrypt_with(key, plain) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[secret] encrypt failed, storing plaintext: {e}");
            plain.to_string()
        }
    }
}

/// 解密；无 `enc:v1:` 前缀的旧明文直接返回。
/// Err = 密文但主密钥不可用/不匹配（调用方按"凭据缺失"处理，提示重输）。
pub fn decrypt(stored: &str) -> Result<String, String> {
    if !is_encrypted(stored) {
        return Ok(stored.to_string());
    }
    let Some(key) = master_key() else {
        return Err("value is encrypted but master key is unavailable".into());
    };
    decrypt_with(key, stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不依赖 keychain 的核心往返测试（CI/无密钥环环境可跑）
    #[test]
    fn roundtrip_and_legacy_passthrough() {
        let key = [7u8; 32];
        let ct = encrypt_with(&key, "sk-test-1234567890").unwrap();
        assert!(ct.starts_with(PREFIX));
        assert!(!ct.contains("sk-test"));
        assert_eq!(decrypt_with(&key, &ct).unwrap(), "sk-test-1234567890");
        // 同值两次加密 nonce 不同 → 密文不同，均可解密
        let ct2 = encrypt_with(&key, "sk-test-1234567890").unwrap();
        assert_ne!(ct, ct2);
        assert_eq!(decrypt_with(&key, &ct2).unwrap(), "sk-test-1234567890");
        // 错误密钥 / 篡改密文 → Err；无前缀旧明文在 decrypt 中原样通过
        assert!(decrypt_with(&[9u8; 32], &ct).is_err());
        let mut bad = ct.clone();
        bad.pop();
        assert!(decrypt_with(&key, &bad).is_err());
        assert!(!is_encrypted("sk-plain-old"));
    }
}
