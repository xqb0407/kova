/**
 * 平台适配层：承接主工程里所有「桌面 Tauri 专属」的能力调用。
 *
 * 主工程的三条传输/宿主假设在移动端都不成立，这里逐一给出等价或明确的拒绝：
 *
 * 1. `isTauri()` —— 移动端永远是 false。拷贝过来的偏好 store 用它区分
 *    「读写桌面宿主 kv」与「走侧车协议」，恒 false 即让它们改走侧车/本地存储。
 *
 * 2. `invoke(cmd, args)` —— 拷贝过来的模块只用它做**宿主 kv 持久化**
 *    （kv_set / kv_delete，偏好项：工作区目录、选中模型、思考档位）。
 *    这些在桌面端由 Rust 宿主持有，移动端改由 AsyncStorage 承担。
 *    其余命令一律拒绝——远程网关本来就禁掉了这些（remote.rs 的
 *    REMOTE_DENIED_TYPES），在客户端侧同样早失败比让 404 式报错更好定位。
 *
 * 3. 凭据 token —— 走 expo-secure-store（见 secure-store.ts），不进这里。
 */
import { syncStorage } from "./storage";

/** 恒 false：移动端没有 Tauri 宿主。 */
export function isTauri(): boolean {
  return false;
}

/** 宿主 kv 键 → AsyncStorage 键的映射规则：原样复用，保持与桌面端同名，
 *  便于排查问题时对照 kv 面板。 */
function kvKey(key: string): string {
  return key.startsWith("pi.") ? key : `pi.${key}`;
}

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (cmd) {
    case "kv_set": {
      const key = String(args?.key ?? "");
      const value = String(args?.value ?? "");
      syncStorage.setItem(kvKey(key), value);
      return null as T;
    }
    case "kv_delete": {
      const key = String(args?.key ?? "");
      syncStorage.removeItem(kvKey(key));
      return null as T;
    }
    case "kv_get": {
      const key = String(args?.key ?? "");
      return syncStorage.getItem(kvKey(key)) as T;
    }
    default:
      throw new Error(
        `「${cmd}」是桌面端专属命令，移动端不支持（远程网关同样禁用）`,
      );
  }
}