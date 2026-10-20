import { afterAll, describe, expect, test } from "bun:test";
import { piSessionCwdMap } from "./pi-thread-adapter";
import { listProjectDirectories } from "./pi-session-move";

const KEYS = ["move-a", "move-b", "move-c", "move-deleted", "move-empty"];

afterAll(() => {
  for (const key of KEYS) piSessionCwdMap.delete(key);
});

describe("listProjectDirectories", () => {
  test("只取存活会话的 cwd：去重、排除当前项目、忽略已删会话与任务会话", () => {
    piSessionCwdMap.set("move-a", "/proj/a");
    // 同一目录的另一种写法（尾斜杠）：规范化后与 a 是同一个项目
    piSessionCwdMap.set("move-b", "/proj/a/");
    piSessionCwdMap.set("move-c", "/proj/c");
    // 镜像里残留但会话已不在当前清单里（幽灵项目）
    piSessionCwdMap.set("move-deleted", "/proj/deleted");
    // 任务会话：没有项目目录
    piSessionCwdMap.set("move-empty", "");

    expect(
      listProjectDirectories(
        ["move-a", "move-b", "move-c", "move-empty", "move-ghost"],
        "/proj/a",
      ),
    ).toEqual(["/proj/c"]);
  });

  test("没有可排除的当前项目时，所有存活项目都返回", () => {
    piSessionCwdMap.set("move-a", "/proj/a");
    piSessionCwdMap.set("move-c", "/proj/c");
    expect(listProjectDirectories(["move-a", "move-c"])).toEqual([
      "/proj/a",
      "/proj/c",
    ]);
  });
});
