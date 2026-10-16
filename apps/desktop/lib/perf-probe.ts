"use client";

/**
 * dev-only 台账探针：控制台 `window.__kovaPerf()` 一次打印各模块级台账的当前
 * 规模——验证「控制器注册表驻留 / prompt 台账 / Map store 增长」这类内存问题
 * 的仪表（前后对比用，不用学 heap snapshot）。
 *
 * 各模块在模块加载时 `registerPerfProbeSource` 登记 getter（代价是 Map 里一条
 * 闭包，生产可忽略）；`installPerfProbe` 只在 NODE_ENV !== production 时由
 * app-runtime-provider 调用——生产构建不会有 window 挂点。
 */
type ProbeValue = number | string | Record<string, number>;

const sources = new Map<string, () => ProbeValue>();

export function registerPerfProbeSource(name: string, read: () => ProbeValue): void {
  sources.set(name, read);
}

export function installPerfProbe(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__kovaPerf = () => {
    const out: Record<string, ProbeValue> = {};
    for (const [name, read] of sources) {
      try {
        out[name] = read();
      } catch (e) {
        out[name] = `error: ${String(e)}`;
      }
    }
    return out;
  };
}
