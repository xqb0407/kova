/**
 * 提示词优化命令：把 composer 草稿交给会话当前模型做一次独立 one-shot 改写，
 * 结果由前端回填输入框。芯片（技能/子智能体引用）保护在 sessions/prompt-optimize。
 *
 * **不占 mgmt 串行队列**：非 prompt 命令整体经 enqueueMgmt 排队（mgmt-queue.ts），
 * 而一次优化是几秒级的 provider 请求——占着队列会把 set_model / 队列操作等全部
 * 管理命令一起卡住。所以 handler 只做校验与派活（都是本地同步/亚毫秒动作）就返回，
 * 结果晚点用**同一个 reqId** 发回：Rust 侧 `pi_request` 的 pending oneshot 按 id
 * 配对、不设超时（pi_agent.rs），前端 `piRequest` 传大 timeoutMs 等它即可。
 * 在飞计数另开一对 beginOp/endOp：handleLine 的 finally 会在 handler 返回时就
 * endOp，若此刻进程收到 shutdown 会直接退出、把优化结果丢掉。
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { classifyAgentError, toWireError } from "../../agent/agent-errors";
import { logErr } from "../../log";
import { defaultModel, getCurrentModelKey, getModels } from "../../model/model-catalog";
import { isModelUnavailable } from "../../sessions/resolve";
import { findRunBySession, running } from "../../sessions/sessions";
import { optimizeDraftPrompt } from "../../sessions/prompt-optimize";
import { sessionGet } from "../../storage/hostdb";
import { beginOp, endOp } from "../exit";
import { send } from "../stream";
import type { CommandHandler } from "../command";

/** jobId → 在飞优化的中止器（`optimize_cancel` 用；任务收尾自删） */
const jobs = new Map<string, AbortController>();

/**
 * 会话当前模型（与 resolve.ts 的会话模型链同序，取其简化形）：
 * 驻留 run 的实时模型 > 该会话的偏好行 > 全局当前选择 > 目录默认。
 * 不可用（无凭据/占位模型）返回 undefined，由调用方报错。
 */
async function resolveSessionModel(
  threadId: string,
  sessionId: string,
): Promise<Model<Api> | undefined> {
  const run = running.get(threadId) ?? findRunBySession(sessionId || threadId)?.run;
  const live = run?.agent.state.model as Model<Api> | undefined;
  if (live && !isModelUnavailable(live)) return live;
  const row = sessionId ? await sessionGet(sessionId).catch(() => null) : null;
  const saved =
    row?.modelProvider && row?.modelId
      ? getModels().getModel(row.modelProvider, row.modelId)
      : undefined;
  if (saved) return saved;
  const mk = getCurrentModelKey();
  const global = mk ? getModels().getModel(mk.provider, mk.modelId) : undefined;
  if (global) return global;
  const fallback = (await defaultModel().catch(() => undefined)) as Model<Api> | undefined;
  return fallback && !isModelUnavailable(fallback) ? fallback : undefined;
}

/** 异步失败的应答：与 handleLine 的 catch 同形（前端 piRequest 见 error 即抛） */
function sendFailure(reqId: string, errorText: string): void {
  send({
    id: reqId,
    type: "error",
    errorText,
    error: toWireError(classifyAgentError(errorText, { opaqueFallback: "runtime" })),
  });
}

export const handlers: Record<string, CommandHandler> = {
  optimize_prompt: async (reqId, msg) => {
    const jobId = String(msg.jobId ?? "");
    const text = typeof msg.text === "string" ? msg.text : "";
    const threadId = String(msg.threadId ?? "default");
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : threadId;
    // 校验全部前置：被拒命令不得占用 reqId（应答由这里同步给出）
    if (!jobId) throw new Error("jobId required");
    if (!text.trim()) throw new Error("草稿为空");
    if (jobs.has(jobId)) throw new Error(`optimize job already running: ${jobId}`);
    const model = await resolveSessionModel(threadId, sessionId);
    if (!model) throw new Error("没有可用模型，请先选择模型");

    const controller = new AbortController();
    jobs.set(jobId, controller);
    beginOp();
    // 诊断线：草稿字符数与所用模型（出问题时可从 pi-agent.log 回溯到底发了什么规模）
    logErr(
      "optimize_prompt:",
      `job=${jobId}`,
      `chars=${text.trim().length}`,
      `model=${model.provider}/${model.id}`,
    );
    void (async () => {
      try {
        const outcome = await optimizeDraftPrompt(
          getModels().streamSimple.bind(getModels()),
          model,
          text,
          { signal: controller.signal },
        );
        // 取消优先于结果：半途被 cancel 时即便模型已返回也不回填
        if (controller.signal.aborted) {
          send({ id: reqId, type: "prompt_optimize_cancelled", jobId });
          return;
        }
        if (!outcome.ok) {
          sendFailure(reqId, outcome.error);
          return;
        }
        send({
          id: reqId,
          type: "prompt_optimized",
          jobId,
          text: outcome.text,
          chipCount: outcome.chipCount,
          model: `${model.provider}/${model.id}`,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          send({ id: reqId, type: "prompt_optimize_cancelled", jobId });
          return;
        }
        sendFailure(reqId, err instanceof Error ? err.message : String(err));
      } finally {
        jobs.delete(jobId);
        endOp();
      }
    })();
  },

  optimize_cancel: async (reqId, msg) => {
    // 中止在飞优化：abort 掉 provider 请求；被中止任务的应答帧（prompt_optimize_cancelled）
    // 走它自己的 reqId，这里只结算 cancel 命令本身
    const jobId = String(msg.jobId ?? "");
    jobs.get(jobId)?.abort();
    send({ id: reqId, type: "prompt_optimize_cancel", jobId });
  },
};
