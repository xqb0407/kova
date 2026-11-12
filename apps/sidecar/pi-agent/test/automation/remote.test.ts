import { describe, expect, it } from "bun:test";
import type { ScheduledTaskUpdate, TaskSchedulerStatus } from "automation-core";
import { RemoteTaskScheduler } from "../../src/automation/remote";

describe("RemoteTaskScheduler RPC encoding", () => {
  it("encodes explicit undefined update fields so they survive JSON", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const scheduler = new RemoteTaskScheduler(async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "status") {
        return { active: true } as TaskSchedulerStatus;
      }
      return { id: "task-1" };
    });

    const update: ScheduledTaskUpdate = {
      name: undefined,
      description: undefined,
      workspaceDir: undefined,
      projectId: undefined,
      enabled: false,
    };
    await scheduler.update("task-1", update);

    const call = calls.find((entry) => entry.method === "update");
    expect(call).toBeDefined();
    expect(call?.params.undefinedKeys).toEqual([
      "name",
      "description",
      "workspaceDir",
      "projectId",
    ]);
    const input = call?.params.input as Record<string, unknown>;
    expect(input.name).toBeNull();
    expect(input.description).toBeNull();
    expect(input.workspaceDir).toBeNull();
    expect(input.projectId).toBeNull();
    expect(input.enabled).toBe(false);
  });

  it("reflects scheduler active state from status", async () => {
    const scheduler = new RemoteTaskScheduler(async () => ({
      active: true,
    }) as TaskSchedulerStatus);
    await scheduler.status();
    expect(scheduler.isActive()).toBe(true);
  });
});
