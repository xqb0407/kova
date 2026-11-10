/**
 * 归档项目的隔离性：共享同一目录的两个项目，归档 A 只能解绑 A 的会话。
 * 复现用户反馈“归档一个，两个项目一起归档”的路径。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getLocalDb,
  initLocalStorage,
  resetStorageForTest,
} from "../../src/storage/hostdb/local";
import {
  projectList,
  projectSave,
  sessionInsert,
  sessionList,
} from "../../src/storage/hostdb";
import { initProjects, resetProjectsForTest } from "../../src/agent/projects";
import { dispatch } from "../../src/protocol/protocol";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-project-archive-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

afterAll(() => {
  resetProjectsForTest();
  resetStorageForTest();
});

describe("归档项目：共享目录隔离", () => {
  test("归档 A 只解绑 A 的会话，B 的会话与项目保持", async () => {
    const a = await projectSave({
      displayName: "项目 A",
      folders: [{ path: "/shared", isPrimary: true }],
      showWhenEmpty: true,
    });
    const b = await projectSave({
      displayName: "项目 B",
      folders: [{ path: "/shared", isPrimary: true }],
      showWhenEmpty: true,
    });
    await sessionInsert("archive-a-session", "/shared", {
      projectId: a.project.id,
    });
    await sessionInsert("archive-b-session", "/shared", {
      projectId: b.project.id,
    });

    // 从 host 重新加载注册表（模拟启动）
    resetProjectsForTest();
    await initProjects();

    await dispatch("archive-a", {
      type: "delete_project",
      projectId: a.project.id,
    });

    const sessions = await sessionList();
    expect(
      sessions.find((row) => row.id === "archive-a-session")?.projectId,
    ).toEqual(null);
    expect(
      sessions.find((row) => row.id === "archive-b-session")?.projectId,
    ).toEqual(b.project.id);

    const { projects } = await projectList(true);
    expect(projects.find((project) => project.id === a.project.id)?.archived).toEqual(
      true,
    );
    expect(projects.find((project) => project.id === b.project.id)?.archived).toEqual(
      false,
    );

    // 本地库仍然是两个项目两行
    const rows = getLocalDb()!
      .query("SELECT id, archived FROM projects ORDER BY id")
      .all() as { id: string; archived: number }[];
    expect(rows.length).toEqual(2);
  });
});
