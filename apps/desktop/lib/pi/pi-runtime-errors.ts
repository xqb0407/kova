"use client";

import { toast } from "@/components/ui/toast";

/**
 * 运行时错误的用户提示去重。
 *
 * 通道断连、侧车假死、服务器不可达这类故障有一个共同特征：**失败会成串来**
 * ——会话列表刷新、运行态轮询、偏好水合各自在飞，每条都走 onError，逐条弹
 * toast 并 console.error 的观感就是"应用崩了"（dev 下 Next 的 overlay 会逐条
 * 糊满屏幕，反而把真正的原因淹掉）。真实的链路状态该由顶部横幅承担（见
 * remote-runtime-provider 的断连条），这里只做两件事：
 * - 同一条错误（消息文本相同）在 SUPPRESS_MS 窗口内只提示一次；
 * - 窗口内被折叠的次数，在下一次放行时一并说明（不丢信息）。
 *
 * 不做跨进程/跨请求的归并：不同原因的失败必须各自可见，否则会掩盖真问题。
 */
const SUPPRESS_MS = 8000;
/** 消息文本 -> 上次放行时间；键随报错内容变化（含倒计时/URL 的文案会自然分桶） */
const lastShown = new Map<string, number>();
/** 消息文本 -> 窗口内被折叠的次数 */
const suppressed = new Map<string, number>();

export function reportPiRuntimeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const seenAt = lastShown.get(message) ?? 0;
  if (now - seenAt < SUPPRESS_MS) {
    suppressed.set(message, (suppressed.get(message) ?? 0) + 1);
    // 键可能因文案里带可变片段而无界增长：顺手淘汰出窗的旧键
    if (lastShown.size > 64) {
      for (const [key, at] of lastShown) {
        if (now - at >= SUPPRESS_MS) lastShown.delete(key);
      }
    }
    return;
  }
  const repeats = suppressed.get(message) ?? 0;
  suppressed.delete(message);
  lastShown.set(message, now);
  console.error("[pi-runtime]", error, repeats > 0 ? `（同类错误另有 ${repeats} 次已折叠）` : "");
  toast.error(repeats > 0 ? `${message}（同类错误另有 ${repeats} 次）` : message);
}

/** 测试用：清掉去重窗口 */
export function resetPiRuntimeErrorReportForTest(): void {
  lastShown.clear();
  suppressed.clear();
}