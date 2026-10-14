// VENDOR: 见本目录 index.ts 溯源头。本文件为重点适配对象：
// ExtensionContext 第 5 参改为 createSchedulerTools 的 getCtx 闭包；作用域放宽为 app 级。
import type {
  AgentTool,
  AgentToolResult,
} from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  resolveScheduledTaskDefinition,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskType,
  type TaskScheduler,
  type TaskSchedulerScope,
} from './index';

/** 宿主注入的调用时上下文：当前会话 id 与模型（scheduler_create 记录来源与默认模型用） */
export type SchedulerToolContext = () => {
  sessionId: string;
  model?: { provider?: string; id?: string };
};

function textResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text' as const, text }], details: undefined };
}

function formatTaskSummary(task: ScheduledTask) {
  return {
    id: task.id,
    name: task.name,
    type: task.type,
    schedule: task.schedule,
    enabled: task.enabled,
    lastStatus: task.lastStatus ?? 'pending',
    nextRunAt: task.nextRunAt,
    runCount: task.runCount,
    prompt: task.prompt.length > 100 ? `${task.prompt.slice(0, 100)}…` : task.prompt,
  };
}

// 自动化是应用级资产：工具调用不按"当前会话"过滤（上游 sessionScope 按会话隔离是 CLI 语义）。
// scheduler 实例自身装配时已带 scope（本项目传 {}），这里恒传空作用域。
function sessionScope(): TaskSchedulerScope {
  return {};
}

const taskTypeSchema = Type.Union([
  Type.Literal('cron'),
  Type.Literal('once'),
  Type.Literal('interval'),
]);

export function createSchedulerTools(
  scheduler: TaskScheduler,
  getCtx: SchedulerToolContext,
): AgentTool[] {
  return [
    {
      name: 'scheduler_create',
      label: 'Scheduler',
      description:
        'Schedule a prompt to be executed automatically at a future time or on a recurring basis. Supports cron expressions, one-time (ISO timestamp or relative like "+10m"), and interval (e.g. "30s", "5m", "1h"). Use this when the user wants something to run later, repeatedly, or on a timer.',
      parameters: Type.Object({
        type: taskTypeSchema,
        schedule: Type.String({
          description:
            'Schedule expression. Cron: "0 9 * * 1-5"; Once: ISO timestamp or "+10m"; Interval: "30s", "5m", "1h".',
        }),
        prompt: Type.String({ description: 'The prompt to execute when triggered.' }),
        name: Type.Optional(
          Type.String({ description: 'Human-readable name for this scheduled prompt.' }),
        ),
        description: Type.Optional(
          Type.String({ description: 'Description of this scheduled prompt.' }),
        ),
        enabled: Type.Optional(
          Type.Boolean({ description: 'Whether this scheduled prompt is enabled. Default true.' }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            description: 'Maximum execution time in milliseconds. Defaults to 30 minutes.',
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> {
        try {
          const p = params as Record<string, unknown>;
          const definition = resolveScheduledTaskDefinition({
            type: p.type as ScheduledTaskType,
            schedule: p.schedule as string,
          });
          const ctx = getCtx();
          const input: ScheduledTaskCreateInput = {
            ...definition,
            prompt: p.prompt as string,
            sessionId: ctx.sessionId || 'unknown',
            model: {
              provider: ctx.model?.provider ?? 'anthropic',
              model: ctx.model?.id ?? 'unknown',
            },
            // 无人值守安全默认（上游为 'workspace-write'，本项目收紧为只读档，见 index.ts 溯源头）
            toolPolicyProfile: 'read-only',
            enabled: p.enabled !== false,
            ...(p.name ? { name: p.name as string } : {}),
            ...(p.description ? { description: p.description as string } : {}),
            ...(typeof p.timeoutMs === 'number'
              ? { timeoutMs: p.timeoutMs as number }
              : {}),
          };
          const task = await scheduler.create(input);
          return textResult(JSON.stringify(formatTaskSummary(task), null, 2));
        } catch (error) {
          return textResult(
            `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    },
    {
      name: 'scheduler_list',
      label: 'Scheduler',
      description: 'List all scheduled prompts with their status and next run time.',
      parameters: Type.Object({}),
      async execute(): Promise<AgentToolResult<unknown>> {
        const tasks = await scheduler.list(sessionScope());
        if (tasks.length === 0) {
          return textResult('No scheduled tasks.');
        }
        const summary = tasks.map(formatTaskSummary);
        return textResult(JSON.stringify(summary, null, 2));
      },
    },
    {
      name: 'scheduler_get',
      label: 'Scheduler',
      description:
        'Get detailed information about a scheduled prompt, including its schedule and run history.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to query.' }),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> {
        const task = await scheduler.get((params as { taskId: string }).taskId);
        if (!task) {
          return textResult(`Task not found: ${(params as { taskId: string }).taskId}`);
        }
        return textResult(JSON.stringify(task, null, 2));
      },
    },
    {
      name: 'scheduler_update',
      label: 'Scheduler',
      description:
        'Update a scheduled prompt. Can change schedule, prompt text, name, or enable/disable.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to update.' }),
        type: Type.Optional(taskTypeSchema),
        schedule: Type.Optional(Type.String({ description: 'New schedule expression.' })),
        prompt: Type.Optional(Type.String({ description: 'New prompt.' })),
        name: Type.Optional(Type.String({ description: 'New name.' })),
        description: Type.Optional(Type.String({ description: 'New description.' })),
        enabled: Type.Optional(Type.Boolean({ description: 'Enable or disable.' })),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> {
        const { taskId, type, schedule, prompt, name, description, enabled } = params as {
          taskId: string;
          type?: string;
          schedule?: string;
          prompt?: string;
          name?: string;
          description?: string;
          enabled?: boolean;
        };
        const update: Record<string, unknown> = {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        };
        if (type !== undefined || schedule !== undefined) {
          try {
            const existing = await scheduler.get(taskId, sessionScope());
            if (!existing) {
              return textResult(`Task not found: ${taskId}`);
            }
            const definition = resolveScheduledTaskDefinition({
              type: (type ?? existing.type) as ScheduledTaskType,
              schedule: schedule ?? existing.schedule,
            });
            Object.assign(update, definition);
          } catch (error) {
            return textResult(
              `Invalid schedule: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const task = await scheduler.update(taskId, update, sessionScope());
        if (!task) {
          return textResult(`Task not found: ${taskId}`);
        }
        return textResult(JSON.stringify(formatTaskSummary(task), null, 2));
      },
    },
    {
      name: 'scheduler_delete',
      label: 'Scheduler',
      description: 'Delete a scheduled prompt.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to delete.' }),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> {
        const taskId = (params as { taskId: string }).taskId;
        const deleted = await scheduler.delete(taskId, sessionScope());
        return textResult(deleted ? `Deleted task: ${taskId}` : `Task not found: ${taskId}`);
      },
    },
    {
      name: 'scheduler_run_now',
      label: 'Scheduler',
      description: 'Trigger immediate execution of a scheduled prompt, ignoring its schedule.',
      parameters: Type.Object({
        taskId: Type.String({ description: 'The scheduled-prompt ID to run immediately.' }),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
      ): Promise<AgentToolResult<unknown>> {
        const taskId = (params as { taskId: string }).taskId;
        const task = await scheduler.runNow(taskId, sessionScope());
        if (!task) {
          return textResult(`Task not found: ${taskId}`);
        }
        return textResult(`Triggered: ${task.name ?? task.id}`);
      },
    },
  ];
}
