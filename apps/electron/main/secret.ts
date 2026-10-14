/**
 * 敏感值落盘（对齐 secret.rs）：当前明文直通；识别历史 `enc:v1:` 密文并判为缺失
 * （无原主密钥不可解，调用方引导重填）。想恢复加密只换这两个函数。
 */
export const PREFIX = "enc:v1:";

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function encrypt(plain: string): string {
  return plain;
}

export function decrypt(stored: string): { ok: true; value: string } | { ok: false; error: string } {
  if (isEncrypted(stored)) {
    return { ok: false, error: "encrypted value cannot be decrypted (keychain master key retired)" };
  }
  return { ok: true, value: stored };
}
