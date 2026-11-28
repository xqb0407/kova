/**
 * 独立 kova-automation 进程的 TaskScheduler 代理。
 *
 * sidecar 继续使用既有 TaskScheduler 接口：命令层、scheduler_* 工具、
 * runner 都不需要知道调度器在另一个进程。
 */
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskUpdate,
  TaskScheduler,
  TaskSchedulerScope,
  TaskSchedulerStatus,
} from "automation-core";
import { hostAutomationRpc } from "../storage/hostdb";

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export class RemoteTaskScheduler implements TaskScheduler {
  private active = false;

  constructor(private readonly rpc: Rpc = hostAutomationRpc) {}

  async list(_scope?: TaskSchedulerScope): Promise<ScheduledTask[]> {
    const tasks = (await this.rpc("list")) as ScheduledTask[];
    return Array.isArray(tasks) ? tasks : [];
  }

  async get(taskId: string, _scope?: TaskSchedulerScope): Promise<ScheduledTask | undefined> {
    return (await this.rpc("get", { taskId })) as ScheduledTask | undefined;
  }

  async status(): Promise<TaskSchedulerStatus> {
    const status = (await this.rpc("status")) as TaskSchedulerStatus;
    this.active = status?.active === true;
    return status;
  }

  isActive(): boolean {
    return this.active;
  }

  async create(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    return (await this.rpc("create", { input })) as ScheduledTask;
  }

  async update(
    taskId: string,
    input: ScheduledTaskUpdate,
    _scope?: TaskSchedulerScope,
  ): Promise<ScheduledTask | undefined> {
    // JSON RPC 会丢掉 undefined 字段；core.update 恰好依赖“own key + undefined”
    // 来区分“不修改”与“清除 name/description/workspaceDir/projectId”。
    const undefinedKeys = Object.keys(input).filter(
      (key) => input[key as keyof ScheduledTaskUpdate] === undefined,
    );
    const encodedInput: Record<string, unknown> = { ...input };
    for (const key of undefinedKeys) encodedInput[key] = null;
    return (await this.rpc("update", {
      taskId,
      input: encodedInput,
      undefinedKeys,
    })) as ScheduledTask | undefined;
  }

  async delete(taskId: string, _scope?: TaskSchedulerScope): Promise<boolean> {
    return (await this.rpc("delete", { taskId })) === true;
  }

  async deleteHistory(
    taskId: string,
    entryIds: string[] | "all",
    _scope?: TaskSchedulerScope,
  ): Promise<ScheduledTask | undefined> {
    return (await this.rpc("delete_history", {
      taskId,
      entryIds,
    })) as ScheduledTask | undefined;
  }

  async runNow(taskId: string, _scope?: TaskSchedulerScope): Promise<ScheduledTask | undefined> {
    return (await this.rpc("run_now", { taskId })) as ScheduledTask | undefined;
  }

  /** 本地扩展（L1）：带触发来源立即运行（经宿主 RPC 到独立调度进程）。 */
  async runWithContext(
    taskId: string,
    trigger: {
      type: "webhook" | "file" | "git" | "im" | "connector" | "manual";
      id?: string;
      summary?: string;
    },
  ): Promise<ScheduledTask | undefined> {
    return (await this.rpc("run_with_trigger", { taskId, trigger })) as
      | ScheduledTask
      | undefined;
  }

  async start(): Promise<void> {
    await this.rpc("start");
    this.active = true;
  }

  async stop(): Promise<void> {
    this.active = false;
  }
}
