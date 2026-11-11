import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "./db";
import {
  backfillWorkspaceDirsAsProjects,
  initProjectTables,
  migrateLegacyProjects,
  projectDelete,
  projectGet,
  projectList,
  projectPurge,
  projectSave,
  resetProjectsForTest,
} from "./projects-db";

function setupDb(): Db {
  const db = openDb(":memory:");
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
  return db;
}

function seedKv(db: Db, key: string, value: unknown): void {
  db.prepare("INSERT INTO kv(key,value) VALUES(?1,?2)").run(
    key,
    JSON.stringify(value),
  );
}

function insertSession(
  db: Db,
  id: string,
  cwd: string,
  opts: { kind?: string; parent?: string; archived?: number } = {},
): void {
  const stamp = `2026-01-01T00:00:${String(id.length).padStart(2, "0")}.000Z`;
  db.prepare(
    "INSERT INTO sessions(id,cwd,archived,created_at,updated_at,kind,parent_session) VALUES(?1,?2,?3,?4,?4,?5,?6)",
  ).run(id, cwd, opts.archived ?? 0, stamp, opts.kind ?? "", opts.parent ?? "");
}

function projectIdFor(db: Db, sessionId: string): string | null {
  const row = db
    .prepare("SELECT project_id FROM sessions WHERE id=?1")
    .get(sessionId) as { project_id: string | null } | undefined;
  return row?.project_id ?? null;
}

describe("项目实体存储", () => {
  test("旧项目目录 + 会话 cwd 迁移：主目录/附加根/子目录/任务/远程/side_chat", () => {
    const db = setupDb();
    seedKv(db, "pi.projectDirs", {
      "/work/a": [{ path: "/work/b", label: "b" }],
    });
    seedKv(db, "remote.projects", [{ remotePath: "/remote/x" }]);
    insertSession(db, "main", "/work/a/");
    insertSession(db, "root", "/work/b");
    insertSession(db, "sub", "/work/a/sub");
    insertSession(db, "task", "");
    insertSession(db, "remote", "/remote/x");
    insertSession(db, "side", "/work/b", {
      kind: "side_chat",
      parent: "main",
    });

    initProjectTables(db);

    const projects = projectList(db);
    const a = projects.find((p) => p.folders.some((f) => f.path === "/work/a"));
    expect(Boolean(a)).toEqual(true);
    expect(a!.folders.map((f) => f.path)).toEqual(["/work/a", "/work/b"]);
    expect(a!.folders[0]!.isPrimary).toEqual(true);

    // 子目录保持升级前的“精确 cwd 分组”
    const sub = projects.find((p) => p.folders[0]?.path === "/work/a/sub");
    expect(Boolean(sub)).toEqual(true);

    expect(projectIdFor(db, "main")).toEqual(a!.id);
    expect(projectIdFor(db, "root")).toEqual(a!.id);
    expect(projectIdFor(db, "sub")).toEqual(sub!.id);
    expect(projectIdFor(db, "side")).toEqual(a!.id);
    expect(projectIdFor(db, "task")).toEqual(null);
    expect(projectIdFor(db, "remote")).toEqual(null);

    // 旧 kv 保留；marker 落库
    const legacy = db
      .prepare("SELECT value FROM kv WHERE key='pi.projectDirs'")
      .get() as { value: string };
    expect(legacy.value.includes("/work/a")).toEqual(true);
    expect(
      Boolean(
        db
          .prepare("SELECT value FROM kv WHERE key='pi.projects.migrated.v1'")
          .get(),
      ),
    ).toEqual(true);
  });

  test("迁移幂等：重复调用不再建项目", () => {
    const db = setupDb();
    seedKv(db, "pi.projectDirs", { "/work/a": [] });
    insertSession(db, "main", "/work/a");
    initProjectTables(db);
    const before = projectList(db);
    const second = migrateLegacyProjects(db);
    expect(second.migrated).toEqual(false);
    expect(projectList(db)).toEqual(before);
  });

  test("项目保存、重命名、换 primary、共享文件夹", () => {
    const db = setupDb();
    initProjectTables(db);
    const first = projectSave(db, {
      displayName: "项目 A",
      nameIsCustom: true,
      folders: [
        { path: "/shared/x", isPrimary: true },
        { path: "/only/a" },
      ],
      showWhenEmpty: true,
    });
    expect(first.displayName).toEqual("项目 A");
    expect(first.folders[0]!.isPrimary).toEqual(true);

    // 同一 /shared/x 可以再被另一个项目引用
    const second = projectSave(db, {
      folders: [{ path: "/shared/x", isPrimary: true }],
    });
    expect(second.id === first.id).toEqual(false);

    const updated = projectSave(db, {
      id: first.id,
      displayName: null,
      nameIsCustom: false,
      folders: [{ path: "/only/a" }, { path: "/shared/x" }],
      primaryPath: "/only/a",
    });
    expect(updated.displayName).toEqual(null);
    expect(updated.nameIsCustom).toEqual(false);
    expect(updated.folders.find((folder) => folder.isPrimary)?.path).toEqual(
      "/only/a",
    );

    projectDelete(db, second.id);
    expect(projectGet(db, second.id)?.archived).toEqual(true);
    expect(projectList(db).some((p) => p.id === second.id)).toEqual(false);
    expect(projectList(db, true).some((p) => p.id === second.id)).toEqual(true);
  });

  test("共享目录回填优先主目录归属（附加根不抢会话）", () => {
    const db = setupDb();
    // /shared/x 同时是 A 的附加根与 B 的主目录：会话应归 B
    seedKv(db, "pi.projectDirs", {
      "/work/a": [{ path: "/shared/x", label: "x" }],
      "/shared/x": [],
    });
    insertSession(db, "in-shared", "/shared/x");
    insertSession(db, "in-a", "/work/a");

    initProjectTables(db);

    const projects = projectList(db);
    const a = projects.find((p) => p.folders[0]?.path === "/work/a")!;
    const b = projects.find((p) => p.folders[0]?.path === "/shared/x")!;
    expect(projectIdFor(db, "in-shared")).toEqual(b.id);
    expect(projectIdFor(db, "in-a")).toEqual(a.id);
  });

  test("只改名称/外观时 folders 保持不变", () => {
    const db = setupDb();
    initProjectTables(db);
    const project = projectSave(db, {
      folders: [{ path: "/work/a", isPrimary: true }, { path: "/work/b" }],
      showWhenEmpty: true,
    });
    const renamed = projectSave(db, {
      id: project.id,
      displayName: "改名",
      nameIsCustom: true,
      folders: project.folders.map((folder) => ({ path: folder.path })),
      primaryPath: "/work/a",
    });
    expect(renamed.folders.map((folder) => folder.path)).toEqual([
      "/work/a",
      "/work/b",
    ]);
    expect(renamed.displayName).toEqual("改名");
    expect(renamed.showWhenEmpty).toEqual(true);
  });

  test("只改名称/外观不推进 updated_at，目录结构变化才推进", async () => {
    const db = setupDb();
    initProjectTables(db);
    const project = projectSave(db, {
      folders: [{ path: "/work/a", isPrimary: true }],
      showWhenEmpty: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const renamed = projectSave(db, {
      id: project.id,
      displayName: "改名",
      nameIsCustom: true,
      folders: [{ path: "/work/a", isPrimary: true }],
      primaryPath: "/work/a",
    });
    expect(renamed.updatedAt).toEqual(project.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 3));
    const extended = projectSave(db, {
      id: project.id,
      folders: [
        { path: "/work/a", isPrimary: true },
        { path: "/work/b" },
      ],
      primaryPath: "/work/a",
    });
    expect(extended.updatedAt === project.updatedAt).toEqual(false);
  });

  test("彻底删除：项目与 folders 删除，会话行保留", () => {
    const db = setupDb();
    initProjectTables(db);
    insertSession(db, "keep-me", "/work/a");
    const project = projectSave(db, {
      folders: [{ path: "/work/a", isPrimary: true }],
      showWhenEmpty: true,
    });
    db.prepare("UPDATE sessions SET project_id=?1 WHERE id='keep-me'").run(
      project.id,
    );

    projectPurge(db, project.id);

    expect(projectGet(db, project.id)).toEqual(null);
    const folders = db
      .prepare("SELECT count(*) AS n FROM project_folders WHERE project_id=?1")
      .get(project.id) as { n: number };
    expect(folders.n).toEqual(0);
    // host 只删项目；会话解绑由 sidecar 协议层负责
    expect(projectIdFor(db, "keep-me")).toEqual(project.id);
  });

  test("没有旧数据时迁移是空操作但会写 marker", () => {
    const db = setupDb();
    initProjectTables(db);
    expect(projectList(db)).toEqual([]);
    expect(
      Boolean(
        db
          .prepare("SELECT value FROM kv WHERE key='pi.projects.migrated.v1'")
          .get(),
      ),
    ).toEqual(true);
  });

  test("旧工作空间历史（workspace/recents）补成项目；幂等且跳过远程/已有目录", () => {
    const root = mkdtempSync(join(tmpdir(), "kova-backfill-"));
    const current = join(root, "current");
    const recent = join(root, "recent");
    const existing = join(root, "existing");
    const missing = join(root, "missing");
    for (const dir of [current, recent, existing]) mkdirSync(dir, { recursive: true });

    const db = setupDb();
    // 先建项目表（此时还没有 workspace kv，补迁为空）
    initProjectTables(db);
    // 已有项目占用 existing；remote 路径不建本地项目
    projectSave(db, {
      folders: [{ path: existing, isPrimary: true }],
      primaryPath: existing,
      showWhenEmpty: true,
    });
    // `workspace` kv 存的是裸路径字符串（非 JSON），与 workspace-store 一致
    db.prepare("INSERT INTO kv(key,value) VALUES(?1,?2)").run(
      "workspace",
      current,
    );
    seedKv(db, "workspace.recents", [recent, existing, missing, "/remote/x"]);
    seedKv(db, "remote.projects", [{ remotePath: "/remote/x" }]);

    const created = backfillWorkspaceDirsAsProjects(db);
    expect(created).toEqual(2);
    const projects = projectList(db, true);
    const dirs = new Set(
      projects.flatMap((project) => project.folders.map((folder) => folder.path)),
    );
    expect(dirs.has(current)).toEqual(true);
    expect(dirs.has(recent)).toEqual(true);
    expect(dirs.has(existing)).toEqual(true);
    expect(dirs.has(missing)).toEqual(false);
    expect(dirs.has("/remote/x")).toEqual(false);
    // show_when_empty = 1：空项目卡也要出现
    const recentProject = projects.find((project) =>
      project.folders.some((folder) => folder.path === recent),
    );
    expect(recentProject?.showWhenEmpty).toEqual(true);
    // 幂等：再跑不重复建
    expect(backfillWorkspaceDirsAsProjects(db)).toEqual(0);
    expect(projectList(db, true).length).toEqual(3);
  });

  test("reset 只清项目与 marker，不动旧 kv/sessions", () => {
    const db = setupDb();
    seedKv(db, "pi.projectDirs", { "/work/a": [] });
    insertSession(db, "main", "/work/a");
    initProjectTables(db);
    resetProjectsForTest(db);
    expect(projectList(db)).toEqual([]);
    expect(
      Boolean(db.prepare("SELECT value FROM kv WHERE key='pi.projectDirs'").get()),
    ).toEqual(true);
    expect(Boolean(projectIdFor(db, "main"))).toEqual(true);
  });
});
