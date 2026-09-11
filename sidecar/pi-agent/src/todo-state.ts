/**
 * todo 工具纯逻辑层（移植自 rpiv-mono packages/rpiv-todo：tool/types、
 * state/invariants、state/task-graph、state/state-reducer、tool/response-envelope、
 * tool/sanitize 六个模块，语义与错误文案原样保留）。
 *
 * 状态机 4 态：pending ↔ in_progress → completed，deleted 为墓碑终态；
 * blockedBy 依赖图在变更**前**校验（悬空/墓碑/自环/成环拒绝），失败不改状态。
 * 持久化走事件溯源：每次成功调用把变更后的全量快照放进 toolResult.details
 * （buildToolResult），重启/压缩后由 todo.ts 回放转录最后一个快照重建清单。
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const TODO_TOOL_NAME = "todo";

/* --------------------------------- 类型 --------------------------------- */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TaskAction =
  | "create"
  | "update"
  | "list"
  | "get"
  | "delete"
  | "clear";

export type Task = {
  id: number;
  subject: string;
  description?: string;
  /** in_progress 期间面板展示的现在进行时标签（如 "writing tests"） */
  activeForm?: string;
  status: TaskStatus;
  /** 本任务等待的 id 集合 */
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
};

/** 回放快照：transcript toolResult.details 的持久化形状（字段名跨版本兼容） */
export type TaskDetails = {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
};

export type TaskState = { tasks: Task[]; nextId: number };

export const EMPTY_TODO_STATE: TaskState = { tasks: [], nextId: 1 };

/* ------------------------------- 参数 schema ------------------------------- */

export const TodoParamsSchema = Type.Object({
  action: StringEnum(
    ["create", "update", "list", "get", "delete", "clear"] as const,
  ),
  subject: Type.Optional(
    Type.String({ description: "Task subject line (required for create)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "Long-form task description" }),
  ),
  activeForm: Type.Optional(
    Type.String({
      description:
        "Present-continuous label shown while status is in_progress (e.g. 'writing tests')",
    }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
      description:
        "Set this task's status (update): one of pending, in_progress, completed, deleted. When action is list, filters returned tasks by this status.",
    }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Initial blockedBy ids (create only)",
    }),
  ),
  addBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description: "Task ids to add to blockedBy (update only, additive merge)",
    }),
  ),
  removeBlockedBy: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "Task ids to remove from blockedBy (update only, additive merge)",
    }),
  ),
  owner: Type.Optional(
    Type.String({ description: "Agent/owner assigned to this task" }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        "Arbitrary metadata; pass null value for a key to delete that key on update",
    }),
  ),
  id: Type.Optional(
    Type.Number({ description: "Task id (required for update, get, delete)" }),
  ),
  includeDeleted: Type.Optional(
    Type.Boolean({
      description:
        "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
    }),
  ),
});

/** reducer 接受的宽松参数袋 */
export type TaskMutationParams = {
  [key: string]: unknown;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  includeDeleted?: boolean;
};

/* ------------------------------- 状态迁移表 ------------------------------- */

/** completed 只能单向去 deleted；deleted 终态。同态迁移恒接受（no-op 检测另做）。 */
const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};

export function isTransitionValid(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}

/* -------------------------------- 依赖图 -------------------------------- */

/** 把 newBlockedBy 并入 taskId 的 blockedBy 是否会成环（DFS 三色探环，纯函数）。 */
export function detectCycle(
  taskList: readonly Task[],
  taskId: number,
  newBlockedBy: readonly number[],
): boolean {
  const edges = new Map<number, number[]>();
  for (const t of taskList) {
    if (t.id === taskId) {
      const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
      edges.set(t.id, [...merged]);
    } else {
      edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const hasCycleFrom = (node: number): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const nb of edges.get(node) ?? []) {
      if (hasCycleFrom(nb)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of edges.keys()) {
    if (hasCycleFrom(node)) return true;
  }
  return false;
}

/** 反向邻接：谁在等 #id（get 动作的 blocks: 行 / 面板阻塞标注用） */
export function deriveBlocks(
  taskList: readonly Task[],
): Map<number, number[]> {
  const blocks = new Map<number, number[]>();
  for (const t of taskList) {
    for (const dep of t.blockedBy ?? []) {
      const arr = blocks.get(dep) ?? [];
      arr.push(t.id);
      blocks.set(dep, arr);
    }
  }
  return blocks;
}

/* ------------------------------ 文本消毒 ------------------------------ */

const CHAR_ESC = String.fromCharCode(0x1b);
const CHAR_CSI = String.fromCharCode(0x9b);
const CHAR_OSC = String.fromCharCode(0x9d);
const CHAR_BEL = String.fromCharCode(0x07);
const CHAR_ST = String.fromCharCode(0x9c);

/** 消费从 start 起的整段转义序列（CSI/OSC/双字符 ESC），返回序列末位下标 */
function skipEscapeSequence(s: string, start: number): number {
  const lead = s[start];
  let i = start + 1;
  if (lead === CHAR_CSI || (lead === CHAR_ESC && s[i] === "[")) {
    if (lead === CHAR_ESC) i += 1; // 跳过 [
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x3f) i += 1;
    while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x2f) i += 1;
    if (i < s.length && s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e) i += 1;
    return i - 1;
  }
  if (lead === CHAR_OSC || (lead === CHAR_ESC && s[i] === "]")) {
    if (lead === CHAR_ESC) i += 1; // 跳过 ]
    while (i < s.length && s[i] !== CHAR_BEL && s[i] !== CHAR_ST) {
      if (s[i] === CHAR_ESC && s[i + 1] === "\\") {
        i += 2;
        break;
      }
      i += 1;
    }
    if (i < s.length && (s[i] === CHAR_BEL || s[i] === CHAR_ST)) i += 1;
    return i - 1;
  }
  // 双字符 ESC 序列：吞掉下一个字符
  return Math.min(i, s.length - 1);
}

/**
 * 清除模型可控文本里的终端控制序列 / bidi 控制符 / U+2028/9；
 * 换行与制表符换成空格（rpiv sanitizeTerminalText 的等价扫描器实现）。
 */
export function sanitizeTaskText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === CHAR_ESC || ch === CHAR_CSI || ch === CHAR_OSC) {
      i = skipEscapeSequence(value, i);
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += " ";
      continue;
    }
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code === 0x2028 || code === 0x2029) {
      out += " ";
      continue;
    }
    // bidi 嵌入/覆写/隔离控制符与 LRM/RLM 标记
    if (code === 0x200e || code === 0x200f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    out += ch;
  }
  return out;
}

/* ------------------------------- reducer ------------------------------- */

/** 操作结果封闭标签联合：新 action 必须同时扩这里与 formatContent（编译器兜底） */
export type Op =
  | { kind: "create"; taskId: number }
  | {
      kind: "update";
      id: number;
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
      changed: boolean;
    }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export type ApplyResult = { state: TaskState; op: Op };

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

function sameNumberList(
  a: number[] | undefined,
  b: number[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 本次 update 是否真的改了东西；no-op 要让模型看见（防重复发同一调用死循环） */
function taskChanged(before: Task, after: Task): boolean {
  return (
    before.subject !== after.subject ||
    before.status !== after.status ||
    before.description !== after.description ||
    before.activeForm !== after.activeForm ||
    before.owner !== after.owner ||
    !sameNumberList(before.blockedBy, after.blockedBy) ||
    !sameRecord(before.metadata, after.metadata)
  );
}

/**
 * 纯 reducer：(state, action, params) → (state, op)。校验全内联——结构守卫
 * （subject/id/可变字段必填）+ 状态感知检查（迁移合法性、悬空/墓碑依赖、
 * 自环、成环）；被拒的调用不动状态。
 */
export function applyTaskMutation(
  state: TaskState,
  action: TaskAction,
  params: TaskMutationParams,
): ApplyResult {
  switch (action) {
    case "create": {
      if (!params.subject?.trim())
        return errorResult(state, "subject required for create");
      if (params.blockedBy?.length) {
        for (const dep of params.blockedBy) {
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask)
            return errorResult(state, `blockedBy: #${dep} not found`);
          if (depTask.status === "deleted")
            return errorResult(state, `blockedBy: #${dep} is deleted`);
        }
      }
      const newTask: Task = {
        id: state.nextId,
        subject: params.subject,
        status: "pending",
      };
      if (params.description) newTask.description = params.description;
      if (params.activeForm) newTask.activeForm = params.activeForm;
      if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
      if (params.owner) newTask.owner = params.owner;
      if (params.metadata) newTask.metadata = { ...params.metadata };
      return {
        state: {
          tasks: [...state.tasks, newTask],
          nextId: state.nextId + 1,
        },
        op: { kind: "create", taskId: newTask.id },
      };
    }

    case "update": {
      if (params.id === undefined)
        return errorResult(state, "id required for update");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined ||
        params.owner !== undefined ||
        params.metadata !== undefined ||
        (params.addBlockedBy?.length ?? 0) > 0 ||
        (params.removeBlockedBy?.length ?? 0) > 0;
      if (!hasMutation)
        return errorResult(
          state,
          "update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
        );
      let newStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status))
          return errorResult(
            state,
            `illegal transition ${current.status} -> ${params.status}`,
          );
        newStatus = params.status;
      }
      let newBlockedBy = current.blockedBy
        ? [...current.blockedBy]
        : [];
      if (params.removeBlockedBy?.length) {
        const toRemove = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
      }
      if (params.addBlockedBy?.length) {
        for (const dep of params.addBlockedBy) {
          if (dep === current.id)
            return errorResult(
              state,
              `cannot block #${current.id} on itself`,
            );
          const depTask = state.tasks.find((t) => t.id === dep);
          if (!depTask)
            return errorResult(state, `addBlockedBy: #${dep} not found`);
          if (depTask.status === "deleted")
            return errorResult(state, `addBlockedBy: #${dep} is deleted`);
          if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
        }
        if (detectCycle(state.tasks, current.id, newBlockedBy))
          return errorResult(
            state,
            "addBlockedBy would create a cycle in the blockedBy graph",
          );
      }
      let newMetadata = current.metadata;
      if (params.metadata !== undefined) {
        const merged: Record<string, unknown> = {
          ...(current.metadata ?? {}),
        };
        for (const [k, v] of Object.entries(params.metadata)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        newMetadata = Object.keys(merged).length ? merged : undefined;
      }
      const updated: Task = { ...current, status: newStatus };
      if (params.subject !== undefined) updated.subject = params.subject;
      if (params.description !== undefined)
        updated.description = params.description;
      if (params.activeForm !== undefined)
        updated.activeForm = params.activeForm;
      if (params.owner !== undefined) updated.owner = params.owner;
      if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
      else delete updated.blockedBy;
      if (newMetadata === undefined) delete updated.metadata;
      else updated.metadata = newMetadata;
      const updatedTasks = [...state.tasks];
      updatedTasks[idx] = updated;
      return {
        state: { tasks: updatedTasks, nextId: state.nextId },
        op: {
          kind: "update",
          id: updated.id,
          fromStatus: current.status,
          toStatus: newStatus,
          changed: taskChanged(current, updated),
        },
      };
    }

    case "list":
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status !== undefined
            ? { statusFilter: params.status }
            : {}),
        },
      };

    case "get": {
      if (params.id === undefined)
        return errorResult(state, "id required for get");
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) return errorResult(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined)
        return errorResult(state, "id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted")
        return errorResult(state, `#${current.id} is already deleted`);
      const afterDelete = [...state.tasks];
      afterDelete[idx] = { ...current, status: "deleted" };
      return {
        state: { tasks: afterDelete, nextId: state.nextId },
        op: {
          kind: "delete",
          id: current.id,
          subject: current.subject,
        },
      };
    }

    case "clear": {
      const count = state.tasks.length;
      return {
        state: { tasks: [], nextId: 1 },
        op: { kind: "clear", count },
      };
    }
  }
}

/* --------------------------- response envelope --------------------------- */

/** `[status] #id subject [(activeForm)] [chain #dep,#dep]`（list 动作的行格式） */
function formatListLine(t: Task): string {
  const chain = t.blockedBy?.length
    ? ` [chain ${t.blockedBy.map((id) => `#${id}`).join(",")}]`
    : "";
  const form =
    t.status === "in_progress" && t.activeForm
      ? ` (${sanitizeTaskText(t.activeForm)})`
      : "";
  return `[${t.status}] #${t.id} ${sanitizeTaskText(t.subject)}${form}${chain}`;
}

/** get 动作的多行详情：description / activeForm / blockedBy / blocks / owner */
function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [
    `#${task.id} [${task.status}] ${sanitizeTaskText(task.subject)}`,
  ];
  if (task.description)
    lines.push(
      `  description: ${sanitizeTaskText(task.description)}`,
    );
  if (task.activeForm)
    lines.push(
      `  activeForm: ${sanitizeTaskText(task.activeForm)}`,
    );
  if (task.blockedBy?.length)
    lines.push(
      `  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`,
    );
  if (blocks.length)
    lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  if (task.owner) lines.push(`  owner: ${sanitizeTaskText(task.owner)}`);
  return lines.join("\n");
}

/** 纯格式化 (op, state) → content 文本；op.kind 封闭 switch 编译兜底 */
export function formatContent(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": {
      const t = state.tasks.find((x) => x.id === op.taskId);
      if (!t) return `Created #${op.taskId}`;
      return `Created #${t.id}: ${sanitizeTaskText(t.subject)} (pending)`;
    }
    case "update":
      if (!op.changed)
        return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
      return `Updated #${op.id}${
        op.fromStatus !== op.toStatus
          ? ` (${op.fromStatus} -> ${op.toStatus})`
          : ""
      }`;
    case "delete":
      return `Deleted #${op.id}: ${sanitizeTaskText(op.subject)}`;
    case "clear":
      return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted)
        view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter)
        view = view.filter((t) => t.status === op.statusFilter);
      return view.length === 0
        ? "No tasks"
        : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return `Error: ${op.message}`;
  }
}

/**
 * 组装回给模型的 tool 结果。details 是持久化 + 回放快照（todo.ts 的
 * replayTodoFromMessages 消费这个形状）；错误带内返回（不 throw）。
 */
export function buildTodoResult(
  action: TaskAction,
  params: TaskMutationParams,
  state: TaskState,
  op: Op,
): {
  content: Array<{ type: "text"; text: string }>;
  details: TaskDetails;
} {
  const details: TaskDetails = {
    action,
    params: params as Record<string, unknown>,
    tasks: state.tasks,
    nextId: state.nextId,
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return {
    content: [{ type: "text", text: formatContent(op, state) }],
    details,
  };
}
