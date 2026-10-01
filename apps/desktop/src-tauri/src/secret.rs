//! 敏感值落盘：**当前不加密，明文存 SQLite**。
//!
//! 曾经的 AES-256-GCM + OS keychain 方案已下线。主密钥条目绑在代码签名身份上，
//! 而本地构建与 CI 打包都是 ad-hoc 签名（无 TeamIdentifier，见 docs/release.md），
//! 钥匙串给这类条目的 designated requirement 只能退化成整个二进制的 cdhash——
//! 每次重新构建都变。于是新二进制读不回旧条目，旧实现把它当成「首次运行」，
//! 生成新主密钥并覆盖旧槽位，所有已加密的凭据一次性报废，而失败表现只是
//! 「模型列表为空」，用户无从判断原因。已实测发生（见 docs/release.md 后续项）。
//!
//! 现在 `encrypt` / `decrypt` 是明文直通，但**保留对历史 `enc:v1:` 密文的识别**：
//! 那批值没有原主密钥就再也读不出来，一律按「缺失」处理（Err）并提示重填，
//! 重填后即为明文，不再复发。
//!
//! 想恢复加密：把下面两个函数换回 AES-256-GCM 实现即可，全部调用方无需改动。

/// 历史密文前缀。带此前缀的值 = 旧版本加密的、如今无法解密的值。
pub const PREFIX: &str = "enc:v1:";

/// 值是否是已无法解密的历史密文。
pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}

/// 落盘：原样返回（当前无加密，与入参相同）。
pub fn encrypt(plain: &str) -> String {
    plain.to_string()
}

/// 读取：明文原样返回；历史 `enc:v1:` 密文无法解密，按「凭据缺失」处理。
pub fn decrypt(stored: &str) -> Result<String, String> {
    if is_encrypted(stored) {
        return Err(
            "value was encrypted by an older build and can no longer be decrypted, please re-enter it"
                .into(),
        );
    }
    Ok(stored.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_passthrough() {
        assert_eq!(encrypt("sk-test-1234567890"), "sk-test-1234567890");
        assert_eq!(
            decrypt("sk-test-1234567890").unwrap(),
            "sk-test-1234567890"
        );
    }

    /// 历史密文不得被当明文原样吐出去——那会把一段 base64 直接塞进 API 请求。
    #[test]
    fn legacy_ciphertext_reads_as_missing() {
        let ct = format!("{PREFIX}VDgq0AAAA");
        assert!(is_encrypted(&ct));
        assert!(decrypt(&ct).is_err());
        // 前缀必须逐字符匹配，别把正常明文误判成密文
        assert!(!is_encrypted("sk-enc:v1:not-really"));
    }
}
