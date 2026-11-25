/**
 * 市场登记表（marketplaces.json，每次操作读盘——低频操作，不做缓存）与
 * 稳定市场 id 派生。目录缓存与安装写路径见 marketplaces.ts。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { asString, isRecord, marketplacesFilePath, pluginsRootDir, type MarketplaceRecord, type MarketplaceType } from "./manifest";
import { logErr } from "../log";

/** Codex 个人市场的内置 id（自动发现 `$HOME/.agents/plugins/marketplace.json`） */
export const CODEX_PERSONAL_MKT_ID = "codex-personal";

export function readMarketplaceRecords(): MarketplaceRecord[] {
  const p = marketplacesFilePath();
  if (!existsSync(p)) return [];
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!isRecord(doc) || !Array.isArray(doc.marketplaces)) return [];
    return (doc.marketplaces as unknown[]).filter(isRecord).map((r) => ({
      id: String(r.id ?? ""),
      name: asString(r.name) ?? String(r.id ?? ""),
      type: r.type === "git" ? "git" : "directory",
      ...(typeof r.path === "string" ? { path: r.path } : {}),
      ...(typeof r.repo === "string" ? { repo: r.repo } : {}),
      ...(typeof r.sourceBase === "string" ? { sourceBase: r.sourceBase } : {}),
      addedAt: typeof r.addedAt === "string" ? r.addedAt : "",
      ...(typeof r.lastRefresh === "string" ? { lastRefresh: r.lastRefresh } : {}),
    }));
  } catch (err) {
    logErr("marketplaces.json:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export function writeMarketplaceRecords(records: MarketplaceRecord[]): void {
  mkdirSync(pluginsRootDir(), { recursive: true });
  const doc = { version: 1, marketplaces: records };
  writeMarketplacesAtomic(marketplacesFilePath(), `${JSON.stringify(doc, null, 2)}\n`);
}

function writeMarketplacesAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Codex personal marketplace：`$HOME/.agents/plugins/marketplace.json` 由 Codex
 * 自动发现，不需要用户手动登记。这里合成一个只读记录：source 根是 `$HOME`
 * （`./plugins/x` 相对 home），不写 marketplaces.json，不可移除。
 */
export function codexPersonalMarketplace(home = homedir()): MarketplaceRecord | undefined {
  const manifest = join(home, ".agents", "plugins", "marketplace.json");
  if (!existsSync(manifest)) return undefined;
  return {
    id: CODEX_PERSONAL_MKT_ID,
    name: "personal",
    type: "directory",
    // 登记路径指向市场目录，source 根仍是 $HOME（Codex personal 语义）
    path: join(home, ".agents", "plugins"),
    sourceBase: home,
    builtin: true,
    addedAt: "",
  };
}

/** 登记表 + 内置 Codex personal 市场（已手动登记同一市场时不重复） */
export function listMarketplaces(): MarketplaceRecord[] {
  const records = readMarketplaceRecords();
  const personal = codexPersonalMarketplace();
  if (!personal) return records;
  const marketDir = personal.path ?? "";
  const sourceRoot = personal.sourceBase ?? "";
  const covered = records.some(
    (record) =>
      record.type === "directory" &&
      (record.path === marketDir ||
        record.path === sourceRoot ||
        record.sourceBase === sourceRoot),
  );
  return covered ? records : [...records, personal];
}

/** 按 id 取市场：登记表优先，其次内置 personal 市场 */
export function marketplaceRecordById(id: string): MarketplaceRecord | undefined {
  return listMarketplaces().find((record) => record.id === id);
}

export function sha8(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/** 稳定市场 id：directory 按绝对路径、git 按仓库地址派生（重复添加幂等） */
export function marketplaceIdFor(type: MarketplaceType, source: string): string {
  const prefix = type === "git" ? "git" : "dir";
  return `${prefix}-${sha8(`${type}:${source}`)}`;
}
