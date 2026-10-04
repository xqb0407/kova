/**
 * 边界校验策略（设计文档 §9）：dev/test 严格（parse-throw 暴露契约漂移），
 * 生产宽松（safeParse，失败记 reporter 放行——契约 bug 不得变成可用性事故）。
 * reporter 由宿主注入（sidecar=logErr，desktop=console.warn），包自身零依赖环境判断。
 */
import type { z } from "zod";

export type FrameReporter = (where: string, issue: unknown) => void;

/** strict = dev/test 抛错；宽松 = 只上报不拦 */
export function checkFrame<T extends z.ZodTypeAny>(
  schema: T,
  frame: unknown,
  opts: { strict: boolean; where: string; report: FrameReporter },
): z.infer<T> {
  const parsed = schema.safeParse(frame);
  if (parsed.success) return parsed.data as z.infer<T>;
  if (opts.strict) {
    throw new Error(
      `pi-protocol contract violation at ${opts.where}: ${parsed.error.message}`,
    );
  }
  opts.report(opts.where, parsed.error.issues);
  return frame as z.infer<T>;
}

const NODE_ENV = (
  globalThis as { process?: { env?: Record<string, string | undefined> } }
).process?.env?.NODE_ENV;

/** 两端通用的 strict 判定：非 production 环境即严格校验 */
export const isStrictEnv = NODE_ENV !== "production";
