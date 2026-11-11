/**
 * 项目实体存储（Host SQLite）。
 *
 * 与旧 `pi.projectDirs` 路径 map 的区别：
 * - 项目有稳定 id，会话用 sessions.project_id 绑定，不再靠 cwd 猜；
 * - project_folders.path 没有全局唯一约束，同一文件夹可被多个项目引用；
 * - 名称/外观是项目字段，不再放渲染层 localStorage。
 *
 * 本模块不依赖 Electron，便于在内存库里做迁移/查询单测。
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Db } from "./db";

export type ProjectFolder = {
  path: string;
  sortOrder: number;
  isPrimary: boolean;
};

export type ProjectRecord = {
  id: string;
  displayName: string | null;
  nameIsCustom: boolean;
  appearanceJson: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  showWhenEmpty: boolean;
  /** 侧栏已移除（仅隐藏项目卡；设置页仍可见、可恢复显示） */
  hiddenFromSidebar: boolean;
  folders: ProjectFolder[];
};

export type ProjectFolderInput = {
  path: string;
  isPrimary?: boolean;
};

export type SaveProjectInput = {
  id?: string;
  displayName?: string | null;
  nameIsCustom?: boolean;
  appearanceJson?: string | null;
  archived?: boolean;
  showWhenEmpty?: boolean;
  hiddenFromSidebar?: boolean;
  folders: ProjectFolderInput[];
  primaryPath?: string;
};

const MIGRATION_KV = "pi.projects.migrated.v1";

function nowIso(): string {
  return new Date().toISOString();
}

/** 迁移用路径收口：去首尾空白与尾部重复分隔符；不做 realpath（Host 无权限语义） */
function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z]:[\\/]+$/u.test(trimmed)) return `${trimmed.slice(0, 2)}\\`;
  if (/^[\\/]+$/u.test(trimmed)) return trimmed[0]!;
  return trimmed.replace(/[\\/]+$/u, "");
}

function kvGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?1").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function kvSet(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 迁移比较键：realpath 收口大小写/符号链接（路径不存在时退回字符串） */
function migratePathKey(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  try {
    return normalizePath(realpathSync(normalized));
  } catch {
    return normalized;
  }
}

function folderRows(db: Db): Map<string, ProjectFolder[]> {
  const rows = db
    .prepare(
      "SELECT project_id, path, sort_order, is_primary FROM project_folders ORDER BY sort_order, path",
    )
    .all() as {
    project_id: string;
    path: string;
    sort_order: number;
    is_primary: number;
  }[];
  const map = new Map<string, ProjectFolder[]>();
  for (const row of rows) {
    const list = map.get(row.project_id) ?? [];
    list.push({
      path: row.path,
      sortOrder: Number(row.sort_order),
      isPrimary: row.is_primary === 1,
    });
    map.set(row.project_id, list);
  }
  return map;
}

/** 建表/加列；必须在 kv 表创建之后调用（迁移会读写 kv） */
export function initProjectTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      name_is_custom INTEGER NOT NULL DEFAULT 0,
      appearance_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      show_when_empty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS project_folders (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id, path)
    );
    CREATE INDEX IF NOT EXISTS project_folders_project
      ON project_folders(project_id, sort_order);
  `);
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT;");
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id);");
  } catch {
    /* ignore */
  }
  // 侧栏移除（只隐藏项目卡）：与归档不同，项目仍在设置页可恢复显示
  try {
    db.exec(
      "ALTER TABLE projects ADD COLUMN hidden_from_sidebar INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    /* 列已存在 */
  }
  migrateLegacyProjects(db);
  backfillWorkspaceDirsAsProjects(db);
}

export function projectList(db: Db, includeArchived = false): ProjectRecord[] {
  const folders = folderRows(db);
  const rows = db
    .prepare(
      `SELECT * FROM projects ${includeArchived ? "" : "WHERE archived=0"}
       ORDER BY archived, updated_at DESC, id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    displayName: row.display_name == null ? null : String(row.display_name),
    nameIsCustom: row.name_is_custom === 1,
    appearanceJson:
      row.appearance_json == null ? null : String(row.appearance_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archived: row.archived === 1,
    showWhenEmpty: row.show_when_empty === 1,
    hiddenFromSidebar: row.hidden_from_sidebar === 1,
    folders: folders.get(String(row.id)) ?? [],
  }));
}

export function projectGet(db: Db, id: string): ProjectRecord | null {
  return projectList(db, true).find((project) => project.id === id) ?? null;
}

function normalizeFolders(
  folders: ProjectFolderInput[],
  primaryPath: string | undefined,
): { path: string; isPrimary: boolean }[] {
  const seen = new Set<string>();
  const out: { path: string; isPrimary: boolean }[] = [];
  for (const folder of folders) {
    const path = normalizePath(folder.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, isPrimary: folder.isPrimary === true });
  }
  if (out.length === 0) throw new Error("project.folder-required");
  const explicitPrimary = normalizePath(primaryPath);
  let primary =
    (explicitPrimary && out.find((folder) => folder.path === explicitPrimary)
      ? explicitPrimary
      : undefined) ??
    out.find((folder) => folder.isPrimary)?.path ??
    out[0]!.path;
  return out.map((folder) => ({
    path: folder.path,
    isPrimary: folder.path === primary,
  }));
}

/** 创建/覆盖项目。folders 至少一个，primary 必须落在 folders 内。 */
export function projectSave(db: Db, input: SaveProjectInput): ProjectRecord {
  const folders = normalizeFolders(input.folders, input.primaryPath);
  const id = input.id ?? randomUUID();
  const existing = input.id ? projectGet(db, input.id) : null;
  const now = nowIso();
  const displayName =
    input.displayName === undefined
      ? (existing?.displayName ?? null)
      : (input.displayName?.trim() || null);
  const nameIsCustom =
    input.nameIsCustom ??
    (input.displayName === undefined
      ? (existing?.nameIsCustom ?? false)
      : Boolean(displayName));
  const appearanceJson =
    input.appearanceJson === undefined
      ? (existing?.appearanceJson ?? null)
      : input.appearanceJson;
  const archived = input.archived ?? existing?.archived ?? false;
  const showWhenEmpty =
    input.showWhenEmpty ?? existing?.showWhenEmpty ?? false;
  const hiddenFromSidebar =
    input.hiddenFromSidebar ?? existing?.hiddenFromSidebar ?? false;
  // 改名/换图标/换颜色不推进 updated_at：空项目分组按 updatedAt 排序，
  // 外观微调不应让侧栏卡片换位。只有目录结构/归档状态变化才刷新时间。
  const foldersEqual =
    existing != null &&
    existing.folders.length === folders.length &&
    existing.folders.every(
      (folder, index) =>
        folder.path === folders[index]!.path &&
        folder.isPrimary === folders[index]!.isPrimary,
    );
  const updatedAt =
    existing &&
    foldersEqual &&
    existing.archived === archived &&
    existing.showWhenEmpty === showWhenEmpty &&
    existing.hiddenFromSidebar === hiddenFromSidebar
      ? existing.updatedAt
      : now;

  return db.transaction(() => {
    db.prepare(
      `INSERT INTO projects(id,display_name,name_is_custom,appearance_json,created_at,updated_at,archived,show_when_empty,hidden_from_sidebar)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name,
         name_is_custom=excluded.name_is_custom,
         appearance_json=excluded.appearance_json,
         updated_at=excluded.updated_at,
         archived=excluded.archived,
         show_when_empty=excluded.show_when_empty,
         hidden_from_sidebar=excluded.hidden_from_sidebar`,
    ).run(
      id,
      displayName,
      nameIsCustom ? 1 : 0,
      appearanceJson,
      existing?.createdAt ?? now,
      updatedAt,
      archived ? 1 : 0,
      showWhenEmpty ? 1 : 0,
      hiddenFromSidebar ? 1 : 0,
    );
    db.prepare("DELETE FROM project_folders WHERE project_id=?1").run(id);
    folders.forEach((folder, index) => {
      db.prepare(
        "INSERT INTO project_folders(project_id,path,sort_order,is_primary) VALUES(?1,?2,?3,?4)",
      ).run(id, folder.path, index, folder.isPrimary ? 1 : 0);
    });
    return projectGet(db, id)!;
  });
}

export function projectDelete(db: Db, id: string): void {
  db.prepare(
    "UPDATE projects SET archived=1, updated_at=?1 WHERE id=?2",
  ).run(nowIso(), id);
}

/** 彻底删除项目实体与 folders（会话历史保留，调用方负责解绑 project_id） */
export function projectPurge(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM project_folders WHERE project_id=?1").run(id);
    db.prepare("DELETE FROM projects WHERE id=?1").run(id);
  });
}

export function projectSetSession(
  db: Db,
  sessionId: string,
  projectId: string | null,
): void {
  db.prepare("UPDATE sessions SET project_id=?1 WHERE id=?2").run(
    projectId,
    sessionId,
  );
}

/**
 * 幂等补迁：旧工作空间历史（kv `workspace` 当前值 + `workspace.recents`）里
 * 还没被任何项目占用的目录 → 补成项目。用户要求“原先的文件夹全部变成项目
 * 空间”，这些目录没有会话/旧 projectDirs 记录，v1 迁移覆盖不到；每次启动
 * 跑一遍，已存在的目录不重复建。
 *
 * 只收真实存在且是目录的本地路径；远程项目路径不建本地项目。
 */
export function backfillWorkspaceDirsAsProjects(db: Db): number {
  const known = new Set<string>();
  for (const row of db
    .prepare("SELECT path FROM project_folders")
    .all() as { path: string }[]) {
    const key = migratePathKey(row.path);
    if (key) known.add(key);
  }
  if (known.size === 0 && !kvGet(db, "workspace") && !kvGet(db, "workspace.recents")) {
    return 0;
  }
  const remotePaths = new Set<string>();
  const remote = parseJson(kvGet(db, "remote.projects"));
  if (Array.isArray(remote)) {
    for (const entry of remote as { remotePath?: unknown }[]) {
      const key = migratePathKey(
        typeof entry?.remotePath === "string" ? entry.remotePath : "",
      );
      if (key) remotePaths.add(key);
    }
  }
  const candidates: string[] = [];
  const current = normalizePath(kvGet(db, "workspace"));
  if (current) candidates.push(current);
  const recents = parseJson(kvGet(db, "workspace.recents"));
  if (Array.isArray(recents)) {
    for (const value of recents) {
      if (typeof value === "string") {
        const dir = normalizePath(value);
        if (dir) candidates.push(dir);
      }
    }
  }
  let created = 0;
  const now = nowIso();
  db.transaction(() => {
    // v1 迁移建的项目 show_when_empty=0；现在口径是“旧文件夹都作为工作空间
    // 出现”，空项目卡也要可见（新建弹窗创建的项目本来就是 1）。
    db.prepare(
      "UPDATE projects SET show_when_empty=1 WHERE show_when_empty=0",
    ).run();
    for (const dir of candidates) {
      const key = migratePathKey(dir);
      if (!key || known.has(key) || remotePaths.has(key)) continue;
      // 只迁移真实存在的目录；被删/移走的旧历史不建空卡
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      known.add(key);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO projects(id,display_name,name_is_custom,appearance_json,created_at,updated_at,archived,show_when_empty,hidden_from_sidebar)
         VALUES(?1,NULL,0,NULL,?2,?2,0,1,0)`,
      ).run(id, now);
      db.prepare(
        "INSERT INTO project_folders(project_id,path,sort_order,is_primary) VALUES(?1,?2,0,1)",
      ).run(id, dir);
      created += 1;
    }
  });
  return created;
}

/** 旧路径 map → 项目实体；只做一次，事务 + marker。 */
export function migrateLegacyProjects(db: Db): {
  migrated: boolean;
  projects: number;
  sessions: number;
} {
  if (kvGet(db, MIGRATION_KV)) {
    return { migrated: false, projects: 0, sessions: 0 };
  }
  // 已有项目数据（人工/新版本提前写入）视为已迁移，补 marker 防止重复建。
  const existingCount = Number(
    (db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number })
      .n,
  );
  if (existingCount > 0) {
    kvSet(
      db,
      MIGRATION_KV,
      JSON.stringify({ version: 1, at: nowIso(), skipped: true }),
    );
    return { migrated: false, projects: 0, sessions: 0 };
  }

  const legacy = parseJson(kvGet(db, "pi.projectDirs")) as Record<
    string,
    { path?: string }[]
  > | null;
  const remoteProjects = parseJson(kvGet(db, "remote.projects")) as
    | { remotePath?: string }[]
    | null;
  const remotePaths = new Set(
    (Array.isArray(remoteProjects) ? remoteProjects : [])
      .map((entry) => migratePathKey(entry?.remotePath ?? ""))
      .filter(Boolean),
  );
  const sessions = db
    .prepare(
      "SELECT id, cwd, kind, parent_session FROM sessions ORDER BY created_at, id",
    )
    .all() as {
    id: string;
    cwd: string;
    kind: string;
    parent_session: string;
  }[];

  type Spec = {
    primary: string;
    folders: string[];
    displayName: null;
    custom: false;
  };
  const specs: Spec[] = [];
  const claimed = new Set<string>();

  const addSpec = (primary: string, folders: string[]) => {
    const main = normalizePath(primary);
    if (!main) return;
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of [main, ...folders.map(normalizePath)]) {
      if (!raw) continue;
      const key = migratePathKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(raw);
      claimed.add(key);
    }
    specs.push({ primary: main, folders: unique, displayName: null, custom: false });
  };

  // 1) 旧 projectDirs：主目录 + 附加根
  for (const [main, dirs] of Object.entries(legacy ?? {})) {
    const primary = normalizePath(main);
    if (!primary) continue;
    const folders = [primary, ...(Array.isArray(dirs) ? dirs.map((d) => normalizePath(d?.path)) : [])];
    addSpec(primary, folders);
  }

  // 2) 会话 cwd（含子目录、主目录项目）：不在旧 folders 中→独立项目，
  //    保持升级前“精确 cwd 分组”的侧栏表现。
  for (const session of sessions) {
    const cwd = normalizePath(session.cwd);
    const key = migratePathKey(cwd);
    if (!cwd || remotePaths.has(key) || claimed.has(key)) continue;
    addSpec(cwd, [cwd]);
    claimed.add(key);
  }

  // 3) 写项目/目录
  const now = nowIso();
  /** 主目录 → 项目、附加目录 → 项目：共享路径两边都可能命中，
   *  会话回填优先主目录（旧数据里“主目录项目”是会话真正的家）。 */
  const primaryToProject = new Map<string, string>();
  const folderToProject = new Map<string, string>();
  let backfilledSessions = 0;
  db.transaction(() => {
    for (const spec of specs) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO projects(id,display_name,name_is_custom,appearance_json,created_at,updated_at,archived,show_when_empty)
         VALUES(?1,NULL,0,NULL,?2,?2,0,0)`,
      ).run(id, now);
      spec.folders.forEach((path, index) => {
        db.prepare(
          "INSERT INTO project_folders(project_id,path,sort_order,is_primary) VALUES(?1,?2,?3,?4)",
        ).run(id, path, index, index === 0 ? 1 : 0);
        const key = migratePathKey(path);
        if (index === 0) primaryToProject.set(key, id);
        else if (!folderToProject.has(key)) folderToProject.set(key, id);
      });
    }
    // 4) 会话回填：side_chat 先继承父会话；其余按 cwd（主目录优先）
    const projectBySession = new Map<string, string>();
    for (const session of sessions) {
      if (session.kind === "side_chat" && session.parent_session) {
        const parent = projectBySession.get(session.parent_session);
        if (parent) {
          projectBySession.set(session.id, parent);
          continue;
        }
      }
      const cwd = normalizePath(session.cwd);
      const key = migratePathKey(cwd);
      if (!cwd || remotePaths.has(key)) continue;
      const projectId = primaryToProject.get(key) ?? folderToProject.get(key);
      if (projectId) projectBySession.set(session.id, projectId);
    }
    for (const [sessionId, projectId] of projectBySession) {
      db.prepare("UPDATE sessions SET project_id=?1 WHERE id=?2").run(
        projectId,
        sessionId,
      );
      backfilledSessions += 1;
    }
    kvSet(
      db,
      MIGRATION_KV,
      JSON.stringify({
        version: 1,
        at: now,
        projects: specs.length,
        sessions: projectBySession.size,
      }),
    );
  });

  return {
    migrated: true,
    projects: specs.length,
    sessions: backfilledSessions,
  };
}

/** 测试缝：清掉 marker 与项目表（用例之间隔离） */
export function resetProjectsForTest(db: Db): void {
  db.exec("DELETE FROM project_folders; DELETE FROM projects;");
  db.prepare("DELETE FROM kv WHERE key=?1").run(MIGRATION_KV);
}

/** 从主文件夹名派生显示名（UI/sidecar 共用；host 只存显式名称） */
export function derivedProjectName(project: ProjectRecord): string {
  const primary = project.folders.find((folder) => folder.isPrimary)?.path;
  return project.displayName?.trim() || (primary ? basename(primary) : "项目");
}
