import { describe, expect, test } from "bun:test";
import {
  composeQuitTasks,
  normalizeQuitTitle,
  QUIT_TITLE_MAX,
  type QuitTaskInfo,
} from "../main/quit-tasks";

const kinds = (tasks: QuitTaskInfo[]) => tasks.map((t) => t.kind);

describe("退出任务清单", () => {
  test("按会话 → 后台 → 终端 → 服务排序", () => {
    const tasks = composeQuitTasks({
      sessions: [{ id: "s1", title: "重构认证模块" }],
      background: [{ id: 7, command: "npm run dev" }],
      terminals: [{ id: "pty-1", cwd: "/Users/me/project" }],
      services: [
        { kind: "engine", running: true },
        { kind: "automation", running: true },
      ],
    });

    expect(kinds(tasks)).toEqual([
      "session",
      "background",
      "terminal",
      "engine",
      "automation",
    ]);
    expect(tasks[0]!.id).toBe("session:s1");
    expect(tasks[1]!.id).toBe("background:7");
    expect(tasks[2]!.title).toBe("project");
  });

  test("标题为空回退首条消息；再空则留 null 交给渲染层翻译", () => {
    const tasks = composeQuitTasks({
      sessions: [
        { id: "a", title: "", firstMessage: "帮我看看这个报错" },
        { id: "b", title: "   ", firstMessage: "   " },
      ],
      background: [],
      terminals: [],
      services: [],
    });

    expect(tasks[0]!.title).toBe("帮我看看这个报错");
    expect(tasks[1]!.title).toBeNull();
  });

  test("标题单行化并按上限截断", () => {
    const long = `${"a".repeat(QUIT_TITLE_MAX + 20)}\nsecond line`;
    const tasks = composeQuitTasks({
      sessions: [{ id: "s", title: long }],
      background: [],
      terminals: [],
      services: [],
    });

    expect(tasks[0]!.title).not.toContain("\n");
    expect(tasks[0]!.title!.length).toBe(QUIT_TITLE_MAX);
    expect(tasks[0]!.title!.endsWith("…")).toBe(true);
    expect(normalizeQuitTitle("  a   b  ")).toBe("a b");
  });

  test("只在运行中的服务入列，避免空步骤", () => {
    const tasks = composeQuitTasks({
      sessions: [],
      background: [],
      terminals: [],
      services: [
        { kind: "automation", running: false },
        { kind: "engine", running: true },
        { kind: "remote", running: false },
        { kind: "im", running: true },
      ],
    });

    expect(tasks.map((t) => t.id)).toEqual(["service:engine", "service:im"]);
  });

  test("id 去重：同一会话/后台任务只出现一次", () => {
    const tasks = composeQuitTasks({
      sessions: [
        { id: "same", title: "A" },
        { id: "same", title: "B" },
      ],
      background: [
        { id: 1, command: "x" },
        { id: 1, command: "y" },
      ],
      terminals: [
        { id: "t", cwd: "/a" },
        { id: "t", cwd: "/b" },
      ],
      services: [
        { kind: "engine", running: true },
        { kind: "engine", running: true },
      ],
    });

    expect(tasks).toHaveLength(4);
    expect(tasks[0]!.title).toBe("A");
  });

  test("终端 cwd 末级目录：兼容 Windows 分隔符与尾斜杠", () => {
    const tasks = composeQuitTasks({
      sessions: [],
      background: [],
      terminals: [
        { id: "w", cwd: "C:\\Users\\me\\repo\\" },
        { id: "u", cwd: "/home/me/repo/" },
        { id: "empty", cwd: "" },
      ],
      services: [],
    });

    expect(tasks[0]!.title).toBe("repo");
    expect(tasks[1]!.title).toBe("repo");
    expect(tasks[2]!.title).toBeNull();
  });
});
