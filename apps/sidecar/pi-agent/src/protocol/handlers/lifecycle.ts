/**
 * 生命周期命令：ping / abort（用户 Stop） / shutdown（宿主优雅终止）。
 */
import { logAt, logErr } from "../../log";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
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
    // 挂起提问按取消结算，避免永久悬挂。
    // 队列语义对齐 ZCode：Stop 不取消排队项——保留队列并在收尾后暂停自动
    // 派发（pauseReason="stopped"，见 runPromptTurn 收尾段），用户点「继续」
    // 再跑。只有 shutdown（应用退出）才整队取消。
    const threadId = typeof msg.threadId === "string" ? msg.threadId : "";
    // 诊断：Stop 链路是否真到达侧车、是否找到 run（面板报告"点了很久没反应"
    // 时先看这行；threadId 与 running 键对不上会静默 no-op）
    if (threadId) {
      // 刷新后前端 thread id 即 sessionId，而 run 可能仍驻留在旧草稿键下：
      // 反查索引兜底，否则续流会话上的 Stop 只杀前端流、sidecar 照跑
      const owner = running.has(threadId)
        ? { threadId, run: running.get(threadId)! }
        : findRunBySession(threadId);
      logAt(
        "event",
        `abort: thread=${threadId} owner=${owner ? owner.threadId : "none"} running=${running.size}`,
      );
      if (owner) {
        // IM 等无排队 UI 的调用方显式要求停止即丢弃排队项：立即清一次
        // （run 空闲/收尾不触发 settlement 时也要清），settlement 的 discard
        // 再兜住未获回应、被回收到队列的并入项。
        if (msg.discardQueue === true) {
          owner.run.discardQueueOnStop = true;
          cancelAllEntries(threadId);
          if (owner.threadId !== threadId) cancelAllEntries(owner.threadId);
        }
        abortRun(owner.run, owner.threadId);
      } else if (msg.discardQueue === true) {
        cancelAllEntries(threadId);
      }
    } else {
      logAt("event", `abort: global running=${running.size}`);
      for (const [tid, run] of running.entries()) {
        if (msg.discardQueue === true) run.discardQueueOnStop = true;
        abortRun(run, tid);
      }
      if (msg.discardQueue === true) cancelAllEntries();
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
    // 进程退出前清空所有 provider 会话资源（Anthropic message threads、
    // Codex websocket 等）：留着只会拖慢退出/占连接。钩子可能抛，
    // shutdown 不能被它打断
    try {
      cleanupSessionResources();
    } catch (err) {
      logErr("cleanup session resources on shutdown failed:", err);
    }
  },
};
