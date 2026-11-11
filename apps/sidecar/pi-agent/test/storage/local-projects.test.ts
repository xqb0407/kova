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
  backfillLocalWorkspaceDirs,
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
    // 重名校验需要换一个未占用的主目录，否则会先命中主目录唯一校验
    const dirC = path.join(tmp, "names-c");
    mkdirSync(dirC, { recursive: true });
    await expect(
      saveProjectService({
        name: "same",
        folders: [dirC],
        primaryPath: dirC,
      }),
    ).rejects.toThrow(/already exists/);
    resetProjectRegistry();
  });

  test("旧工作空间历史（workspace/recents）补成项目：幂等、跳过远程/缺失", async () => {
    initLocalStorage(path.join(tmp, "recents-backfill.db"));
    const db = getLocalDb()!;
    const current = path.join(tmp, "hist-current");
    const recent = path.join(tmp, "hist-recent");
    const existing = path.join(tmp, "hist-existing");
    mkdirSync(current, { recursive: true });
    mkdirSync(recent, { recursive: true });
    mkdirSync(existing, { recursive: true });
    db.query(
      "INSERT INTO projects(id,display_name,name_is_custom,appearance_json,created_at,updated_at,archived,show_when_empty,hidden_from_sidebar) VALUES(?,NULL,0,NULL,?,?,0,1,0)",
    ).run("existing-id", new Date().toISOString(), new Date().toISOString());
    db.query(
      "INSERT INTO project_folders(project_id,path,sort_order,is_primary) VALUES(?,?,0,1)",
    ).run("existing-id", existing);
    db.query("INSERT INTO kv(key,value) VALUES(?,?)").run("workspace", current);
    db.query("INSERT INTO kv(key,value) VALUES(?,?)").run(
      "workspace.recents",
      JSON.stringify([
        recent,
        existing,
        path.join(tmp, "hist-missing"),
        "/remote/hist",
      ]),
    );
    db.query("INSERT INTO kv(key,value) VALUES(?,?)").run(
      "remote.projects",
      JSON.stringify([{ remotePath: "/remote/hist" }]),
    );
    backfillLocalWorkspaceDirs(db);
    const projects = (await projectList(true)).projects;
    const dirs = new Set(
      projects.flatMap((project) => project.folders.map((f) => f.path)),
    );
    expect(dirs.has(current)).toEqual(true);
    expect(dirs.has(recent)).toEqual(true);
    expect(dirs.has(existing)).toEqual(true);
    expect(dirs.has(path.join(tmp, "hist-missing"))).toEqual(false);
    expect(dirs.has("/remote/hist")).toEqual(false);
    // 幂等
    const before = projects.length;
    backfillLocalWorkspaceDirs(db);
    expect((await projectList(true)).projects.length).toEqual(before);
    resetStorageForTest();
  });

  test("主目录唯一：同主目录拒绝（含归档占用）；可作他人附加目录", async () => {
    initLocalStorage(path.join(tmp, "primary-unique.db"));
    const mainA = path.join(tmp, "primary-a");
    const mainB = path.join(tmp, "primary-b");
    const shared = path.join(tmp, "primary-shared");
    mkdirSync(mainA, { recursive: true });
    mkdirSync(mainB, { recursive: true });
    mkdirSync(shared, { recursive: true });

    await projectSave({
      displayName: "A",
      folders: [
        { path: mainA, isPrimary: true },
        { path: shared, isPrimary: false },
      ],
      primaryPath: mainA,
    });
    resetProjectRegistry();
    await initProjects();

    // B 主目录 = A 主目录 → 直接禁止（错误里带占用方名称，供前端提示）
    await expect(
      saveProjectService({
        name: "B",
        folders: [mainA],
        primaryPath: mainA,
      }),
    ).rejects.toThrow(/already used by workspace "A"/);

    // B 主目录 = 自己的新目录，附加目录 = A 的主目录 → 允许（反向共享）
    const b = await saveProjectService({
      name: "B",
      folders: [mainB, mainA],
      primaryPath: mainB,
    });
    expect(b.displayName).toEqual("B");

    // 附加目录共享（C 附加 = A 的附加）→ 仍然允许
    const mainC = path.join(tmp, "primary-c");
    mkdirSync(mainC, { recursive: true });
    const c = await saveProjectService({
      name: "C",
      folders: [mainC, shared],
      primaryPath: mainC,
    });
    expect(c.displayName).toEqual("C");

    // 归档 A 后主目录仍占位：恢复前不能再建同主目录项目
    await projectDelete((await projectList(true)).projects.find(
      (project) => project.displayName === "A",
    )!.id);
    await expect(
      saveProjectService({
        name: "D",
        folders: [mainA],
        primaryPath: mainA,
      }),
    ).rejects.toThrow(/already used by workspace "A"/);
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
