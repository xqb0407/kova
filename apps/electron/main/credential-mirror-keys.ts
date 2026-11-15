/**
 * kv 里哪些键会进桌面 → sidecar 的共享凭据镜像（~/.kova/credentials.json）。
 *
 * 单独成文件的原因：data.ts 的 kv_set 与 store.ts 的 kv_set/kv_delete 都要
 * 判断，而真正的重建实现（credential-file-sync）依赖 Electron 运行时；这层
 * 纯字符串判断不依赖任何模块，桌面主进程和单测都能直接引。
 */
export function isMirroredKvKey(key: string): boolean {
  // 默认模型（新会话与桌面同源）+ 动态发现缓存（AUTO 模型的唯一载体）
  return key === "pi.model" || key.startsWith("pi.dynamic-models.");
}
