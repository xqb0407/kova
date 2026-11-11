/**
 * 项目生命周期：归档保留归属并可恢复；彻底删除才解绑会话。
 * 同时验证共享目录下归档 A 不影响 B。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
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
  sessionSetArchived,
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

describe("项目生命周期", () => {
  test("归档可恢复；彻底删除只解绑本项目会话", async () => {
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

    // 1) 归档：项目与会话一起归档，但 project_id 保留（可恢复）
    await dispatch("archive-a", {
      type: "delete_project",
      projectId: a.project.id,
    });
    expect(
      (await sessionList()).find((row) => row.id === "archive-a-session")
        ?.projectId,
    ).toEqual(a.project.id);
    const archivedRow = getLocalDb()!
      .query("SELECT archived FROM sessions WHERE id=?")
      .get("archive-a-session") as { archived: number };
    expect(archivedRow.archived).toEqual(1);
    expect(
      (await projectList(true)).projects.find(
        (project) => project.id === a.project.id,
      )?.archived,
    ).toEqual(true);
    // B 完全不受影响
    expect(
      (await sessionList()).find((row) => row.id === "archive-b-session")
        ?.projectId,
    ).toEqual(b.project.id);

    // 归档期间同名被新项目复用：恢复时必须自动加序号，不能出现重名
    await projectSave({
      displayName: "项目 A",
      folders: [{ path: "/shared", isPrimary: true }],
      showWhenEmpty: true,
    });
    // 新项目是直接写 host 的：重新载入注册表，恢复逻辑才能看到同名占用
    resetProjectsForTest();
    await initProjects();

    // 2) 恢复：项目与会话一起回来，绑定不变
    await dispatch("restore-a", {
      type: "restore_project",
      projectId: a.project.id,
    });
    const restoredProject = (await projectList(true)).projects.find(
      (project) => project.id === a.project.id,
    );
    expect(restoredProject?.archived).toEqual(false);
    expect(restoredProject?.displayName).toEqual("项目 A 2");
    const restoredRow = getLocalDb()!
      .query("SELECT archived FROM sessions WHERE id=?")
      .get("archive-a-session") as { archived: number };
    expect(restoredRow.archived).toEqual(0);
    expect(
      (await sessionList()).find((row) => row.id === "archive-a-session")
        ?.projectId,
    ).toEqual(a.project.id);

    // 3) 彻底删除：实体/folders 删除，会话历史保留但解绑；B 不受影响
    await dispatch("purge-a", {
      type: "delete_project",
      projectId: a.project.id,
      permanent: true,
    });
    expect(
      (await projectList(true)).projects.some(
        (project) => project.id === a.project.id,
      ),
    ).toEqual(false);
    expect(
      (await sessionList()).find((row) => row.id === "archive-a-session")
        ?.projectId,
    ).toEqual(null);
    expect(
      (await projectList(true)).projects.some(
        (project) => project.id === b.project.id,
      ),
    ).toEqual(true);
    expect(
      (await sessionList()).find((row) => row.id === "archive-b-session")
        ?.projectId,
    ).toEqual(b.project.id);

    const rows = getLocalDb()!
      .query("SELECT id FROM projects")
      .all() as { id: string }[];
    // B + 归档期间复用名称的新项目；A 已被彻底删除
    expect(rows.length).toEqual(2);
  });

  test("移除只隐藏项目；勾选删除数据才删会话", async () => {
    // 主目录唯一：这里用独立主目录，/shared 只作附加目录参与共享
    const project = await projectSave({
      displayName: "项目 移除",
      folders: [
        { path: "/shared-remove", isPrimary: true },
        { path: "/shared", isPrimary: false },
      ],
      showWhenEmpty: true,
    });
    await sessionInsert("remove-keep-session", "/shared-remove", {
      projectId: project.project.id,
    });
    await sessionInsert("remove-data-session", "/shared-remove", {
      projectId: project.project.id,
    });
    resetProjectsForTest();
    await initProjects();

    // 只移除：项目仍存在但隐藏，会话归属与归档状态不变
    await dispatch("remove-hide", {
      type: "delete_project",
      projectId: project.project.id,
      hide: true,
    });
    const hidden = (await projectList(true)).projects.find(
      (entry) => entry.id === project.project.id,
    );
    expect(hidden?.hiddenFromSidebar).toEqual(true);
    expect(hidden?.archived).toEqual(false);
    expect(
      (await sessionList()).find((row) => row.id === "remove-keep-session")
        ?.projectId,
    ).toEqual(project.project.id);

    // 移除并删除数据：项目保留（可恢复显示），项目内会话数据删除
    await dispatch("remove-data", {
      type: "delete_project",
      projectId: project.project.id,
      hide: true,
      deleteData: true,
    });
    expect(
      (await projectList(true)).projects.some(
        (entry) => entry.id === project.project.id,
      ),
    ).toEqual(true);
    expect(
      (await sessionList()).some((row) =>
        row.id === "remove-keep-session" || row.id === "remove-data-session",
      ),
    ).toEqual(false);
    // 其他项目的会话仍保留归属
    expect(
      (await sessionList()).find((row) => row.id === "archive-b-session")
        ?.projectId,
    ).toBeTruthy();
  });

  test("新对话唤回移除/归档项目；归档会话不批量恢复", async () => {
    // 移除（隐藏）项目：新对话 → 项目卡回侧栏，非归档会话跟着回来，
    // 归档会话保持归档（只能去设置 → 归档 恢复）
    const hiddenProject = await projectSave({
      displayName: "项目 唤回",
      folders: [{ path: "/shared-revive", isPrimary: true }],
      showWhenEmpty: true,
    });
    await sessionInsert("revive-keep", "/shared-revive", {
      projectId: hiddenProject.project.id,
    });
    await sessionInsert("revive-archived", "/shared-revive", {
      projectId: hiddenProject.project.id,
    });
    await sessionSetArchived("revive-archived", true);
    resetProjectsForTest();
    await initProjects();
    // dispatch new_session 会落 JSONL 转录：init 到临时目录，别写进仓库 cwd
    initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
    await dispatch("revive-hide", {
      type: "delete_project",
      projectId: hiddenProject.project.id,
      hide: true,
    });
    expect(
      (await projectList(true)).projects.find(
        (entry) => entry.id === hiddenProject.project.id,
      )?.hiddenFromSidebar,
    ).toEqual(true);

    const revived = await dispatch("revive-new", {
      type: "new_session",
      threadId: "th-revive",
      cwd: "/shared-revive",
      projectId: hiddenProject.project.id,
    });
    const revivedProject = (await projectList(true)).projects.find(
      (entry) => entry.id === hiddenProject.project.id,
    );
    expect(revivedProject?.hiddenFromSidebar).toEqual(false);
    expect(revivedProject?.archived).toEqual(false);
    // 新会话绑回项目
    expect(
      (await sessionList()).find((row) => row.id === "revive-keep")
        ?.projectId,
    ).toEqual(hiddenProject.project.id);
    // 归档会话不动
    const archivedRow = getLocalDb()!
      .query("SELECT archived, project_id FROM sessions WHERE id=?")
      .get("revive-archived") as {
      archived: number;
      project_id: string | null;
    };
    expect(archivedRow.archived).toEqual(1);
    expect(archivedRow.project_id).toEqual(hiddenProject.project.id);

    // 归档项目：新对话只复活项目卡，归档会话不批量恢复
    const archivedProject = await projectSave({
      displayName: "项目 复活",
      folders: [{ path: "/shared-revive2", isPrimary: true }],
      showWhenEmpty: true,
    });
    await sessionInsert("revive2-archived", "/shared-revive2", {
      projectId: archivedProject.project.id,
    });
    await sessionSetArchived("revive2-archived", true);
    resetProjectsForTest();
    await initProjects();
    await dispatch("revive2-archive", {
      type: "delete_project",
      projectId: archivedProject.project.id,
    });
    expect(
      (await projectList(true)).projects.find(
        (entry) => entry.id === archivedProject.project.id,
      )?.archived,
    ).toEqual(true);

    await dispatch("revive2-new", {
      type: "new_session",
      threadId: "th-revive2",
      cwd: "/shared-revive2",
      projectId: archivedProject.project.id,
    });
    const revivedArchived = (await projectList(true)).projects.find(
      (entry) => entry.id === archivedProject.project.id,
    );
    expect(revivedArchived?.archived).toEqual(false);
    // 旧归档会话不动（新对话本身是非归档会话，属正常）
    const oldArchived = getLocalDb()!
      .query("SELECT archived FROM sessions WHERE id=?")
      .get("revive2-archived") as { archived: number };
    expect(oldArchived.archived).toEqual(1);
  });
});
