/**
 * 远程执行分发器：按目标是否携带密码选择传输——
 * - 无密码（密钥/agent）：系统 ssh CLI（ControlMaster 复用、ProxyJump/config 别名免费）；
 * - 有密码：ssh2 库（CLI 无法非交互输密码），连接池多路复用。
 * 两者信封一致（RemoteRunResult），上层工具无感知。
 */
import type { RemoteTarget } from "../../types";
import {
  runSshRemote,
  runSshScript,
  targetOptions,
  remoteTargetArg,
  remoteScript,
  remoteBashScript,
  type RemoteRunOptions,
  type RemoteRunResult,
} from "./ssh-exec";
import { runSsh2Remote, execSsh2Stream, type PasswordTarget } from "./ssh2-client";
import { spawn, type ChildProcess } from "node:child_process";

export function hasPassword(target: RemoteTarget): target is PasswordTarget {
  return typeof target.password === "string" && target.password.length > 0;
}

/** 统一入口：cd 包装 + 非零退出抛错（resolveOnNonZeroExit 可覆盖） */
export function remoteExec(
  target: RemoteTarget,
  command: string,
  options?: RemoteRunOptions,
): Promise<RemoteRunResult> {
  if (hasPassword(target)) {
    return runSsh2Remote(target, remoteScript(command, options?.cwd), options);
  }
  return runSshRemote(target, command, options);
}

/**
 * bash 工具专用：remoteBashScript 包装（cd 失败 exit 127 + exec 2>&1 合流），
 * bash 语义 = 非零退出是结果不是异常（resolveOnNonZeroExit 恒开）。
 */
export function remoteExecBash(
  target: RemoteTarget,
  command: string,
  cwd: string,
  options?: RemoteRunOptions,
): Promise<RemoteRunResult> {
  const script = remoteBashScript(command, cwd);
  const opts: RemoteRunOptions = { ...options, resolveOnNonZeroExit: true };
  if (hasPassword(target)) {
    return runSsh2Remote(target, script, opts);
  }
  return runSshScript(target, script, opts);
}

/** 后台任务句柄：CLI 子进程或 ssh2 通道的统一停/等接口 */
export interface RemoteBashHandle {
  stop(): void;
  /** 命令结束（含被 stop）时 resolve 退出码；被强杀为非 0 */
  whenDone: Promise<number | null>;
}

/** 启动后台 bash：stdout/stderr（脚本内已 exec 2>&1）经 onData 回调 */
export function startRemoteBash(
  target: RemoteTarget,
  command: string,
  cwd: string,
  onData: (chunk: string) => void,
): RemoteBashHandle {
  const script = remoteBashScript(command, cwd);
  if (hasPassword(target)) {
    // ssh2：通道生命周期由连接池管理；whenClose 即任务退出
    let handle: { stop(): void; whenClose: Promise<number | null> } | null = null;
    const done = execSsh2Stream(target, script, onData).then((h) => {
      handle = h;
      return h.whenClose;
    });
    return {
      stop: () => handle?.stop(),
      whenDone: done,
    };
  }
  // CLI：本地 ssh 子进程即任务句柄
  const child: ChildProcess = spawn(
    "ssh",
    [...targetOptions(target), remoteTargetArg(target), "--", script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => onData(chunk.toString("utf8")));
  return {
    stop: () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    },
    whenDone: new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
      child.on("error", () => resolve(-1));
    }),
  };
}
