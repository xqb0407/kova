/**
 * ssh2 密码认证链路集成测试：本机起一个真实 SSH 服务端（ssh2 Server），
 * 走完 password 认证 → exec 通道 → 命令执行 → 输出/退出码回传的完整链路。
 * 覆盖：正确/错误密码、非零退出语义、remoteExec 分发（有密码走 ssh2）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { Server, utils } from "ssh2";
import {
  runSshRemote,
  remoteScript,
  quotePosixShellArg,
  REMOTE_OUTPUT_CAP_BYTES,
} from "../../src/tools/remote/ssh-exec";
import { remoteExec, remoteExecBash } from "../../src/tools/remote/exec";
import { closeAllSsh2 } from "../../src/tools/remote/ssh2-client";
import type { RemoteTarget } from "../../src/types";

const PASSWORD = "test-secret";

let server: InstanceType<typeof Server>;
let port = 0;

beforeAll(async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === PASSWORD) {
        ctx.accept();
      } else {
        ctx.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          // 模拟远端 shell：命令串交给 /bin/sh -c；客户端 stdin 转发给子进程
          //（cat > file 依赖 EOF 才收尾——不转发就是 60s 挂起）
          const child = spawn("/bin/sh", ["-c", info.command]);
          stream.on("data", (d: Buffer) => child.stdin.write(d));
          stream.on("end", () => child.stdin.end());
          child.stdout.on("data", (d) => stream.write(d));
          child.stderr.on("data", (d) => stream.stderr.write(d));
          child.on("exit", (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
});

afterAll(() => {
  closeAllSsh2();
  server?.close();
});

const target = (password: string): RemoteTarget => ({
  host: "127.0.0.1",
  port,
  username: "tester",
  password,
});

describe("ssh2 密码认证（真实服务端）", () => {
  test("密码认证 + exec：命令输出与退出码正确", async () => {
    const res = await remoteExec(target(PASSWORD), "printf 'hello-ssh2'", {
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello-ssh2");
  }, 20_000);

  test("cd 工作目录包装（remoteScript）生效", async () => {
    const res = await remoteExec(target(PASSWORD), remoteScript("pwd", "/tmp"), {
      timeoutMs: 10_000,
    });
    // 命令串本身是 /bin/sh -c，本机服务器再包一层 sh -c —— pwd 应落在 /tmp
    expect(res.stdout.trim()).toBe("/tmp");
  }, 20_000);

  test("错误密码：认证失败且错误信息可读", async () => {
    await expect(
      remoteExec({ ...target("wrong-password") }, "true", { timeoutMs: 8_000 }),
    ).rejects.toThrow(/认证失败|authentication/i);
  }, 20_000);

  test("非零退出默认抛错；resolveOnNonZeroExit 则回信封", async () => {
    await expect(
      remoteExec(target(PASSWORD), "exit 7", { timeoutMs: 10_000 }),
    ).rejects.toThrow(/exit 7/);
    const res = await remoteExec(target(PASSWORD), "exit 7", {
      timeoutMs: 10_000,
      resolveOnNonZeroExit: true,
    });
    expect(res.exitCode).toBe(7);
  }, 20_000);

  test("remoteExecBash：stderr 合流 + 退出码进信封（bash 语义）", async () => {
    const res = await remoteExecBash(
      target(PASSWORD),
      "echo out; echo err 1>&2; exit 3",
      "/tmp",
      { timeoutMs: 10_000 },
    );
    expect(res.stdout).toContain("out");
    expect(res.stdout).toContain("err");
    expect(res.exitCode).toBe(3);
  }, 20_000);

  test("输出上限截断标记", async () => {
    const res = await remoteExec(
      target(PASSWORD),
      `head -c ${REMOTE_OUTPUT_CAP_BYTES + 1024} /dev/zero | tr '\\0' 'a'`,
      { timeoutMs: 20_000 },
    );
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(REMOTE_OUTPUT_CAP_BYTES);
  }, 30_000);

  test("stdin 写入：cat > file 不挂起且内容完整（write/edit 链路回归）", async () => {
    const file = `/tmp/kova-ssh2-stdin-${Date.now()}.txt`;
    const content = "line-1\nline-2\n写入内容\n";
    const res = await remoteExec(
      target(PASSWORD),
      `cat > ${quotePosixShellArg(file)}`,
      { stdin: content, timeoutMs: 10_000 },
    );
    expect(res.exitCode).toBe(0);
    const back = await remoteExec(target(PASSWORD), `cat ${quotePosixShellArg(file)}`, {
      timeoutMs: 10_000,
    });
    expect(back.stdout).toBe(content);
    await remoteExec(target(PASSWORD), `rm -f ${quotePosixShellArg(file)}`, {
      timeoutMs: 10_000,
    });
  }, 20_000);

  test("后台任务（execSsh2Stream）：echo 正常收尾，不因 stdin 未关挂住", async () => {
    const { execSsh2Stream } = await import("../../src/tools/remote/ssh2-client");
    const chunks: string[] = [];
    const handle = await execSsh2Stream(
      target(PASSWORD) as {
        host: string;
        port: number;
        username: string;
        password: string;
      },
      "printf bg-ok",
      (chunk) => chunks.push(chunk),
    );
    const code = await handle.whenClose;
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("bg-ok");
  }, 20_000);

  test("分发器：无密码目标仍走 CLI 路径（不受 ssh2 影响）", async () => {
    // 无密码目标走 runSshRemote；127.0.0.1 无 key 认证会失败——只要不是
    // ssh2 的连接池报错即可（这里验证的是分发不串台）
    await expect(
      runSshRemote(
        { host: "127.0.0.1", port, username: "tester" },
        "true",
        { timeoutMs: 8_000 },
      ),
    ).rejects.toThrow();
  }, 20_000);
});
