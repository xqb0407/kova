/**
 * 请求 id 生成。
 *
 * 主工程用 `crypto.randomUUID()`（浏览器 / Node 19+ 内置）。React Native 的
 * Hermes 不带完整 WebCrypto，`crypto.randomUUID` 在真机上不存在——直接调用会
 * 在建会话和发 prompt 时崩。所以换用 expo-crypto 的实现，它底层走原生
 * SecurityRandom，强度与用途都对得上（这里是会话/request 标识，不是密钥）。
 *
 * 另外保留一个单调计数器做兜底：万一原生模块不可用（如 Expo Go 之外的自建
 * 壳忘了链接），至少 id 仍唯一，不至于把所有请求都打成同一个 id。
 */
import * as Crypto from "expo-crypto";

let fallbackCounter = 0;

export function newRequestId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    fallbackCounter += 1;
    return `fb-${Date.now().toString(36)}-${fallbackCounter}`;
  }
}