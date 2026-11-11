/**
 * 项目实体注册表的共享目录语义 / 目录移除后的 run 解绑。
 *
 * 这些是「共享目录」能力最容易回归的两处：
 * - 同一 cwd 命中多个项目时不能猜归属（写入操作必须显式 projectId）；
 * - 目录离开项目后，驻留 run 不能继续吃原项目的附加目录。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  configCwdFor,
  projectById,
  projectCwdFor,
  projectIdForCwd,
  projectsContaining,
  resetProjectsForTest,
  seedProjectsForTest,
  uniqueProjectForCwd,
} from "../../src/agent/projects";
import { unbindRunsOutsideProject } from "../../src/sessions/external-dirs";
import { running } from "../../src/sessions/registry";
import type { Running } from "../../src/types";

function project(
  id: string,
  folders: string[],
  updatedAt = "2026-01-01T00:00:00.000Z",
) {
  return {
    id,
    displayName: null,
    nameIsCustom: false,
    appearanceJson: null,
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    showWhenEmpty: true,
    hiddenFromSidebar: false,
    folders: folders.map((path, index) => ({
      path,
      sortOrder: index,
      isPrimary: index === 0,
    })),
  };
}

function fakeRun(sessionId: string, cwd: string, projectId: string | null) {
  return { sessionId, cwd, projectId } as unknown as Running;
}

afterEach(() => {
  resetProjectsForTest();
  running.clear();
});

describe("项目注册表：共享目录", () => {
  test("同一文件夹命中多个项目时不做唯一归属推断", () => {
    seedProjectsForTest([
      project("A", ["/shared/x", "/only/a"], "2026-01-02T00:00:00.000Z"),
      project("B", ["/shared/x", "/only/b"], "2026-01-01T00:00:00.000Z"),
    ]);

    expect(projectsContaining("/shared/x").map((p) => p.id).sort()).toEqual([
      "A",
      "B",
    ]);
    expect(uniqueProjectForCwd("/shared/x")).toEqual(null);
    expect(projectIdForCwd("/shared/x")).toEqual(undefined);
    // 旧协议回退：最近更新的项目（列表序第一个）
    expect(projectCwdFor("/shared/x")).toEqual("/shared/x");
    expect(projectById("B")?.folders.map((f) => f.path)).toEqual([
      "/shared/x",
      "/only/b",
    ]);
  });

  test("独占文件夹仍可自动归属", () => {
    seedProjectsForTest([
      project("A", ["/only/a", "/shared/x"]),
      project("B", ["/shared/x"]),
    ]);
    expect(uniqueProjectForCwd("/only/a")?.id).toEqual("A");
    expect(projectIdForCwd("/only/a")).toEqual("A");
    expect(projectIdForCwd("/shared/x")).toEqual(undefined);
  });

  test("配置根收敛到项目主目录；共享目录无 projectId 时不猜", () => {
    seedProjectsForTest([
      project("A", ["/only/a", "/shared/x"]),
      project("B", ["/only/b", "/shared/x"]),
    ]);
    // 独占附加目录 → 主目录
    expect(configCwdFor("/only/a")).toEqual("/only/a");
    expect(configCwdFor("/shared/x")).toEqual("/shared/x");
    // 显式 projectId：共享目录也能落到对应主目录
    expect(configCwdFor("/shared/x", "A")).toEqual("/only/a");
    expect(configCwdFor("/shared/x", "B")).toEqual("/only/b");
    // 无项目归属保持原 cwd
    expect(configCwdFor("/elsewhere")).toEqual("/elsewhere");
  });
});

describe("目录移出项目：驻留 run 解绑", () => {
  test("cwd 不在新 folders 内的 run 被解绑，仍在项目内的保持不变", () => {
    running.set("t1", fakeRun("s1", "/only/a", "A"));
    running.set("t2", fakeRun("s2", "/shared/x", "A"));
    running.set("t3", fakeRun("s3", "/other", "B"));

    const affected = unbindRunsOutsideProject("A", ["/only/a"]);

    expect(affected).toEqual(["s2"]);
    expect(running.get("t1")?.projectId).toEqual("A");
    expect(running.get("t2")?.projectId).toEqual(null);
    // 其它项目不受影响
    expect(running.get("t3")?.projectId).toEqual("B");
  });

  test("项目归档（folders 为空）解绑全部成员", () => {
    running.set("t1", fakeRun("s1", "/only/a", "A"));
    running.set("t2", fakeRun("s2", "/only/b", "A"));

    expect(unbindRunsOutsideProject("A", [])).toEqual(["s1", "s2"]);
    expect(running.get("t1")?.projectId).toEqual(null);
    expect(running.get("t2")?.projectId).toEqual(null);
  });
});
