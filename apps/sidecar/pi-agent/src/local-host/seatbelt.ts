import { spawnSync } from "node:child_process";
import type { SandboxPlan } from "pi-sandbox";

let available: boolean | undefined;

/** macOS 的 Seatbelt 是系统自带能力；启动时 probe 一次并缓存。 */
export function isSeatbeltAvailable(): boolean {
  if (available !== undefined) return available;
  if (process.platform !== "darwin") {
    available = false;
    return false;
  }
  try {
    const probe = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", "(version 1)(allow default)", "/usr/bin/true"],
      { timeout: 3_000, stdio: "ignore" },
    );
    available = probe.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/**
 * workspace 档 profile：默认放行，只关闭写；再把计划里的写根逐个放回。
 * 这是“写隔离”而不是“default deny”，优先保证 git/node/npm 的兼容性。
 */
export function buildSeatbeltProfile(plan: SandboxPlan): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];

  const writes = plan.writeRoots
    .map((root) => `  (subpath ${quote(root)})`)
    .join("\n");
  if (writes) lines.push(`(allow file-write*\n${writes}\n)`);

  // 设备文件不是普通文件；不显式放行会让 echo/tee/部分构建工具莫名失败。
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") ' +
      '(literal "/dev/stderr") (literal "/dev/tty") (subpath "/dev/fd"))',
  );

  if (plan.denyWritePaths.length) {
    // 必须放在 allow file-write* 之后：具体文件比目录 subpath 更具体，
    // 用来挡住 Agent 改写自己的授权清单。
    const deniedWrites = plan.denyWritePaths
      .map((path) => `  (literal ${quote(path)})`)
      .join("\n");
    lines.push(`(deny file-write*\n${deniedWrites}\n)`);
  }

  if (plan.denyReadRoots.length) {
    const denied = plan.denyReadRoots
      .map((root) => `  (subpath ${quote(root)})`)
      .join("\n");
    lines.push(`(deny file-read*\n${denied}\n)`);
  }

  // AppleScript 能把动作转交给容器外的应用；即使只做写隔离也一并关掉。
  lines.push("(deny appleevent-send)");

  if (plan.network === "deny") lines.push("(deny network*)");

  return lines.join("\n");
}

export function wrapSeatbeltCommand(
  command: string,
  plan: SandboxPlan,
): { file: string; args: string[]; backend: "seatbelt" } {
  return {
    file: "/usr/bin/sandbox-exec",
    args: ["-p", buildSeatbeltProfile(plan), "/bin/bash", "-c", command],
    backend: "seatbelt",
  };
}

/** Seatbelt 字符串字面量转义；含 NUL/换行的路径直接拒绝（fail closed）。 */
function quote(value: string): string {
  if (/[\0\n\r]/.test(value)) {
    throw new Error(`sandbox: invalid path ${JSON.stringify(value)}`);
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
