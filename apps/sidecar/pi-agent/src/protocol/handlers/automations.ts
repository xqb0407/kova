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
