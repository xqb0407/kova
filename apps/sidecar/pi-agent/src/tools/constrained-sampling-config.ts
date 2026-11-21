/**
 * constrained sampling 总开关（kv key = pi.constrained_sampling）。
 *
 * edit 工具的参数结构最容易吐坏（批量成员、长 oldText），开启时按
 * strict json_schema 约束采样（strict: "prefer"——不支持的 provider 由 pi-ai
 * 自动回退到普通采样）。默认开；设置页尚未出开关，走 kv 启动恢复 +
 * env `KOVA_CONSTRAINED_SAMPLING=off` 兜底关闭。与 vision/browser 配置同一
 * 缓存模式：异步 init 载内存，buildTools 同步读。
 */
import { kvGet } from "../storage/hostdb";
import { logErr } from "../log";

export const CONSTRAINED_SAMPLING_KV_KEY = "pi.constrained_sampling";

let enabled = true;

export function constrainedSamplingEnabled(): boolean {
  if (process.env.KOVA_CONSTRAINED_SAMPLING?.trim().toLowerCase() === "off") return false;
  return enabled;
}

/** 启动恢复：kv 里的 JSON `{"enabled": boolean}` 载入内存；失败保持默认（开） */
export async function initConstrainedSamplingConfig(): Promise<void> {
  try {
    const row = await kvGet(CONSTRAINED_SAMPLING_KV_KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { enabled?: unknown };
      enabled = parsed.enabled !== false;
    }
  } catch (err) {
    logErr("constrained-sampling-config: load failed:", err);
  }
}

/** 测试辅助：直接置内存态（不落 kv） */
export function setConstrainedSamplingForTest(next: boolean): void {
  enabled = next;
}
