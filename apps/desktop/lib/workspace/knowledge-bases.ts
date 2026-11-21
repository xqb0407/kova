"use client";

/**
 * 知识库（KB）实体层：**知识库是一等实体**——{ 名称, 生效范围: 用户|工作区,
 * 绑定工作区 }，一个工作空间可有多个知识库；「全局」= 用户级（全部工作区生效）。
 *
 * 清单（manifest）是事实源：库根下 `.knowledge-bases.json`（点文件不进
 * library_scan），渲染层经 fs_* 命令直接读写——库根本就是可信根，不必新增
 * 主进程命令；watcher 对清单写入也会广播 library:changed，页面据此刷新。
 * KB 的内容就是清单里 folder 指向的文件夹：
 * - 用户级 = `知识库/<KB名>/`
 * - 工作区级 = `项目/<工作区目录名>/<KB名>/`
 * 文件夹名 = 名称净化 + 同级去重（加序号）；重命名 = 同目录改名 + 改清单。
 *
 * 旧内容不迁移不展示：清单从空开始，旧散文件只留在磁盘上。
 */

import { t } from "@/lib/i18n";
import { isDesktop } from "@/lib/desktop-env";
import {
  libraryFileMetaDelete,
  libraryFileMetaMove,
} from "./library-note-meta";
import { projectFolderFor } from "./project-folders";
import { knowledgeRefsRepath } from "./library-files";

// fs 命令全部走**函数内动态引入**：部分测试（如 canvas-doc-list.test）用
// mock.module 把 ./fs 换成只含自己所需导出的部分 mock，bun 的 mock 是
// 全局注册表——静态 import 会在测试装载期因缺导出直接 SyntaxError；
// 动态引入把这一风险推迟到真正调用时（测试不触发这些调用）。
type FsModule = typeof import("./fs");

async function fs(): Promise<FsModule> {
  return import("./fs");
}

/** 清单文件（库根相对） */
export const KB_MANIFEST_REL = ".knowledge-bases.json";

/** 用户级 KB 的父目录（库根相对） */
export const USER_KB_ROOT = "知识库";

/** 工作区级 KB 的父目录前缀（库根相对；与划词笔记落点同一层） */
export const WORKSPACE_KB_ROOT = "项目";

export type KnowledgeBaseScope = "user" | "workspace";

export interface KnowledgeBase {
  id: string;
  name: string;
  /** 库根相对的 KB 内容文件夹（POSIX 分隔） */
  folder: string;
  scope: KnowledgeBaseScope;
  /** scope=workspace：落盘用的工作区目录名（primary basename） */
  workspaceDir?: string;
  /** scope=workspace：绑定的工作区项目 id（展示/筛选用） */
  workspaceIds: string[];
  /** 工作区默认知识库（划词落点，懒创建）/ 用户级收件箱 */
  default?: boolean;
  createdAt: string;
}

export interface KbManifest {
  version: 1;
  kbs: KnowledgeBase[];
}

const EMPTY_MANIFEST: KbManifest = { version: 1, kbs: [] };

const SCOPES: KnowledgeBaseScope[] = ["user", "workspace"];

/* ------------------------------ 纯函数（单测覆盖） ------------------------------ */

/** 清单解析：缺失/损坏回退空清单；非法条目逐条丢弃 */
export function parseManifest(raw: string | null | undefined): KbManifest {
  if (!raw) return EMPTY_MANIFEST;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_MANIFEST;
  }
  const kbs = (data as { kbs?: unknown } | null)?.kbs;
  if (!Array.isArray(kbs)) return EMPTY_MANIFEST;
  const out: KnowledgeBase[] = [];
  for (const raw of kbs) {
    if (!raw || typeof raw !== "object") continue;
    const kb = raw as Partial<KnowledgeBase>;
    if (
      typeof kb.id !== "string" ||
      typeof kb.name !== "string" ||
      typeof kb.folder !== "string" ||
      kb.folder.length === 0 ||
      !SCOPES.includes(kb.scope as KnowledgeBaseScope)
    ) {
      continue;
    }
    out.push({
      id: kb.id,
      name: kb.name,
      folder: kb.folder,
      scope: kb.scope as KnowledgeBaseScope,
      ...(typeof kb.workspaceDir === "string" && kb.workspaceDir
        ? { workspaceDir: kb.workspaceDir }
        : {}),
      // 手改/旧版清单可能缺字段：归一成数组，消费方（对账/筛选）不必再判空
      workspaceIds: Array.isArray(kb.workspaceIds)
        ? kb.workspaceIds.filter((id): id is string => typeof id === "string")
        : [],
      ...(kb.default === true ? { default: true } : {}),
      createdAt:
        typeof kb.createdAt === "string" ? kb.createdAt : new Date(0).toISOString(),
    });
  }
  return { version: 1, kbs: out };
}

/** 名称 → 文件夹段：非法字符替换、空白折叠、去掉开头的点（点目录会被
 *  library_scan 当隐藏项跳过，KB 内容就"看不见"了） */
export function sanitizeKbName(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return safe || t("library.kb.untitled");
}

/** 同级去重命名：name、name 2、name 3…（existing 含兄弟文件夹的磁盘名）。
 *  Windows 文件系统大小写不敏感：比较按小写折叠，否则「手册」与「手册 」之外
 *  仅大小写不同的名字会在 mkdir/rename 时撞 already-exists。 */
export function uniqueFolderName(existing: Iterable<string>, name: string): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const probe = name.toLowerCase();
  if (!taken.has(probe)) return name;
  // 输入已带序号（「docs 2」撞「DOCS 2」）：从下一个数续号，别产出「docs 2 2」
  const numbered = /^(.*?)\s+(\d+)$/u.exec(name);
  const base = numbered?.[1] ?? name;
  const start = numbered ? Number(numbered[2]) + 1 : 2;
  for (let i = start; ; i += 1) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** KB 父目录（库根相对）：用户级 = 知识库，工作区级 = 项目/<工作区目录名> */
export function kbParentDir(kb: Pick<KnowledgeBase, "scope" | "workspaceDir">): string {
  if (kb.scope === "workspace" && kb.workspaceDir) {
    return `${WORKSPACE_KB_ROOT}/${kb.workspaceDir}`;
  }
  return USER_KB_ROOT;
}

export interface NoteTarget {
  /** 笔记落点的 KB 文件夹（库根相对）；missing 非空时为 null */
  folder: string | null;
  /** 命中的 KB id（命中时） */
  kbId: string | null;
  /** 需要懒创建的默认 KB 类型（未命中时） */
  missing: "workspace-default" | "user-inbox" | null;
}

/** 划词笔记落点：工作区默认 KB（scope=workspace && default && 同工作区目录名）；
 *  无工作区 → 用户级默认 KB（收件箱）。纯函数，懒创建由调用方执行。 */
export function pickNoteTarget(
  kbs: readonly KnowledgeBase[],
  workspaceDir: string | null | undefined,
): NoteTarget {
  if (workspaceDir) {
    const hit = kbs.find(
      (kb) => kb.scope === "workspace" && kb.default && kb.workspaceDir === workspaceDir,
    );
    if (hit) return { folder: hit.folder, kbId: hit.id, missing: null };
    return { folder: null, kbId: null, missing: "workspace-default" };
  }
  const inbox = kbs.find((kb) => kb.scope === "user" && kb.default);
  if (inbox) return { folder: inbox.folder, kbId: inbox.id, missing: null };
  return { folder: null, kbId: null, missing: "user-inbox" };
}

/* ------------------------------ 异步 API ------------------------------ */

async function readManifest(root: string): Promise<KbManifest> {
  const { fsReadFile } = await fs();
  const file = await fsReadFile(root, KB_MANIFEST_REL);
  return parseManifest(file && !file.binary ? file.content : null);
}

async function writeManifest(root: string, manifest: KbManifest): Promise<null> {
  const { fsWriteFile } = await fs();
  const err = await fsWriteFile(
    root,
    KB_MANIFEST_REL,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (err) throw new Error(err);
  return null;
}

/** 清单写入串行化：read-modify-write 段整体排队，避免并发创建/划词丢写。
 *  （只在进程内串行；多窗口写清单的情况本应用不存在） */
let manifestQueue: Promise<unknown> = Promise.resolve();
function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = manifestQueue.then(fn, fn);
  manifestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 文件夹去重后展示名同步加序号（否则列表里出现两个同名 KB，分不清谁是谁）。
 *  导出供单测。 */
export function displayNameFor(name: string, base: string, folderName: string): string {
  return folderName === base ? name : `${name}${folderName.slice(base.length)}`;
}

/** 清单里的全部知识库（损坏回退空，不抛） */
export async function listKnowledgeBases(root: string): Promise<KnowledgeBase[]> {
  if (!root || !isDesktop()) return [];
  return (await readManifest(root)).kbs;
}

function newKbId(): string {
  return `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建知识库（调用方必须已持有清单锁） */
async function createKbLocked(
  root: string,
  opts: {
    name: string;
    scope: KnowledgeBaseScope;
    /** scope=workspace 必填：落盘用工作区目录名 */
    workspaceDir?: string;
    /** scope=workspace：绑定的项目 id */
    workspaceId?: string;
    /** 默认 KB 标记（划词懒创建用） */
    default?: boolean;
  },
): Promise<KnowledgeBase> {
  const { fsListDir, fsMkdir } = await fs();
  const parent = kbParentDir(opts);
  const name = opts.name.trim() || t("library.kb.untitled");
  const siblings =
    (await fsListDir(root, parent))?.entries.map((e) => e.name) ?? [];
  const base = sanitizeKbName(name);
  const folderName = uniqueFolderName(siblings, base);
  // 目录去重加了序号时，展示名跟着加同一序号（两个「工程手册」无从区分）
  const displayName = displayNameFor(name, base, folderName);
  const folder = `${parent}/${folderName}`;
  const mkdirErr = await fsMkdir(root, folder);
  if (mkdirErr) throw new Error(mkdirErr);
  const manifest = await readManifest(root);
  const kb: KnowledgeBase = {
    id: newKbId(),
    name: displayName,
    folder,
    scope: opts.scope,
    workspaceIds: [],
    createdAt: new Date().toISOString(),
  };
  if (opts.scope === "workspace" && opts.workspaceDir) {
    kb.workspaceDir = opts.workspaceDir;
    if (opts.workspaceId) kb.workspaceIds = [opts.workspaceId];
  }
  if (opts.default) kb.default = true;
  manifest.kbs.push(kb);
  try {
    await writeManifest(root, manifest);
  } catch (err) {
    // 清单没落盘就别留一个孤儿空目录（否则下次同名创建会变成「X 2」）
    const { fsDelete } = await fs();
    await fsDelete(root, folder).catch(() => {});
    throw err;
  }
  return kb;
}

/** 创建知识库：建内容文件夹（父目录一并创建）+ 写清单。
 *  文件夹名取净化后的名称，同级重名自动加序号（展示名同步加序号）。 */
export function createKnowledgeBase(
  root: string,
  opts: Parameters<typeof createKbLocked>[1],
): Promise<KnowledgeBase> {
  return withManifestLock(() => createKbLocked(root, opts));
}

/** 重命名知识库：同目录改名文件夹 + 迁移文件元数据（标签/标题按前缀跟随）
 *  + 改清单（default 标记保持）。调用方必须已持有清单锁。 */
async function renameKbLocked(
  root: string,
  kb: KnowledgeBase,
  newName: string,
): Promise<KnowledgeBase> {
  const { fsListDir, fsRename } = await fs();
  const name = newName.trim() || kb.name;
  const parent = kbParentDir(kb);
  const siblings =
    (await fsListDir(root, parent))?.entries.map((e) => e.name) ?? [];
  const oldFolderName = kb.folder.slice(kb.folder.lastIndexOf("/") + 1);
  const base = sanitizeKbName(name);
  const folderName = uniqueFolderName(
    siblings.filter((n) => n !== oldFolderName),
    base,
  );
  const displayName = displayNameFor(name, base, folderName);
  // 净化后与现名相同（只改空白/大小写等）：没有盘面改动，只改清单显示名。
  // 直接 fsRename 到同名会因目标存在而报 already-exists。
  if (folderName === oldFolderName) {
    const manifest = await readManifest(root);
    const entry = manifest.kbs.find((row) => row.id === kb.id);
    const next: KnowledgeBase = { ...kb, name: displayName };
    if (entry) Object.assign(entry, next);
    await writeManifest(root, manifest);
    return next;
  }
  const renameErr = await fsRename(root, kb.folder, folderName);
  if (renameErr) throw new Error(renameErr);
  const next: KnowledgeBase = {
    ...kb,
    name: displayName,
    folder: `${parent}/${folderName}`,
  };
  // 元数据按 (root, rel) 存：文件夹改名后整棵子树的 rel 前缀迁移
  await libraryFileMetaMove(root, kb.folder, next.folder, true).catch(() => {});
  // 历史使用统计（sidecar kb_read 落库的 path）跟着前缀走
  await knowledgeRefsRepath({
    source: "library",
    scopeId: root,
    from: kb.folder,
    to: next.folder,
  }).catch(() => {});
  const manifest = await readManifest(root);
  const entry = manifest.kbs.find((row) => row.id === kb.id);
  if (entry) Object.assign(entry, next);
  await writeManifest(root, manifest);
  return next;
}

/** 重命名知识库（对外入口：持锁执行） */
export function renameKnowledgeBase(
  root: string,
  kb: KnowledgeBase,
  newName: string,
): Promise<KnowledgeBase> {
  return withManifestLock(() => renameKbLocked(root, kb, newName));
}

/** 删除知识库：连同盘内内容文件夹（永久）+ 清理元数据 + 移除清单条目。
 *  文件夹已被外部删除（Finder/同步盘）不算失败——清单条目照样要摘掉。 */
async function deleteKbLocked(root: string, kb: KnowledgeBase): Promise<null> {
  const { fsDelete } = await fs();
  const delErr = await fsDelete(root, kb.folder);
  if (delErr && delErr !== "not-found") throw new Error(delErr);
  await libraryFileMetaDelete(root, [kb.folder], true).catch(() => {});
  const manifest = await readManifest(root);
  manifest.kbs = manifest.kbs.filter((row) => row.id !== kb.id);
  await writeManifest(root, manifest);
  return null;
}

/** 删除知识库（对外入口：持锁执行） */
export function deleteKnowledgeBase(root: string, kb: KnowledgeBase): Promise<null> {
  return withManifestLock(() => deleteKbLocked(root, kb));
}

/** 工作区项目引用（调用方从注册表映射，保持本模块不依赖 pi-projects） */
export interface WorkspaceProjectRef {
  id: string;
  primary: string;
}

/**
 * 工作区目录改名对账：工作区级 KB 的父目录 `项目/<旧目录名>` 会随项目主目录
 * 改名脱钩。这里按 `workspaceIds` 找到项目当前主目录，把 KB 文件夹搬进新父
 * 目录（同名不动），迁移元数据前缀并更新清单。无变化时不写盘。
 * 无实体 id 的存量 KB（早期懒创建）保持原样。
 */
export function reconcileWorkspaceKbs(
  root: string,
  projects: readonly WorkspaceProjectRef[],
): Promise<KnowledgeBase[]> {
  return withManifestLock(async () => {
    const manifest = await readManifest(root);
    const { fsMove, fsMkdir } = await fs();
    let changed = false;
    for (const kb of manifest.kbs) {
      if (kb.scope !== "workspace" || !kb.workspaceDir) continue;
      const project = projects.find((p) => kb.workspaceIds.includes(p.id));
      if (!project?.primary) continue;
      const folderSeg = projectFolderFor(project.primary);
      if (!folderSeg.startsWith("项目/")) continue;
      const expectedDir = folderSeg.slice("项目/".length);
      if (expectedDir === kb.workspaceDir) continue;
      const newParent = `项目/${expectedDir}`;
      const folderName = kb.folder.slice(kb.folder.lastIndexOf("/") + 1);
      // fs_move 要求目标父目录已存在：新工作区目录可能还没落库，先建出来
      const mkdirErr = await fsMkdir(root, newParent);
      if (mkdirErr) continue;
      const moved = await fsMove(root, kb.folder, newParent).catch(() => null);
      let newFolder: string;
      if (moved?.ok) {
        newFolder = `${newParent}/${moved.name}`;
        await libraryFileMetaMove(root, kb.folder, newFolder, true).catch(() => {});
        await knowledgeRefsRepath({
          source: "library",
          scopeId: root,
          from: kb.folder,
          to: newFolder,
        }).catch(() => {});
      } else if (moved && !moved.ok && moved.error === "not-found") {
        // 旧目录已被外部删除：只把清单指向新位置（首次写入时会自动建目录）
        newFolder = `${newParent}/${folderName}`;
      } else {
        continue;
      }
      kb.workspaceDir = expectedDir;
      kb.folder = newFolder;
      changed = true;
    }
    if (changed) await writeManifest(root, manifest);
    return manifest.kbs;
  });
}

/** 划词落点的懒创建：确保工作区默认 KB 存在，返回其 folder */
export function ensureDefaultWorkspaceKb(
  root: string,
  workspaceDir: string,
  workspaceId?: string,
): Promise<string> {
  return withManifestLock(async () => {
    const manifest = await readManifest(root);
    const target = pickNoteTarget(manifest.kbs, workspaceDir);
    if (target.folder) {
      // 老数据回填：早期懒创建的默认 KB 没有项目 id，趁这次写入补上，
      // 以后工作区目录改名时对账才认得它
      const hit = manifest.kbs.find((kb) => kb.id === target.kbId);
      if (hit && workspaceId && !hit.workspaceIds.includes(workspaceId)) {
        hit.workspaceIds = [...hit.workspaceIds, workspaceId];
        await writeManifest(root, manifest);
      }
      return target.folder;
    }
    const kb = await createKbLocked(root, {
      name: t("library.kb.defaultName"),
      scope: "workspace",
      workspaceDir,
      workspaceId,
      default: true,
    });
    return kb.folder;
  });
}

/** 任务会话（无 cwd）划词落点的懒创建：用户级收件箱 KB，返回其 folder */
export function ensureDefaultUserKb(root: string): Promise<string> {
  return withManifestLock(async () => {
    const kbs = (await readManifest(root)).kbs;
    const target = pickNoteTarget(kbs, null);
    if (target.folder) return target.folder;
    const kb = await createKbLocked(root, {
      name: t("library.kb.inboxName"),
      scope: "user",
      default: true,
    });
    return kb.folder;
  });
}
