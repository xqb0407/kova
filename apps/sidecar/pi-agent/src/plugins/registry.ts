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
import { asString, isRecord, marketplacesFilePath, pluginsRootDir, type MarketplaceRecord, type MarketplaceType } from "./manifest";
import { logErr } from "../log";

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

export function listMarketplaces(): MarketplaceRecord[] {
  return readMarketplaceRecords();
}

export function sha8(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/** 稳定市场 id：directory 按绝对路径、git 按仓库地址派生（重复添加幂等） */
export function marketplaceIdFor(type: MarketplaceType, source: string): string {
  const prefix = type === "git" ? "git" : "dir";
  return `${prefix}-${sha8(`${type}:${source}`)}`;
}
