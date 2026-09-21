/**
 * 生命周期命令：ping / abort（用户 Stop） / shutdown（宿主优雅终止）。
 */
import { logErr } from "../../log";
import { send } from "../stream";
import { markStdinClosedForShutdown } from "../exit";
import { abortRun } from "../prompt-pipeline";
import { running, findRunBySession } from "../../sessions/sessions";
import { cancelAllEntries } from "../../sessions/prompt-queue";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  ping: async (reqId) => {
    send({ id: reqId, type: "pong" });
  },

  abort: async (_reqId, msg) => {
    // 用户 Stop：中止线程（threadId 提供时仅该线程，缺省全局兜底）的父代理
    // 与全部后台子代理，并让收敛循环退出；挂起的逐工具审批按拒绝结算、
    // 挂起提问按取消结算，避免永久悬挂；该范围的排队 prompt 一并取消
    // （各自流立即 abort+finish 收尾，不再执行）
    const threadId = typeof msg.threadId === "string" ? msg.threadId : "";
    if (threadId) {
      // 刷新后前端 thread id 即 sessionId，而 run 可能仍驻留在旧草稿键下：
      // 反查索引兜底，否则续流会话上的 Stop 只杀前端流、sidecar 照跑
      const owner = running.has(threadId)
        ? { threadId, run: running.get(threadId)! }
        : findRunBySession(threadId);
      if (owner) abortRun(owner.run, owner.threadId);
      cancelAllEntries(threadId);
      if (owner && owner.threadId !== threadId) cancelAllEntries(owner.threadId);
    } else {
      for (const [tid, run] of running.entries()) {
        abortRun(run, tid);
      }
      cancelAllEntries();
    }
  },

  shutdown: async () => {
    // 宿主应用退出发起的优雅终止（pi_agent.rs kill_on_exit 先写本行、等本进程退出、
    // 超时才 SIGKILL）：全局 abort 让在飞 run 把 partial 结算为 aborted 消息并走
    // agent_end 监听器落盘，清排队队列、停自动化调度（防结算窗口内定时任务再起
    // run），再等全部 run idle——waitForIdle 在 agent_end 监听器 settle 之后才
    // resolve，即持久化已完成；5s 封顶防单点悬挂。置 stdinClosed 后本命令的
    // handleLine finally 会经 maybeExit 收尾（stdout 冲刷 + MCP 断连），无需 ack
    for (const [tid, run] of running.entries()) {
      abortRun(run, tid);
    }
    cancelAllEntries();
    markStdinClosedForShutdown();
    await import("../../automation/runtime")
      .then((m) => m.stopAutomation())
      .catch((err) => logErr("stop automation on shutdown failed:", err));
    await Promise.race([
      Promise.all([...running.values()].map((r) => r.agent.waitForIdle())).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  },
};
