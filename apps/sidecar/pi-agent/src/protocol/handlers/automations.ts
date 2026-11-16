/**
 * 自动化定时任务命令：全部经 automation/commands.ts 的载荷层（排期校验、
 * 运行记录、模板预览），应答统一为 automation_list 形状。
 */
import { send } from "../stream";
import {
  automationDeletePayload,
  automationHistoryDeletePayload,
  automationListPayload,
  automationPreviewPayload,
  automationRunNowPayload,
  automationSavePayload,
  automationSetEnabledPayload,
  automationTemplatesPayload,
} from "../../automation/commands";
import type { CommandHandler } from "../command";

export const handlers: Record<string, CommandHandler> = {
  // 独立调度进程的触发入口：main 转发 automation_run_request 时使用。
  // 只执行 runner，不参与排期；结果回给 main，由调度器结算 runHistory。
  automation_run: async (reqId, msg) => {
    const task = msg.task as {
      id: string;
      name?: string;
      type?: string;
      prompt: string;
      timeoutMs?: number;
    };
    const run = msg.run as {
      historyEntryId: string;
      sessionId: string;
      startedAt: string;
      /** L1：触发来源（scheduler runWithContext 透传；cron/interval/once 无） */
      trigger?: { type: "webhook" | "file" | "git" | "im" | "manual"; id?: string; summary?: string };
    };
    if (!task || !run) {
      send({
        id: reqId,
        type: "automation_run_result",
        ok: false,
        error: "automation_run: task/run is required",
      });
      return;
    }
    send({
      type: "automation_fired",
      taskId: task.id,
      taskName: task.name ?? "",
      taskType: task.type ?? "cron",
      runId: run.historyEntryId,
      firedAt: run.startedAt,
    });
    try {
      const { runAutomationTaskWithInbox, getAutomationRunSession } = await import(
        "../../automation/runner"
      );
      await runAutomationTaskWithInbox(task as never, run as never);
      const sessionId = getAutomationRunSession(run.historyEntryId);
      send({
        type: "automation_run_done",
        taskId: task.id,
        taskName: task.name ?? "",
        runId: run.historyEntryId,
        ok: true,
        sessionId,
        finishedAt: new Date().toISOString(),
      });
      send({
        id: reqId,
        type: "automation_run_result",
        ok: true,
        sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({
        type: "automation_run_done",
        taskId: task.id,
        taskName: task.name ?? "",
        runId: run.historyEntryId,
        ok: false,
        error: message.slice(0, 400),
        finishedAt: new Date().toISOString(),
      });
      send({
        id: reqId,
        type: "automation_run_result",
        ok: false,
        error: message,
      });
    }
  },

  automation_list: async (reqId) => {
    const r = await automationListPayload();
    send({ id: reqId, type: r.type, tasks: r.tasks });
  },

  automation_save: async (reqId, msg) => {
    const r = await automationSavePayload(msg);
    send({ id: reqId, type: r.type, tasks: r.tasks });
  },

  automation_delete: async (reqId, msg) => {
    const r = await automationDeletePayload(msg);
    send({ id: reqId, type: r.type, tasks: r.tasks });
  },

  automation_set_enabled: async (reqId, msg) => {
    const r = await automationSetEnabledPayload(msg);
    send({ id: reqId, type: r.type, tasks: r.tasks });
  },

  automation_run_now: async (reqId, msg) => {
    const r = await automationRunNowPayload(msg);
    send({ id: reqId, type: r.type, tasks: r.tasks });
  },

  automation_history_delete: async (reqId, msg) => {
    const r = await automationHistoryDeletePayload(msg);
    send({ id: reqId, type: r.type, tasks: r.tasks });
  },

  automation_preview: async (reqId, msg) => {
    send({ id: reqId, ...automationPreviewPayload(msg) });
  },

  automation_templates: async (reqId) => {
    send({ id: reqId, ...automationTemplatesPayload() });
  },
};

/* ------------------------------ 事件触发器（L1） ------------------------------ */

// 触发器命令与 automation_* 同款：载荷层校验/落盘，应答统一 triggers 形状。
import {
  triggerDeletePayload,
  triggerRegenerateSecretPayload,
  triggerSavePayload,
  triggerSetEnabledPayload,
  triggerTestPayload,
  triggersPayload,
} from "../../automation/commands";

Object.assign(handlers, {
  list_triggers: async (reqId) => {
    send({ id: reqId, ...triggersPayload() });
  },
  save_trigger: async (reqId, msg) => {
    send({ id: reqId, ...(await triggerSavePayload(msg)) });
  },
  delete_trigger: async (reqId, msg) => {
    send({ id: reqId, ...(await triggerDeletePayload(msg)) });
  },
  set_trigger_enabled: async (reqId, msg) => {
    send({ id: reqId, ...(await triggerSetEnabledPayload(msg)) });
  },
  regenerate_trigger_secret: async (reqId, msg) => {
    send({ id: reqId, ...(await triggerRegenerateSecretPayload(msg)) });
  },
  test_trigger: async (reqId, msg) => {
    send({ id: reqId, ...(await triggerTestPayload(msg)) });
  },
} satisfies Record<string, CommandHandler>);
