import { describe, expect, test } from "bun:test";
import {
  AES_PREFIX,
  decryptWithKey,
  encryptWithKey,
  isAesCiphertext,
  isCiphertext,
  isLegacyCiphertext,
  randomSecretKey,
  redactSecrets,
} from "../main/secret-crypto";

describe("secret-crypto", () => {
  test("AES-256-GCM 往返", () => {
    const key = randomSecretKey();
    const plain = "sk-test-1234567890";
    const stored = encryptWithKey(plain, key);
    expect(stored.startsWith(AES_PREFIX)).toBe(true);
    expect(isAesCiphertext(stored)).toBe(true);
    expect(decryptWithKey(stored, key)).toEqual({ ok: true, value: plain });
  });

  test("错误密钥解不开", () => {
    const stored = encryptWithKey("secret-value", randomSecretKey());
    const dec = decryptWithKey(stored, randomSecretKey());
    expect(dec.ok).toBe(false);
  });

  test("篡改密文触发 GCM 校验失败", () => {
    const key = randomSecretKey();
    const stored = encryptWithKey("secret-value", key);
    const body = Buffer.from(stored.slice(AES_PREFIX.length), "base64");
    body[body.length - 1] ^= 0xff;
    const tampered = AES_PREFIX + body.toString("base64");
    expect(decryptWithKey(tampered, key).ok).toBe(false);
  });

  test("旧 Rust 密文与普通值可区分", () => {
    expect(isLegacyCiphertext("enc:v1:abc")).toBe(true);
    expect(isCiphertext("enc:v1:abc")).toBe(true);
    expect(isCiphertext("plain")).toBe(false);
  });

  test("密钥长度不合法直接拒绝", () => {
    expect(() => encryptWithKey("x", Buffer.alloc(16))).toThrow();
  });

  test("redactSecrets 替换原值与 base64，短值跳过", () => {
    const value = "sk-1234567890";
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const out = redactSecrets(`a ${value} b ${b64}`, [{ name: "TOKEN", value }]);
    expect(out).toBe("a [REDACTED:TOKEN] b [REDACTED:TOKEN]");
    expect(redactSecrets("short", [{ name: "S", value: "short" }])).toBe("short");
  });
});
