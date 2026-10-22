import {
  networkDeniedMessage,
  planAllowsNetwork,
  planAllowsRead,
  planAllowsWrite,
  readDeniedMessage,
  resolveToolPath,
  writeDeniedMessage,
  type SandboxPlan,
} from "pi-sandbox";

/** 读取工具：workspace 档只拦高危密钥目录；strict 档未来按 readRoots 白名单。 */
export function assertReadAllowed(
  plan: SandboxPlan | undefined,
  cwd: string,
  filePath: string,
): void {
  if (!plan) return;
  const target = resolveToolPath(cwd, filePath);
  if (!planAllowsRead(plan, target)) throw new Error(readDeniedMessage(target));
}

/** write/edit：即使审批档是 auto，也只能落在 plan 的写根内。 */
export function assertWriteAllowed(
  plan: SandboxPlan | undefined,
  cwd: string,
  filePath: string,
): void {
  if (!plan) return;
  const target = resolveToolPath(cwd, filePath);
  if (!planAllowsWrite(plan, target)) throw new Error(writeDeniedMessage(plan, target));
}

export function assertNetworkAllowed(plan: SandboxPlan | undefined): void {
  if (!plan) return;
  if (!planAllowsNetwork(plan)) throw new Error(networkDeniedMessage());
}

export type SandboxToolInfo = {
  tier: "workspace";
  /** seatbelt = OS 沙箱；host = 宿主路径/网络校验；none = 没有生效的沙箱。 */
  backend: "seatbelt" | "host" | "none";
  network: "allow" | "deny";
  denied?: "write" | "read" | "network" | "unavailable";
};

export function sandboxInfo(
  plan: SandboxPlan | undefined,
  backend: "seatbelt" | "host" | "none",
  denied?: SandboxToolInfo["denied"],
): SandboxToolInfo | undefined {
  if (!plan) return undefined;
  return {
    tier: plan.tier,
    backend,
    network: plan.network,
    ...(denied ? { denied } : {}),
  };
}
