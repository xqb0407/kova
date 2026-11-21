/**
 * 项目级虚拟目录：把一个项目扩展成多个代码工程的集合（类虚拟工作区形态）。。
 *
 * 模型：项目由「主目录」标识（= 会话 cwd 的默认归属），可再附加若干根目录。
 * 附加根目录是**用户本机配置**（SQLite kv `pi.projectDirs`），不写进仓库：
 * clone 别人的项目不会凭空多出注入指令/技能的路径，这与 pi-add-dir 的
 * project 级配置刻意不同（那里会跟随 git）。
 *
 * 生效规则：
 * - 任何会话，只要 cwd 等于主目录或某个附加根，都属于同一项目；
 * - 该会话的外部目录 = 项目附加根（排除 cwd 自身） + 会话自己添加的目录；
 * - 侧栏分组按「项目主目录」归并，所以附加根里开的会话会回到同一个项目卡下。
 *
 * 校验（纯路径规则，bad case 全部拒绝而不是静默跳过）：
 * - 新根必须存在且是目录；
 * - 不与主目录、已有根重叠（任一方向包含都算重叠）；
 * - 不被其它项目的任何根占用，也不包含其它项目的根（一个目录只属于一个项目）；
 * - 每项目最多 MAX_EXTERNAL_DIRS 个附加根。
 */
import type { ExternalDir } from "pi-protocol";
import { basename } from "node:path";
import {
  MAX_EXTERNAL_DIRS,
  externalDirExists,
  externalDirLabel,
  externalDirsOverlap,
  resolveExternalPath,
  validateExternalDir,
} from "./external-dirs";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

/** kv 键：{ [项目主目录]: ExternalDir[] } */
const PROJECT_DIRS_KV_KEY = "pi.projectDirs";

export type ProjectRoots = {
  /** 项目主目录（规范化后的绝对路径） */
  main: string;
  /** 主目录 + 附加根；主目录恒在首位 */
  roots: ExternalDir[];
};

type ProjectDirsMap = Record<string, ExternalDir[]>;

let projects: ProjectDirsMap = {};
let load: Promise<void> | undefined;

function real(path: string): string {
  return resolveExternalPath(path, path);
}

function safeReal(path: string): string | null {
  try {
    return path.trim() ? real(path) : null;
  } catch {
    return null;
  }
}

function normalizeDirs(raw: unknown): ExternalDir[] {
  if (!Array.isArray(raw)) return [];
  const out: ExternalDir[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const path = typeof item?.path === "string" ? item.path : "";
    if (!path) continue;
    const normalized = safeReal(path) ?? path;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      path: normalized,
      label: typeof item?.label === "string" && item.label
        ? item.label
        : externalDirLabel(normalized),
    });
    if (out.length >= MAX_EXTERNAL_DIRS) break;
  }
  return out;
}

function normalizeMap(raw: unknown): ProjectDirsMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProjectDirsMap = {};
  // 手工编辑过的 kv 可能把同一/嵌套目录写进多个项目：按插入序先见者胜。
  // 主目录、已占用的根、与主目录重叠的根都剔除（一个目录只属于一个项目）。
  const claimed = new Set<string>();
  const claim = (path: string): string => safeReal(path) ?? path;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const main = safeReal(key);
    if (!main || claimed.has(main)) continue;
    claimed.add(main);
    const dirs: ExternalDir[] = [];
    for (const dir of normalizeDirs(value)) {
      const real = claim(dir.path);
      if (claimed.has(real)) continue;
      if (externalDirsOverlap(main, real)) continue;
      if (dirs.some((kept) => externalDirsOverlap(claim(kept.path), real))) continue;
      claimed.add(real);
      dirs.push(dir);
    }
    if (dirs.length > 0) out[main] = dirs;
  }
  return out;
}

/** 启动闸门内调用一次（index.ts）；幂等。失败按空配置启动，不阻断会话。 */
export function initProjectDirs(): Promise<void> {
  load ??= (async () => {
    try {
      const row = await kvGet(PROJECT_DIRS_KV_KEY);
      if (!row?.value) return;
      projects = normalizeMap(JSON.parse(row.value));
    } catch (err) {
      logErr("project-dirs: load failed:", err);
      projects = {};
    }
  })();
  return load;
}

async function persist(): Promise<void> {
  try {
    await kvSet(PROJECT_DIRS_KV_KEY, JSON.stringify(projects));
  } catch (err) {
    logErr("project-dirs: save failed:", err);
    throw new Error("Cannot save project directories.");
  }
}

/** 解析 cwd 所属项目的主目录：自己就是主目录，或者是某项目的附加根 */
export function projectCwdFor(cwd: string): string | undefined {
  const raw = cwd.trim();
  if (!raw) return undefined;
  // 热路径（list_sessions 每个会话一次）：先按原字符串命中，省掉 realpath
  if (projects[raw]) return raw;
  const target = safeReal(raw);
  if (!target) return undefined;
  if (projects[target]) return target;
  for (const [main, dirs] of Object.entries(projects)) {
    if (dirs.some((dir) => dir.path === target || safeReal(dir.path) === target)) {
      return main;
    }
  }
  return undefined;
}

/** 会话摘要投影：cwd 属于某个虚拟项目时回主目录，否则 undefined（按 cwd 分组） */
export function canonicalProjectCwd(cwd: string): string | undefined {
  return projectCwdFor(cwd);
}

/**
 * 一个 cwd 对应的项目根清单（主目录 + 附加根）。未配置的项目返回
 * `{ main: cwd, roots: [cwd] }`，供项目管理弹层展示主目录。
 */
export function projectRootsFor(cwd: string): ProjectRoots | null {
  const target = safeReal(cwd);
  if (!target) return null;
  const main = projectCwdFor(target) ?? target;
  const extras = projects[main] ?? [];
  return {
    main,
    roots: [{ path: main, label: basename(main) || main }, ...extras],
  };
}

/**
 * 该 cwd 的**生效附加目录**：项目附加根排除 cwd 自身。
 * cwd = 主目录 → 全部附加根；cwd = 某附加根 → 主目录 + 其余附加根。
 */
export function effectiveProjectDirs(cwd: string): ExternalDir[] {
  const roots = projectRootsFor(cwd);
  if (!roots) return [];
  const target = safeReal(cwd);
  return roots.roots.filter((dir) => {
    if (dir.path === roots.main) return target !== roots.main;
    return safeReal(dir.path) !== target;
  });
}

/** 全部项目（主目录 + 根清单），按主目录排序；设置页/多窗口同步用 */
export function allProjectDirs(): ProjectRoots[] {
  return Object.keys(projects)
    .sort()
    .map((main) => ({
      main,
      roots: [{ path: main, label: basename(main) || main }, ...projects[main]!],
    }));
}

function assertNotClaimedByOtherProject(main: string, candidate: string): void {
  for (const [otherMain, dirs] of Object.entries(projects)) {
    if (otherMain === main) continue;
    const otherRoots = [otherMain, ...dirs.map((dir) => dir.path)];
    const conflict = otherRoots.find((root) =>
      externalDirsOverlap(safeReal(root) ?? root, candidate),
    );
    if (conflict) {
      throw new Error(
        `Directory already belongs to another project: ${conflict}`,
      );
    }
  }
}

/** 追加一个项目根目录 */
export async function addProjectDir(cwd: string, input: string): Promise<ProjectRoots> {
  const main = projectCwdFor(cwd) ?? safeReal(cwd);
  if (!main) throw new Error("Project directory does not exist.");
  if (!externalDirExists(main)) {
    throw new Error(`Project directory does not exist: ${main}`);
  }
  const existing = projects[main] ?? [];
  // 基础校验复用 external-dirs 的纯函数：存在性、realpath、与主目录/已有根
  // 重叠、数量上限。项目间占用是项目层独有的规则，在其后再判。
  const validation = validateExternalDir(input, { cwd: main, existing });
  if (!validation.ok) throw new Error(validation.message);
  assertNotClaimedByOtherProject(main, validation.absolutePath);

  projects[main] = [
    ...existing,
    { path: validation.absolutePath, label: validation.label },
  ];
  try {
    await persist();
  } catch (err) {
    // 落盘失败就回滚内存：否则本进程看到的是「加了」，重启后又消失
    if (existing.length > 0) projects[main] = existing;
    else delete projects[main];
    throw err;
  }
  return projectRootsFor(main)!;
}

/** 移除一个项目根目录（主目录不可移除） */
export async function removeProjectDir(
  cwd: string,
  input: string,
): Promise<ProjectRoots> {
  const main = projectCwdFor(cwd) ?? safeReal(cwd);
  if (!main) throw new Error("Project directory does not exist.");
  const target = safeReal(input) ?? resolveExternalPath(input, main);
  const existing = projects[main] ?? [];
  const next = existing.filter((dir) => safeReal(dir.path) !== target);
  if (next.length !== existing.length) {
    if (next.length > 0) projects[main] = next;
    else delete projects[main];
    try {
      await persist();
    } catch (err) {
      // 同 addProjectDir：写盘失败回滚，内存与磁盘不能分叉
      if (existing.length > 0) projects[main] = existing;
      else delete projects[main];
      throw err;
    }
  }
  return projectRootsFor(main)!;
}

/** 测试钩子：清空内存与装载闸门（kv 内容由测试自行控制） */
export function resetProjectDirsForTest(): void {
  projects = {};
  load = undefined;
}

/** 测试钩子：直接注入内存配置（跳过 kv） */
export function seedProjectDirsForTest(map: ProjectDirsMap): void {
  projects = normalizeMap(map);
  load = Promise.resolve();
}
