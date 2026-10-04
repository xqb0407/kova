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

/** 解析结果与来源：via 只进诊断日志（排障时要能一眼看出「为什么用了这个模型」） */
type ModelPick = {
  model: Model<Api>;
  via: "live" | "session" | "hint" | "global" | "default";
};

/**
 * 前端界面当前显示的模型（请求体 `model` 字段）。草稿期的模型选择只活在前端内存
 * ——会话还没建、会话偏好列无从落——所以会话解析不到模型时，这份 hint 是界面与
 * 实际用模对齐的唯一通道。采用前必须过与 set_model 同款的校验（目录里存在 + 有凭据
 * + 非占位）：坏值一律忽略并继续走后面的兜底，绝不因为前端塞了个用不了的模型而失败。
 */
async function resolveHintedModel(hint: unknown): Promise<Model<Api> | undefined> {
  const h = hint as { provider?: unknown; modelId?: unknown } | null | undefined;
  const provider = typeof h?.provider === "string" ? h.provider : "";
  const modelId = typeof h?.modelId === "string" ? h.modelId : "";
  if (!provider || !modelId) return undefined;
  const model = getModels().getModel(provider, modelId);
  if (!model || isModelUnavailable(model)) return undefined;
  const auth = await getModels().getAuth(provider).catch(() => undefined);
  return auth ? model : undefined;
}

/**
 * 会话当前模型（与 resolve.ts 的会话模型链同序，取其简化形）：
 * 驻留 run 的实时模型 > 该会话的偏好行 > 请求携带的界面当前模型 > 全局当前选择
 * > 目录默认。
 *
 * hint 排在会话行之后而不是之前：会话行是「该会话的模型真值」，对话页选择器就
 * 是从它水合显示的（会话存在时两者本就同值）；hint 真正要覆盖的是会话行不存在的
 * 场景——未发送草稿（`__LOCALID_` 线程）没发过消息就没有行，此前一路落到全局
 * 默认，界面显示 A、优化却跑 B 正是这么来的。
 *
 * 不可用（无凭据/占位模型）返回 undefined，由调用方报错。
 */
async function resolveSessionModel(
  threadId: string,
  sessionId: string,
  hint?: unknown,
): Promise<ModelPick | undefined> {
  const run = running.get(threadId) ?? findRunBySession(sessionId || threadId)?.run;
  const live = run?.agent.state.model as Model<Api> | undefined;
  if (live && !isModelUnavailable(live)) return { model: live, via: "live" };
  const row = sessionId ? await sessionGet(sessionId).catch(() => null) : null;
  const saved =
    row?.modelProvider && row?.modelId
      ? getModels().getModel(row.modelProvider, row.modelId)
      : undefined;
  if (saved) return { model: saved, via: "session" };
  const hinted = await resolveHintedModel(hint);
  if (hinted) return { model: hinted, via: "hint" };
  const mk = getCurrentModelKey();
  const global = mk ? getModels().getModel(mk.provider, mk.modelId) : undefined;
  if (global) return { model: global, via: "global" };
  const fallback = (await defaultModel().catch(() => undefined)) as Model<Api> | undefined;
  return fallback && !isModelUnavailable(fallback)
    ? { model: fallback, via: "default" }
    : undefined;
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
    const pick = await resolveSessionModel(threadId, sessionId, msg.model);
    if (!pick) throw new Error("没有可用模型，请先选择模型");
    const model = pick.model;

    const controller = new AbortController();
    jobs.set(jobId, controller);
    beginOp();
    // 诊断线：草稿字符数、所用模型与来源（出问题时可从 pi-agent.log 回溯到底
    // 发了什么规模、为什么用了这个模型——via=hint 即界面当前选择）
    logErr(
      "optimize_prompt:",
      `job=${jobId}`,
      `chars=${text.trim().length}`,
      `model=${model.provider}/${model.id}`,
      `via=${pick.via}`,
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
