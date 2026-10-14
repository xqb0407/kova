/**
 * 内置主题包的启动同步（首启解压 + 版本化升级）：
 * zip 内 catalog.version ≠ <root>/builtin/.manifest.json 的 version（或清单缺失）
 * → 全量解压覆盖 builtin/<slug>/DESIGN.md、删除本包不再包含的旧 slug、写新 manifest；
 * 相等 → 跳过（启动零 IO 读一个 JSON 而已）。
 *
 * 升级安全：本模块只写 builtin/，用户主题在 user/ 永不被触碰（用户魔改内置
 * 风格走管理页"另存为我的主题"fork 进 user/，同名遮蔽 builtin）；被新包删除的
 * 主题若正被某会话使用，运行时按 normalize 回落（见 store.ts 清单现算）。
 * 失败非致命：logErr 后清单仍可由 zip 内存副本支撑，下次启动重试。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8 } from "fflate";
import { builtinCatalog } from "./catalog";
import { builtinThemesDir } from "./paths";
import { logErr } from "../log";

const MANIFEST_FILE = ".manifest.json";

type BuiltinManifest = {
  version: string;
  syncedAt: string;
  /** 本包包含的全部 slug（升级时据此甄别该删的旧主题目录） */
  slugs: string[];
};

function readManifest(dir: string): BuiltinManifest | null {
  try {
    const raw = readFileSync(join(dir, MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<BuiltinManifest>;
    if (typeof parsed.version === "string" && Array.isArray(parsed.slugs)) {
      return { version: parsed.version, syncedAt: parsed.syncedAt ?? "", slugs: parsed.slugs };
    }
    return null;
  } catch {
    return null;
  }
}

export type BuiltinSyncResult =
  | { status: "synced"; version: string; themes: number; removed: string[] }
  | { status: "skipped"; version: string }
  | { status: "failed"; error: string };

/** 同步一次；启动与设置页"刷新"前调用，幂等。synced 时 removed = 本剪掉的旧内置 slug（调用方负责清引用） */
export async function syncBuiltinThemes(): Promise<BuiltinSyncResult> {
  try {
    const catalog = await builtinCatalog();
    const dir = builtinThemesDir();
    const manifest = readManifest(dir);
    if (manifest?.version === catalog.version) {
      return { status: "skipped", version: catalog.version };
    }
    mkdirSync(dir, { recursive: true });
    for (const t of catalog.themes) {
      const themeDir = join(dir, t.id);
      mkdirSync(themeDir, { recursive: true });
      const doc = catalog.docs.get(t.id);
      if (doc !== undefined) writeFileSync(join(themeDir, "DESIGN.md"), strToU8(doc), "utf8");
    }
    // 删旧：上一版包有、这一版没有的 slug（只动 manifest 记账过的目录，不碰手工文件）
    const removed: string[] = [];
    if (manifest) {
      const keep = new Set(catalog.themes.map((t) => t.id));
      for (const stale of manifest.slugs) {
        if (!keep.has(stale)) {
          removed.push(stale);
          try {
            rmSync(join(dir, stale), { recursive: true, force: true });
          } catch (err) {
            logErr("design-md: prune stale theme failed:", stale, err);
          }
        }
      }
    }
    const next: BuiltinManifest = {
      version: catalog.version,
      syncedAt: new Date().toISOString(),
      slugs: catalog.themes.map((t) => t.id),
    };
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(next, null, 2) + "\n", "utf8");
    return { status: "synced", version: catalog.version, themes: catalog.themes.length, removed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logErr("design-md: builtin sync failed:", msg);
    return { status: "failed", error: msg };
  }
}

/** manifest 当前已同步版本（列表接口回显用；未同步/坏档返回 null） */
export function builtinSyncedVersion(): string | null {
  if (!existsSync(builtinThemesDir())) return null;
  return readManifest(builtinThemesDir())?.version ?? null;
}
