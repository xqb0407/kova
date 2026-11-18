/**
 * 群聊联调辅助：平台群消息的真实字段（尤其钉钉 isInAtList、企微 @ 编码）
 * 在 SDK 类型里并不完整。设置 `KOVA_LOG_IM_RAW=1` 后把原始帧截断写入日志，
 * 便于在真实群里确认一遍解析假设；默认完全无开销。
 */
import { logInfo } from "../logging";

export function logImRaw(platform: string, frame: unknown): void {
  if (process.env.KOVA_LOG_IM_RAW !== "1") return;
  try {
    const text = JSON.stringify(frame);
    logInfo(`[im/raw] ${platform} ${text.slice(0, 8000)}`);
  } catch {
    // 循环引用等异常帧不阻断入站
  }
}
