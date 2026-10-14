/**
 * 配对凭据存储。
 *
 * token 是远程网关的长效凭据（64hex，桌面端 kv 加密落盘、跨重启有效），
 * 拿到它等于拿到这台机器上的完整对话权限。所以走 expo-secure-store：
 * iOS 进 Keychain、Android 进 Keystore 加密分区，不进 AsyncStorage 明文区，
 * 也不会随 iCloud/备份导出。
 *
 * 桌面端配对入口在 设置 → 远程访问：先生成 6 位配对码并显示二维码，手机扫一次
 * 即完成 pair，服务端下发 token，之后每次连接都用 auth + token。
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/**
 * Web 预览：SDK 57 的 expo-secure-store 在浏览器侧是空实现（ExpoSecureStore.web
 * 只导出 {}），getItemAsync 直接炸。浏览器里没有真正的安全飞地，预览/演示用
 * localStorage 兜底即可——但要清楚它不是加密存储，真凭据别在 web 端配对，
 * 真机（Keychain/Keystore）才走 expo-secure-store。
 */
const webStore = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* 隐私模式配额满等：静默失败，下次重新配对 */
    }
  },
  del(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* 同上 */
    }
  },
};

const TOKEN_KEY = "pi_remote_token";
const HOST_KEY = "pi_remote_host";

export type RemoteConfig = {
  /** 网关地址，如 ws://192.168.1.5:8787/ws */
  url: string;
  /** 配对成功后服务端下发的长效 token */
  token: string;
};

export async function saveRemoteConfig(config: RemoteConfig): Promise<void> {
  if (Platform.OS === "web") {
    webStore.set(HOST_KEY, config.url);
    webStore.set(TOKEN_KEY, config.token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, config.token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  // host 不是秘密，但要与 token 成对存在；同样放 SecureStore 以免出现
  // "有 token 找不到 host" 的半截状态。
  await SecureStore.setItemAsync(HOST_KEY, config.url);
}

export async function loadRemoteConfig(): Promise<RemoteConfig | null> {
  if (Platform.OS === "web") {
    const url = webStore.get(HOST_KEY);
    const token = webStore.get(TOKEN_KEY);
    return url && token ? { url, token } : null;
  }
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(HOST_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!url || !token) return null;
  return { url, token };
}

export async function clearRemoteConfig(): Promise<void> {
  if (Platform.OS === "web") {
    webStore.del(HOST_KEY);
    webStore.del(TOKEN_KEY);
    return;
  }
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(HOST_KEY),
  ]);
}

// ---------- 网关地址规范化（配对载荷解析见 pair-payload.ts） ----------

/** 把网关 host 规范成带 /ws 的完整 ws 地址 */
export function normalizeWsUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(trimmed)) {
    return /\/ws$/.test(trimmed) ? trimmed : `${trimmed}/ws`;
  }
  // 允许只填 "192.168.1.5:8787" 或 "192.168.1.5"
  return `ws://${trimmed.replace(/^:\/\//, "")}/ws`;
}