/**
 * local 模式项目迁移/持久化回归：旧 pi.projectDirs → projects + sessions.project_id，
 * 以及 project_save 的事务真的落库（bun:sqlite 的 transaction 需要调用）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getLocalDb,
  initLocalStorage,
  resetStorageForTest,
} from "../../src/storage/hostdb/local";
import {
  projectDelete,
  projectList,
  projectSave,
} from "../../src/storage/hostdb";
import {
  initProjects,
  resetProjectsForTest as resetProjectRegistry,
  saveProject as saveProjectService,
  seedProjectsForTest,
} from "../../src/agent/projects";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-local-projects-"));

function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      first_message TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '',
      parent_session TEXT NOT NULL DEFAULT ''
    );
  `);
  db.query("INSERT INTO kv(key,value) VALUES(?,?)").run(
    "pi.projectDirs",
    JSON.stringify({ "/work/a": [{ path: "/work/b", label: "b" }] }),
  );
  db.query("INSERT INTO kv(key,value) VALUES(?,?)").run(
    "remote.projects",
    JSON.stringify([{ remotePath: "/remote/x" }]),
  );
  const insert = db.query(
    "INSERT INTO sessions(id,cwd,created_at,updated_at,kind,parent_session) VALUES(?,?,?,?,?,?)",
  );
  const rows: [string, string, string, string, string][] = [
    ["main", "/work/a/", "01", "", ""],
    ["root", "/work/b", "02", "", ""],
    ["sub", "/work/a/sub", "03", "", ""],
    ["task", "", "04", "", ""],
    ["remote", "/remote/x", "05", "", ""],
    ["side", "/work/b", "06", "side_chat", "main"],
  ];
  for (const [id, cwd, second, kind, parent] of rows) {
    const stamp = `2026-01-01T00:00:${second}Z`;
    insert.run(id, cwd, stamp, stamp, kind, parent);
  }
  db.close();
}

afterAll(() => {
  resetStorageForTest();
});

describe("local 模式：项目迁移与保存", () => {
  test("旧项目目录/会话 cwd 迁移到 projects 并回填 project_id", () => {
    const dbPath = path.join(tmp, "legacy.db");
    seedLegacyDb(dbPath);
    initLocalStorage(dbPath);
    const db = getLocalDb()!;

    const projects = db.query("SELECT id FROM projects").all() as {
      id: string;
    }[];
    const folders = db
      .query(
        "SELECT project_id,path,sort_order,is_primary FROM project_folders ORDER BY sort_order",
      )
      .all() as {
      project_id: string;
      path: string;
      sort_order: number;
      is_primary: number;
    }[];
    const mainProject = folders.find((folder) => folder.path === "/work/a")!;
    expect(
      folders
        .filter((folder) => folder.project_id === mainProject.project_id)
        .map((folder) => folder.path),
    ).toEqual(["/work/a", "/work/b"]);
    expect(projects.length).toBe(2); // 主项目 + /work/a/sub 独立项目

    const projectOf = (id: string): string | null =>
      (
        db.query("SELECT project_id FROM sessions WHERE id=?").get(id) as {
          project_id: string | null;
        }
      ).project_id;
    expect(projectOf("main")).toEqual(mainProject.project_id);
    expect(projectOf("root")).toEqual(mainProject.project_id);
    expect(projectOf("side")).toEqual(mainProject.project_id);
    expect(projectOf("sub")).not.toEqual(mainProject.project_id);
    expect(projectOf("task")).toEqual(null);
    expect(projectOf("remote")).toEqual(null);
  });

  test("project_save / project_list / project_delete 在 local 模式可用", async () => {
    initLocalStorage(path.join(tmp, "save.db"));
    const saved = await projectSave({
      displayName: "项目 A",
      nameIsCustom: true,
      folders: [
        { path: "/only/a", isPrimary: true },
        { path: "/only/b" },
      ],
      primaryPath: "/only/a",
      showWhenEmpty: true,
    });
    expect(saved.project.displayName).toEqual("项目 A");
    expect(saved.project.folders.map((folder) => folder.path)).toEqual([
      "/only/a",
      "/only/b",
    ]);

    const listed = await projectList(true);
    expect(listed.projects.some((project) => project.id === saved.project.id)).toEqual(
      true,
    );

    // 只改外观：名称/folders 必须保留（与 Host 的 undefined = 不改语义一致）
    const patched = await projectSave({
      id: saved.project.id,
      appearanceJson: '{"color":"#ffffff"}',
      folders: [{ path: "/only/a" }, { path: "/only/b" }],
      primaryPath: "/only/a",
    });
    expect(patched.project.displayName).toEqual("项目 A");
    expect(patched.project.appearanceJson).toEqual('{"color":"#ffffff"}');
    expect(patched.project.folders.map((folder) => folder.path)).toEqual([
      "/only/a",
      "/only/b",
    ]);

    await projectDelete(saved.project.id);
    const after = await projectList(false);
    expect(after.projects.some((project) => project.id === saved.project.id)).toEqual(
      false,
    );
  });

  test("只改名称/外观：目录已不存在也不阻断编辑", async () => {
    initLocalStorage(path.join(tmp, "rename.db"));
    const saved = await projectSave({
      folders: [{ path: "/missing/a", isPrimary: true }],
      primaryPath: "/missing/a",
    });
    seedProjectsForTest([saved.project]);
    try {
      const renamed = await saveProjectService({
        id: saved.project.id,
        name: "离线改名",
        nameIsCustom: true,
      });
      expect(renamed.displayName).toEqual("离线改名");
      expect(renamed.folders.map((folder) => folder.path)).toEqual([
        "/missing/a",
      ]);
    } finally {
      resetProjectRegistry();
    }
  });

  test("自定义项目名唯一：忽略大小写与首尾空白", async () => {
    initLocalStorage(path.join(tmp, "names.db"));
    const dirA = path.join(tmp, "names-a");
    const dirB = path.join(tmp, "names-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    await projectSave({
      displayName: "同名",
      folders: [{ path: dirA, isPrimary: true }],
      primaryPath: dirA,
    });
    resetProjectRegistry();
    await initProjects();

    await expect(
      saveProjectService({
        name: " 同名 ",
        folders: [dirB],
        primaryPath: dirB,
      }),
    ).rejects.toThrow(/already exists/);

    const second = await saveProjectService({
      name: "另一个",
      folders: [dirB],
      primaryPath: dirB,
    });
    await expect(
      saveProjectService({
        id: second.id,
        name: "同名",
        folders: [dirB],
        primaryPath: dirB,
      }),
    ).rejects.toThrow(/already exists/);

    await saveProjectService({
      id: second.id,
      name: "Same",
      folders: [dirB],
      primaryPath: dirB,
    });
    await expect(
      saveProjectService({
        name: "same",
        folders: [dirB],
        primaryPath: dirB,
      }),
    ).rejects.toThrow(/already exists/);
    resetProjectRegistry();
  });

  test("留空名称同样不允许与已有显示名重复", async () => {
    initLocalStorage(path.join(tmp, "names-fallback.db"));
    const dirA = path.join(tmp, "dup-a", "proj");
    const dirB = path.join(tmp, "dup-b", "proj");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    // A 不填名称 → 显示名回落主文件夹 basename "proj"
    await projectSave({
      folders: [{ path: dirA, isPrimary: true }],
      primaryPath: dirA,
    });
    resetProjectRegistry();
    await initProjects();

    // B 也留空 → 显示名同为 "proj"，应被拒绝
    await expect(
      saveProjectService({
        folders: [dirB],
        primaryPath: dirB,
      }),
    ).rejects.toThrow(/already exists/);

    // 起一个不同的名字即可
    const ok = await saveProjectService({
      name: "另一个 proj",
      folders: [dirB],
      primaryPath: dirB,
    });
    expect(ok.displayName).toEqual("另一个 proj");
    resetProjectRegistry();
  });
});
