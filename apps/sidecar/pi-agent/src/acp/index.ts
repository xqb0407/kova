/**
 * ACP stdio 服务启动：JSON-RPC 2.0（newline-delimited）over stdin/stdout。
 *
 * stdout 由 ACP SDK 独占；内部协议帧经 AcpBridge 安装的 frame sink 拦截，
 * 不会再以 NDJSON 泄漏。日志全部走 stderr（见 log.ts）。
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { logErr } from "../log";
import { markStdinClosed, setExitDrain } from "../protocol/exit";
import { disposeLocalHost, installLocalHost } from "../local-host";
import { AcpBridge } from "./bridge";
import { KovaAcpAgent } from "./agent";
import { setAcpRuntime } from "./runtime";

export type AcpServerHandle = {
  bridge: AcpBridge;
  dispose: () => void;
};

export function startAcpServer(): AcpServerHandle {
  setAcpRuntime(true);
  installLocalHost();

  const bridge = new AcpBridge();
  bridge.install();

  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);
  let agent: KovaAcpAgent | null = null;
  const conn = new acp.AgentSideConnection((connection) => {
    agent = new KovaAcpAgent(connection, bridge);
    return agent;
  }, stream);
  void conn;

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    // 先 abort 所有会话的 promptAbort（权限等待的 race 也在这里解除），
    // 再让 bridge 发全局 abort。只发 bridge.abortAll 的话，客户端已断开时
    // ACP 权限请求可能一直挂到 5 分钟兜底，阻塞退出 drain。
    agent?.cancelAll();
    if (!agent) bridge.abortAll();
    // stdin 关闭后等 bridge 流/本地工具收尾，再由 exit.ts 冲刷 stdout 退出
    markStdinClosed();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  setExitDrain(async () => {
    agent?.cancelAll();
    // 先杀本地前台/后台进程，避免 drain 等一个已经没人接收的 bash 结果
    disposeLocalHost();
    await Promise.race([
      bridge.drain().catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
    bridge.dispose();
  });

  logErr("[acp] server ready (stdio JSON-RPC, protocol v1)");
  return {
    bridge,
    dispose: () => {
      agent?.cancelAll();
      disposeLocalHost();
      bridge.dispose();
      setExitDrain(null);
      setAcpRuntime(false);
    },
  };
}
