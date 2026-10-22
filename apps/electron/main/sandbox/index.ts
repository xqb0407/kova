import type { SandboxPlan } from "pi-sandbox";
import { isSeatbeltAvailable, wrapSeatbeltCommand } from "./seatbelt";

export type SandboxBackend = "seatbelt" | "none";

/**
 * 宿主收到的是 sidecar 生成的纯数据；这里只做形状校验，防止坏计划把
 * 沙箱静默降级成无沙箱执行。
 */
export function parseSandboxPlan(value: unknown): SandboxPlan | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlan(value)) throw new Error("sandbox: invalid plan");
  return value;
}

export function resolveBackend(plan: SandboxPlan): SandboxBackend {
  if (plan.platform === "darwin" && isSeatbeltAvailable()) return "seatbelt";
  return "none";
}

export function wrapSandboxCommand(
  command: string,
  plan: SandboxPlan,
): { file: string; args: string[]; backend: SandboxBackend } | null {
  if (resolveBackend(plan) === "seatbelt") return wrapSeatbeltCommand(command, plan);
  return null;
}

/** 沙箱命令的临时目录必须落在 plan.tempRoots 内；否则 npm/make 写 $TMPDIR 会被拒。 */
export function sandboxEnvOverrides(
  plan: SandboxPlan | undefined,
  backend: SandboxBackend,
): Record<string, string> {
  const temp = plan?.tempRoots[0];
  if (!plan || backend !== "seatbelt" || !temp) return {};
  return { TMPDIR: temp, TMP: temp, TEMP: temp };
}

/**
 * V1 只有 macOS 承诺 OS 隔离；Windows 明确按“无 OS 沙箱”执行 bash。
 * 因此只在 darwin 且后端缺失时遵守 onUnavailable。
 */
export function isUnavailableBlocking(plan: SandboxPlan): boolean {
  return (
    plan.platform === "darwin" &&
    resolveBackend(plan) === "none" &&
    plan.onUnavailable === "deny"
  );
}

function isPlan(value: unknown): value is SandboxPlan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Record<string, unknown>;
  return (
    plan.version === 1 &&
    plan.tier === "workspace" &&
    (plan.platform === "darwin" ||
      plan.platform === "win32" ||
      plan.platform === "linux" ||
      plan.platform === "other") &&
    typeof plan.cwd === "string" &&
    isStringArray(plan.readRoots) &&
    isStringArray(plan.denyReadRoots) &&
    isStringArray(plan.denyWritePaths) &&
    isStringArray(plan.writeRoots) &&
    isStringArray(plan.tempRoots) &&
    isStringArray(plan.cacheRoots) &&
    (plan.network === "allow" || plan.network === "deny") &&
    (plan.onUnavailable === "deny" || plan.onUnavailable === "allow")
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => typeof item === "string")
  );
}
