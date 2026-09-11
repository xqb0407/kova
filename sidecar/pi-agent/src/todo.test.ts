import { describe, expect, test } from "bun:test";
import {
  applyTaskMutation,
  buildTodoResult,
  deriveBlocks,
  EMPTY_TODO_STATE,
  formatContent,
  isTransitionValid,
  sanitizeTaskText,
  type TaskState,
} from "./todo-state";
import {
  clearTodoState,
  getTodoState,
  replayTodoFromMessages,
} from "./todo";

const create = (state: TaskState, subject: string, extra = {}) =>
  applyTaskMutation(state, "create", { subject, ...extra });

describe("todo reducer: create & ids", () => {
  test("increments ids and starts pending", () => {
    const r1 = create(EMPTY_TODO_STATE, "A");
    expect(r1.op).toEqual({ kind: "create", taskId: 1 });
    expect(r1.state.tasks[0]).toMatchObject({ id: 1, subject: "A", status: "pending" });
    expect(r1.state.nextId).toBe(2);
    const r2 = create(r1.state, "B", { blockedBy: [1] });
    expect(r2.state.tasks[1].blockedBy).toEqual([1]);
  });
  test("rejects blank subject and dangling/deleted deps", () => {
    expect(create(EMPTY_TODO_STATE, "  ").op).toMatchObject({
      kind: "error",
      message: "subject required for create",
    });
    expect(create(EMPTY_TODO_STATE, "x", { blockedBy: [99] }).op).toMatchObject({
      message: "blockedBy: #99 not found",
    });
    const one = create(EMPTY_TODO_STATE, "x");
    const del = applyTaskMutation(one.state, "delete", { id: 1 });
    expect(create(del.state, "y", { blockedBy: [1] }).op).toMatchObject({
      message: "blockedBy: #1 is deleted",
    });
  });
});

describe("todo reducer: transitions & tombstones", () => {
  test("transition table", () => {
    expect(isTransitionValid("pending", "in_progress")).toBe(true);
    expect(isTransitionValid("in_progress", "pending")).toBe(true);
    expect(isTransitionValid("in_progress", "completed")).toBe(true);
    expect(isTransitionValid("completed", "in_progress")).toBe(false);
    expect(isTransitionValid("deleted", "pending")).toBe(false);
    expect(isTransitionValid("completed", "completed")).toBe(true);
  });
  test("completed cannot revive; delete is tombstone", () => {
    const r1 = create(EMPTY_TODO_STATE, "A");
    const done = applyTaskMutation(r1.state, "update", { id: 1, status: "completed" });
    expect(done.op).toMatchObject({ kind: "update", toStatus: "completed", changed: true });
    const back = applyTaskMutation(done.state, "update", { id: 1, status: "in_progress" });
    expect(back.op).toMatchObject({
      kind: "error",
      message: "illegal transition completed -> in_progress",
    });
    const tomb = applyTaskMutation(done.state, "delete", { id: 1 });
    expect(tomb.state.tasks[0].status).toBe("deleted");
    expect(applyTaskMutation(tomb.state, "delete", { id: 1 }).op).toMatchObject({
      message: "#1 is already deleted",
    });
    // 墓碑保留：历史 blockedBy 引用仍可解析（get 不报 not found）
    expect(applyTaskMutation(tomb.state, "get", { id: 1 }).op.kind).toBe("get");
  });
  test("no-op update reports unchanged", () => {
    const r1 = create(EMPTY_TODO_STATE, "A");
    const same = applyTaskMutation(r1.state, "update", { id: 1, status: "pending" });
    expect(same.op).toMatchObject({ kind: "update", changed: false });
    expect(formatContent(same.op, same.state)).toMatch(/^No change: #1/);
    const err = applyTaskMutation(r1.state, "update", { id: 1 })
      .op as { kind: string; message?: string };
    expect(err.kind).toBe("error");
    expect(err.message ?? "").toContain("at least one mutable field");
  });
});

describe("todo reducer: dependency graph", () => {
  test("self-block and cycles rejected", () => {
    const a = create(EMPTY_TODO_STATE, "A");
    const b = create(a.state, "B");
    const c = create(b.state, "C");
    expect(applyTaskMutation(c.state, "update", { id: 1, addBlockedBy: [1] }).op).toMatchObject({
      message: "cannot block #1 on itself",
    });
    const ab = applyTaskMutation(c.state, "update", { id: 1, addBlockedBy: [2] });
    expect(ab.op.kind).toBe("update");
    const bc = applyTaskMutation(ab.state, "update", { id: 2, addBlockedBy: [3] });
    const ca = applyTaskMutation(bc.state, "update", { id: 3, addBlockedBy: [1] });
    expect(ca.op).toMatchObject({
      message: "addBlockedBy would create a cycle in the blockedBy graph",
    });
    expect(ca.state).toBe(bc.state); // 拒绝不动状态
  });
  test("additive merge and reverse blocks", () => {
    const a = create(EMPTY_TODO_STATE, "A");
    const b = create(a.state, "B", { blockedBy: [1] });
    const up = applyTaskMutation(b.state, "update", { id: 2, addBlockedBy: [1] });
    expect(up.state.tasks[1].blockedBy).toEqual([1]); // 去重不重复
    expect(deriveBlocks(up.state.tasks).get(1)).toEqual([2]);
    const rm = applyTaskMutation(up.state, "update", { id: 2, removeBlockedBy: [1] });
    expect(rm.state.tasks[1].blockedBy).toBeUndefined();
  });
  test("metadata null deletes key", () => {
    const a = create(EMPTY_TODO_STATE, "A", { metadata: { k: 1, j: 2 } });
    const up = applyTaskMutation(a.state, "update", { id: 1, metadata: { k: null } });
    expect(up.state.tasks[0].metadata).toEqual({ j: 2 });
  });
});

describe("todo envelope & sanitize", () => {
  test("list hides tombstones by default; format snapshot in details", () => {
    const a = create(EMPTY_TODO_STATE, "A");
    const d = applyTaskMutation(a.state, "delete", { id: 1 });
    expect(formatContent({ kind: "list", includeDeleted: false }, d.state)).toBe("No tasks");
    expect(formatContent({ kind: "list", includeDeleted: true }, d.state)).toContain("[deleted] #1");
    const res = buildTodoResult("list", {}, d.state, { kind: "list", includeDeleted: false });
    expect(res.details).toMatchObject({ action: "list", tasks: d.state.tasks, nextId: 2 });
  });
  test("sanitizeTaskText strips escapes, joins lines, drops bidi marks", () => {
    expect(sanitizeTaskText("a\nb\tc")).toBe("a b c");
    expect(sanitizeTaskText("x")).toBe("x");
    expect(sanitizeTaskText(String.fromCharCode(27) + "[31mred" + String.fromCharCode(7))).toBe("red");
  });
});

describe("todo transcript replay", () => {
  test("last legal snapshot wins; junk ignored; absent keeps empty", () => {
    const thread = "replay-thread";
    const rows = [
      { role: "user", content: "hi" },
      { role: "toolResult", toolName: "write", details: { tasks: "nope" } },
      { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject: "old", status: "pending" }], nextId: 2 } },
      { role: "toolResult", toolName: "todo", details: { tasks: [
        { id: 1, subject: "done", status: "completed" },
        { id: "bad", subject: "junk", status: "pending" },
      ], nextId: 3 } },
    ];
    replayTodoFromMessages(thread, rows);
    const state = getTodoState(thread);
    expect(state.nextId).toBe(3);
    expect(state.tasks).toEqual([{ id: 1, subject: "done", status: "completed" }]);
    clearTodoState(thread);
    replayTodoFromMessages(thread, [{ role: "user", content: "x" }]);
    expect(getTodoState(thread)).toEqual(EMPTY_TODO_STATE);
  });
});
