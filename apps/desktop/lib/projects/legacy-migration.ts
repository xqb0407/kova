"use client";

/**
 * 一次性迁移：把 localStorage 里的旧项目名称/外观写入后端项目实体。
 *
 * 触发时机：桌面启动后项目列表首次加载完成时。
 * 规则：
 * - 旧 `project-display-name-v1` 的 cwd 如果匹配某个项目的 primary/folder →
 *   写入 display_name/name_is_custom
 * - 没匹配到的 cwd 如果有会话历史 → 建隐藏项目（show_when_empty=0）并写入
 * - 都没有 → 保留在备份 key 里，不建空项目
 * - 迁移成功后旧 key 复制到备份并删除活动 key；失败则保留不动（下次重试）
 */
import {
  fetchProjects,
  findProjectByPath,
  projectDisplayName,
  saveProject,
  type ProjectRecord,
} from "@/lib/pi/pi-projects";

const LEGACY_NAMES_KEY = "project-display-name-v1";
const LEGACY_APPEARANCE_KEY = "project-appearance-v1";
const BACKUP_KEY = "project-meta.legacy-backup.v1";
const MIGRATION_DONE_KEY = "project-meta.migrated.v1";

type LegacyNames = Record<string, string>;
type LegacyAppearance = Record<string, Record<string, unknown>>;

function readLegacyNames(): LegacyNames {
  try {
    const raw = localStorage.getItem(LEGACY_NAMES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LegacyNames) : {};
  } catch {
    return {};
  }
}

function readLegacyAppearance(): LegacyAppearance {
  try {
    const raw = localStorage.getItem(LEGACY_APPEARANCE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LegacyAppearance) : {};
  } catch {
    return {};
  }
}

function writeBackup(names: LegacyNames, appearance: LegacyAppearance): void {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ names, appearance }));
  } catch {
    /* 配额/隐私模式：备份失败不阻断 */
  }
}

/**
 * 一次性迁移入口：在项目列表加载后调用。
 * 返回 true = 执行了迁移；false = 已迁移过 / 没有旧数据 / 非桌面环境。
 *
 * 单条 cwd 失败（目录已删除、校验失败等）不阻断其它条目：数据仍在活动
 * key/备份里，只是这条暂时无法写入项目实体。
 */
export async function migrateLegacyProjectMeta(): Promise<boolean> {
  if (typeof window === "undefined" || !window.localStorage) return false;
  if (localStorage.getItem(MIGRATION_DONE_KEY)) return false;

  const names = readLegacyNames();
  const appearance = readLegacyAppearance();
  const cwds = new Set([...Object.keys(names), ...Object.keys(appearance)]);
  if (cwds.size === 0) {
    localStorage.setItem(MIGRATION_DONE_KEY, JSON.stringify({ at: Date.now() }));
    return false;
  }

  try {
    const projects = await fetchProjects(true);
    const unmatchedNames: LegacyNames = {};
    const unmatchedAppearance: LegacyAppearance = {};
    let applied = 0;
    let failed = 0;
    // 自定义名称现在有唯一校验：历史 localStorage 可能有重名，迁移时给
    // 后来者加序号，避免整条迁移因“名称已存在”被跳过而丢数据。
    const namesById = new Map(
      projects.map((project) => [project.id, projectDisplayName(project).trim()]),
    );
    const nameTaken = (candidate: string, selfId?: string): boolean =>
      [...namesById.entries()].some(
        ([id, value]) =>
          id !== selfId &&
          value.length > 0 &&
          value.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
      );
    const uniqueLegacyName = (base: string, selfId?: string): string => {
      if (!nameTaken(base, selfId)) return base;
      let suffix = 2;
      while (nameTaken(`${base} ${suffix}`, selfId)) suffix += 1;
      return `${base} ${suffix}`;
    };

    for (const cwd of cwds) {
      const project = findProjectByPath(projects, cwd);
      const name = names[cwd];
      const appearanceData = appearance[cwd];
      const baseName = typeof name === "string" ? name.trim() : "";
      const hasName = Boolean(baseName);
      const hasAppearance = appearanceData && Object.keys(appearanceData).length > 0;

      try {
        if (project) {
          // 已有项目：写入名称/外观（保留已有 folders）
          const finalName = hasName
            ? uniqueLegacyName(baseName, project.id)
            : "";
          if (finalName) namesById.set(project.id, finalName);
          await saveProject({
            id: project.id,
            ...(hasName ? { name: finalName, nameIsCustom: true } : {}),
            ...(hasAppearance
              ? { appearanceJson: JSON.stringify(appearanceData) }
              : {}),
            folders: project.folders.map((folder) => folder.path),
            primaryPath: project.folders.find((folder) => folder.isPrimary)?.path,
          });
          applied += 1;
        } else if (hasName || hasAppearance) {
          // 没有项目但有元数据：创建隐藏项目保留数据。
          // 即使旧数据没有名称，也显式给一个唯一的回落名（文件夹 basename），
          // 否则与同 basename 的项目撞唯一校验会让这条迁移被跳过。
          const baseLabel =
            cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd || "项目";
          const finalName = hasName
            ? uniqueLegacyName(baseName)
            : uniqueLegacyName(baseLabel);
          const created = await saveProject({
            name: finalName,
            nameIsCustom: hasName,
            ...(hasAppearance
              ? { appearanceJson: JSON.stringify(appearanceData) }
              : {}),
            folders: [cwd],
            primaryPath: cwd,
            showWhenEmpty: false,
          });
          namesById.set(created.id, finalName);
          applied += 1;
        } else {
          // 没有项目也没有有效元数据：留备份不建项目
          if (name !== undefined) unmatchedNames[cwd] = name;
          if (appearanceData) unmatchedAppearance[cwd] = appearanceData;
        }
      } catch {
        // 目录不存在/校验失败等：保留在备份里，不阻断其它项目
        failed += 1;
        if (name !== undefined) unmatchedNames[cwd] = name;
        if (appearanceData) unmatchedAppearance[cwd] = appearanceData;
      }
    }

    // 备份旧数据（全量，含未匹配/失败的）。
    // **不删活动 key**：侧栏/胶囊仍从 localStorage 读名称/外观（同步显示缓存），
    // 后端是持久化事实源。删了 key 会导致自定义名称/图标在侧栏消失。
    writeBackup(names, appearance);
    localStorage.setItem(
      MIGRATION_DONE_KEY,
      JSON.stringify({ at: Date.now(), applied, failed }),
    );
    return true;
  } catch {
    // 迁移失败：旧数据保留在活动 key，下次启动重试
    return false;
  }
}

let ensureRunning: Promise<void> | undefined;

/** 还有待迁移数据（未写 marker 且活动 key 非空） */
function legacyMetaPending(): boolean {
  try {
    if (localStorage.getItem(MIGRATION_DONE_KEY)) return false;
    const names = readLegacyNames();
    const appearance = readLegacyAppearance();
    return Object.keys(names).length > 0 || Object.keys(appearance).length > 0;
  } catch {
    return false;
  }
}

/**
 * 启动链路的幂等入口：侧车可能还没就绪，失败按退避重试若干次。
 * 迁移成功后刷新项目注册表，让侧栏立即看到新写入的名称/外观。
 */
export function ensureLegacyProjectMetaMigrated(attempt = 0): Promise<void> {
  ensureRunning ??= (async () => {
    const ok = await migrateLegacyProjectMeta();
    if (!ok && legacyMetaPending()) {
      ensureRunning = undefined;
      if (attempt < 5) {
        const delay = [800, 2_000, 5_000, 10_000, 20_000][attempt] ?? 20_000;
        setTimeout(() => {
          void ensureLegacyProjectMetaMigrated(attempt + 1);
        }, delay);
      }
      return;
    }
    try {
      const { refreshRegistry } = await import("@/lib/pi/pi-projects");
      await refreshRegistry();
    } catch {
      /* 注册表刷新失败不影响迁移结果 */
    }
  })();
  return ensureRunning;
}

/** 测试缝：清掉迁移标记（仅测试用） */
export function resetLegacyMigrationForTest(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  localStorage.removeItem(MIGRATION_DONE_KEY);
  localStorage.removeItem(BACKUP_KEY);
}

export type { ProjectRecord };
