/**
 * 远程工具层单测：纯逻辑部分（引号、路径解析、写入根、任务表归属、
 * 转录 header 的 remote 持久化）。SSH 传输本身不在单测面内（需真机）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWriteInRoot,
  remoteToolCall,
  resolveRemotePath,
} from "../../src/tools/remote/remote-tool-call";
import {
  muxOptions,
  quotePosixShellArg,
  remoteBashScript,
} from "../../src/tools/remote/ssh-exec";
import { sanitizeRemoteTargetInput } from "../../src/sessions/resolve";
import type { Running, RemoteTarget } from "../../src/types";
import {
  readTranscriptHeaderRemote,
  rewriteTranscriptHeaderCwd,
} from "../../src/sessions/transcript";
import { initStorage } from "../../src/storage/storage";
import { sessionPath } from "../../src/storage/storage";

describe("quotePosixShellArg", () => {
  test("普通参数加单引号", () => {
    expect(quotePosixShellArg("hello")).toBe("'hello'");
  });

  test("内嵌单引号按 POSIX 拼接", () => {
    const quoted = quotePosixShellArg("it's");
    // ' → '\''（关闭引号 + 转义引号 + 重开引号）
    expect(quoted).toBe(`'it'\\''s'`);
    // 拼进 shell 后语义不变：交给 /bin/sh -c 解析应还原原文
    const res = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${quoted}`]);
    expect(res.stdout.toString()).toBe("it's");
  });

  test("空格与注入字符不拆词", () => {
    const res = Bun.spawnSync([
      "/bin/sh",
      "-c",
      `printf %s ${quotePosixShellArg("a b; rm -rf /tmp/x '$HOME'")}`,
    ]);
    expect(res.stdout.toString()).toBe("a b; rm -rf /tmp/x '$HOME'");
  });
});

describe("resolveRemotePath", () => {
  const cwd = "/home/user/project";
  test("相对路径按 cwd 归一", () => {
    expect(resolveRemotePath(cwd, "src/a.ts")).toBe("/home/user/project/src/a.ts");
    expect(resolveRemotePath(cwd, "../sibling/b.ts")).toBe("/home/user/sibling/b.ts");
  });

  test("绝对路径与 ~ 原样透传", () => {
    expect(resolveRemotePath(cwd, "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveRemotePath(cwd, "~/notes.md")).toBe("~/notes.md");
  });

  test("空路径报错", () => {
    expect(() => resolveRemotePath(cwd, "  ")).toThrow("file_path is required");
  });
});

describe("assertWriteInRoot", () => {
  const cwd = "/home/user/project";
  test("根内路径放行（含根自身）", () => {
    expect(() => assertWriteInRoot(cwd, cwd)).not.toThrow();
    expect(() => assertWriteInRoot(cwd, "/home/user/project/src/a.ts")).not.toThrow();
  });

  test("越界路径拒绝", () => {
    expect(() => assertWriteInRoot(cwd, "/etc/passwd")).toThrow(/越界/);
    expect(() => assertWriteInRoot(cwd, "/home/user/project-evil/x")).toThrow(/越界/);
    expect(() => assertWriteInRoot(cwd, "~/x")).toThrow(/越界/);
  });

  test("尾斜杠根不误判", () => {
    expect(() => assertWriteInRoot("/home/user/project/", "/home/user/project/a")).not.toThrow();
  });
});

describe("remote task registry ownership", () => {
  test("task_output 跨线程/不存在任务拒绝", async () => {
    const target: RemoteTarget = { host: "localhost" };
    await expect(
      remoteToolCall("task_output", "/tmp", { taskId: 999 }, undefined, "thread-a", target),
    ).rejects.toThrow("task not found: 999");
  });
});

describe("muxOptions（连接复用按平台）", () => {
  test("Windows 不生成 ControlMaster 参数（Win32-OpenSSH 不支持 mux）", () => {
    expect(muxOptions("win32")).toEqual([]);
  });

  test("macOS/Linux 生成 ControlMaster/ControlPath/ControlPersist", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const opts = muxOptions(platform);
      expect(opts.join(" ")).toContain("ControlMaster=auto");
      expect(opts.join(" ")).toContain("ControlPath=");
      expect(opts.join(" ")).toContain("ControlPersist=600");
    }
  });
});

describe("remoteBashScript（bash 工具的远端包装）", () => {
  const run = (command: string, cwd?: string) => {
    const res = Bun.spawnSync(["/bin/sh", "-c", remoteBashScript(command, cwd)]);
    return { out: res.stdout.toString(), exit: res.exitCode };
  };

  test("以 & 结尾的命令不触发语法错误（旧 { } 包装的实锤回归）", () => {
    const r = run("echo started &");
    expect(r.exit).toBe(0);
  });

  test("含独立 } token 的命令不破坏包装", () => {
    const r = run("echo 'a } b'");
    expect(r.out).toContain("a } b");
  });

  test("stderr 并入 stdout（exec 2>&1）", () => {
    const r = run("echo out; echo err 1>&2");
    expect(r.out).toContain("out");
    expect(r.out).toContain("err");
  });

  test("cd 工作目录 + 失败退出码透传", () => {
    const ok = run("pwd", "/tmp");
    expect(ok.out.startsWith("/")).toBe(true);
    const bad = run("echo hi", "/definitely/not/exist");
    expect(bad.exit).not.toBe(0);
  });
});

describe("sanitizeRemoteTargetInput（new_session/prompt 共用清洗）", () => {
  test("合法目标保留白名单字段", () => {
    expect(
      sanitizeRemoteTargetInput({ host: " h ", port: 2222, username: " u ", extra: "x" }),
    ).toEqual({ host: "h", port: 2222, username: "u" });
  });

  test("无 host / 非对象 / null 一律 undefined（本地语义）", () => {
    expect(sanitizeRemoteTargetInput(undefined)).toBeUndefined();
    expect(sanitizeRemoteTargetInput(null)).toBeUndefined();
    expect(sanitizeRemoteTargetInput("ssh")).toBeUndefined();
    expect(sanitizeRemoteTargetInput({ port: 22 })).toBeUndefined();
    expect(sanitizeRemoteTargetInput({ host: "" })).toBeUndefined();
  });

  test("密码原样保留（仅内存，header 落盘前另行剥离）", () => {
    expect(
      sanitizeRemoteTargetInput({ host: "h", username: "u", password: "p@ss" })?.password,
    ).toBe("p@ss");
    expect(sanitizeRemoteTargetInput({ host: "h", password: "" })?.password).toBeUndefined();
  });

  test("port 挡 NaN/越界/小数", () => {
    expect(sanitizeRemoteTargetInput({ host: "h", port: Number.NaN })?.port).toBeUndefined();
    expect(sanitizeRemoteTargetInput({ host: "h", port: 0 })?.port).toBeUndefined();
    expect(sanitizeRemoteTargetInput({ host: "h", port: 70000 })?.port).toBeUndefined();
    expect(sanitizeRemoteTargetInput({ host: "h", port: 22.5 })?.port).toBeUndefined();
    expect(sanitizeRemoteTargetInput({ host: "h", port: 2222 })?.port).toBe(2222);
  });
});

describe("transcript header remote 持久化", () => {
  test("新建 header 带 remote → 读回；改写保留；传 null 清除", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-remote-header-"));
    const sessionId = "sess-remote-test";
    // transcript.ts 的 sessionPath 走 storage 初始化的会话目录：测试模式 initStorage
    // 指到临时目录，不依赖 HOME
    initStorage(join(dir, "state.db"), dir);
    try {
      writeFileSync(
        sessionPath(sessionId),
        JSON.stringify({
          type: "header",
          schema: 1,
          id: sessionId,
          cwd: "/home/user/project",
          created_at: "2026-01-01T00:00:00.000Z",
          remote: { host: "my-host", port: 2222, username: "deploy" },
        }) + "\n",
      );
      const remote = readTranscriptHeaderRemote(sessionId);
      expect(remote).toEqual({ host: "my-host", port: 2222, username: "deploy" });

      // 改写 cwd（不传 remote）→ 保留
      rewriteTranscriptHeaderCwd(sessionId, "/home/user/project/sub");
      expect(readTranscriptHeaderRemote(sessionId)).toEqual({
        host: "my-host",
        port: 2222,
        username: "deploy",
      });

      // 传 null → 清除
      rewriteTranscriptHeaderCwd(sessionId, "/local/dir", null);
      expect(readTranscriptHeaderRemote(sessionId)).toBeNull();

      // 密码认证目标：header 落盘必须剥离 password（秘密不落盘）
      rewriteTranscriptHeaderCwd(sessionId, "/home/user/project", {
        host: "pw-host",
        username: "ubuntu",
        password: "top-secret",
      });
      const raw = readFileSync(sessionPath(sessionId), "utf8").split("\n")[0] ?? "";
      expect(raw).not.toContain("top-secret");
      expect(readTranscriptHeaderRemote(sessionId)).toEqual({
        host: "pw-host",
        username: "ubuntu",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Running 类型约束（编译期）", () => {
  test("remoteTarget 可为 null/目标", () => {
    const run = { remoteTarget: null } as Partial<Running>;
    const target: RemoteTarget = { host: "h" };
    run.remoteTarget = target;
    expect(run.remoteTarget?.host).toBe("h");
  });
});
