/**
 * 同步存储垫片：把主工程里直接用 `window.localStorage` 的偏好模块
 * （app-mode 的播种/持久化）搬到 RN。
 *
 * 为什么需要它而不是直接用 AsyncStorage：localStorage 是**同步** API，而
 * AsyncStorage 是 Promise。拷贝过来的 store 在模块初始化时同步读播种值，
 * 换成异步会打破「首次渲染即拿到正确档位」的不变式。
 *
 * 做法：内存 Map 作为同步真值（hydrate 后即完整），写操作同步更新 Map 并
 * 异步落盘（fire-and-forget，写失败只丢偏好不阻塞交互）。
 *
 * 启动时必须 await hydrateStorage() 一次再挂载运行时，否则首帧读到空 Map。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

/** 本应用拥有的键前缀。hydrate 只捞这个前缀下的键，避免把 AsyncStorage 里
 *  其它模块的数据也拉进内存。 */
const PREFIX = "pi.";

const memory = new Map<string, string>();

/** 同步 localStorage 兼容面（只有这三个方法被用到） */
export const syncStorage = {
  getItem(key: string): string | null {
    return memory.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    void AsyncStorage.setItem(key, value).catch(() => {
      /* 偏好落盘失败不影响本次会话体验 */
    });
  },
  removeItem(key: string): void {
    memory.delete(key);
    void AsyncStorage.removeItem(key).catch(() => {
      /* 同上 */
    });
  },
};

/**
 * 从 AsyncStorage 恢复全部 pi.* 键到内存。必须在挂载 runtime 之前 await。
 * 幂等：重复调用只是重新覆盖同一批键。
 */
export async function hydrateStorage(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  await Promise.all(
    keys
      .filter((k) => k.startsWith(PREFIX))
      .map(async (k) => {
        const v = await AsyncStorage.getItem(k);
        if (v !== null) memory.set(k, v);
      }),
  );
}