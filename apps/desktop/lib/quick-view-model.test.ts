/**
 * 快速查看展示模型的单测：todo 渲染行映射、Task 委派行提取、交付物分组。
 */
import { describe, expect, test } from "bun:test";
import type { TodoTask } from "@/lib/pi/pi-todo";
import {
  groupArtifacts,
  taskDelegations,
  todoRows,
  type QuickMessage,
} from "./quick-view-model";

const task = (over: Partial<TodoTask> & { id: number }): TodoTask => ({
  subject: `任务 ${over.id}`,
  status: "pending",
  ...over,
});

describe("todoRows", () => {
  test("deleted 墓碑剔除，状态与文案按面板口径映射", () => {
    const rows = todoRows([
      task({ id: 1, status: "completed" }),
      task({ id: 2, status: "deleted" }),
      task({ id: 3, status: "in_progress", subject: "重构页面", activeForm: "正在重构页面" }),
      task({ id: 4, status: "pending" }),
    ]);
    expect(rows.map((r) => [r.badge, r.text, r.state])).toEqual([
      [1, "任务 1", "done"],
      [3, "正在重构页面", "active"],
      [4, "任务 4", "pending"],
    ]);
  });

  test("activeForm 缺省回落 subject；快照原序保留（不按状态重排）", () => {
    const rows = todoRows([
      task({ id: 2, status: "in_progress" }),
      task({ id: 1, status: "pending" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["2", "1"]);
    expect(rows[0]!.text).toBe("任务 2");
  });
});

describe("taskDelegations", () => {
  test("只收 assistant 消息里的 Task tool-call，提取 agent/description", () => {
    const messages: QuickMessage[] = [
      { role: "user", content: [] },
      {
        role: "assistant",
        content: [
          { type: "text" },
          {
            type: "tool-call",
            toolName: "Task",
            toolCallId: "call-1",
            args: { agent: "Explore", description: "找一下入口文件" },
          },
          {
            type: "tool-call",
            toolName: "bash",
            toolCallId: "call-2",
            args: { command: "ls" },
          },
        ],
      },
    ];
    expect(taskDelegations(messages)).toEqual([
      { toolCallId: "call-1", agentName: "Explore", description: "找一下入口文件", result: undefined },
    ]);
  });

  test("args 未成形/缺 toolCallId 的委派行不收录（流式早期占位无意义）", () => {
    const messages: QuickMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: "Task", toolCallId: "call-1" },
          { type: "tool-call", toolName: "Task" },
        ],
      },
    ];
    expect(taskDelegations(messages)).toEqual([
      { toolCallId: "call-1", agentName: "", description: "", result: undefined },
    ]);
  });
});

describe("groupArtifacts", () => {
  const artifact = (path: string, openMode?: "browser" | "file" | "system") => ({
    toolCallId: `t-${path}`,
    path,
    base: path,
    size: 1,
    ...(openMode ? { openMode } : {}),
  });

  test("browser 产物归 preview，其余归 workspace", () => {
    const groups = groupArtifacts(
      [artifact("index.html", "browser"), artifact("main.ts"), artifact("a.pdf", "system")],
      { canPreview: true },
    );
    expect(groups.preview.map((a) => a.path)).toEqual(["index.html"]);
    expect(groups.workspace.map((a) => a.path)).toEqual(["main.ts", "a.pdf"]);
  });

  test("canPreview=false（网页端）全部归 workspace", () => {
    const groups = groupArtifacts([artifact("index.html", "browser")], {
      canPreview: false,
    });
    expect(groups.preview).toEqual([]);
    expect(groups.workspace).toHaveLength(1);
  });

  test("openMode 缺省按扩展名推导（html → browser）", () => {
    const groups = groupArtifacts([artifact("page.html")], { canPreview: true });
    expect(groups.preview.map((a) => a.path)).toEqual(["page.html"]);
  });
});
