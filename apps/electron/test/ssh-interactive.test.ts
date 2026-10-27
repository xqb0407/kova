/**
 * 终端面板的交互式 SSH 参数构造：远程项目终端必须允许密码交互
 *（不带 BatchMode）、按认证类型选目标、登录后 cd 到项目目录。
 */
import { describe, expect, test } from "bun:test";
import { buildInteractiveSshArgs } from "../main/sshInteractive";
import type { SshHost } from "../main/ssh";

const base = (patch: Partial<SshHost>): SshHost => ({
  id: "h1",
  name: "h",
  hostname: "example.com",
  enabled: true,
  createdAt: "",
  authType: "agent",
  ...patch,
});

const argValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("buildInteractiveSshArgs", () => {
  test("别名主机：直接用 alias，不带 -p/-i，且不使用 BatchMode", () => {
    const args = buildInteractiveSshArgs(
      base({ alias: "dev-box", hostname: "", port: 2222, username: "ubuntu" }),
      "/home/dcs",
    );
    expect(args).toContain("dev-box");
    expect(args.includes("-p")).toBe(false);
    expect(args.includes("-i")).toBe(false);
    expect(args.join(" ").includes("BatchMode")).toBe(false);
    // 登录后 cd + 登录 shell
    const cmd = args[args.length - 1]!;
    expect(cmd).toContain("cd '/home/dcs'");
    expect(cmd).toContain("SHELL:-/bin/sh");
  });

  test("私钥主机：带 -i 与 -p，用户@主机", () => {
    const args = buildInteractiveSshArgs(
      base({ authType: "key", username: "deploy", port: 2202, privateKeyPath: "~/.ssh/id_ed25519" }),
      "/srv/app",
    );
    expect(args).toContain("deploy@example.com");
    expect(argValue(args, "-p")).toBe("2202");
    expect(argValue(args, "-i")).toBe("~/.ssh/id_ed25519");
    expect(args.join(" ").includes("BatchMode")).toBe(false);
  });

  test("密码主机：允许交互认证（不能有 BatchMode），仍带主机与端口", () => {
    const args = buildInteractiveSshArgs(
      base({ authType: "password", username: "zkuser", port: 22 }),
      "/home/dcs",
    );
    expect(args).toContain("zkuser@example.com");
    expect(args.join(" ").includes("BatchMode")).toBe(false);
    expect(args.join(" ").includes("IdentitiesOnly")).toBe(false);
  });

  test("含空格/引号的目录安全转义", () => {
    const args = buildInteractiveSshArgs(base({ alias: "h" }), "/home/a b/it's");
    const cmd = args[args.length - 1]!;
    expect(cmd).toContain(`cd '/home/a b/it'\\''s'`);
  });

  test("无 cwd：不追加 -t 与 cd 命令", () => {
    const args = buildInteractiveSshArgs(base({ alias: "h" }));
    expect(args.includes("-t")).toBe(false);
    expect(args[args.length - 1]).toBe("h");
  });
});
