/**
 * KnowledgeService：资料库/产物检索与召回的单一门面。
 *
 * 本轮先 in-process；接口与实现分离，未来可替换为独立进程的 RPC 实现。
 * 读写真值仍在原处：资料库文件归 Electron main/文件系统，索引是可重建投影。
 */
import { rankHintEntries, type KnowledgeEntry } from "knowledge-core";
import { recentArtifacts, refreshArtifactsIndex, searchSessions } from "./indexer";

export type KnowledgeRecallHit = {
  rel: string;
  name: string;
  title: string;
  preview: string;
};

export type KnowledgeSearchResult = Awaited<ReturnType<typeof searchSessions>>;

export interface KnowledgeService {
  /** 重建/增量刷新派生索引。 */
  reindex(): Promise<void>;
  /** 发送前召回：只返回标题/路径/摘要，不塞正文。 */
  recall(text: string, limit?: number): Promise<KnowledgeRecallHit[]>;
  /** 统一搜索入口（会话 + 文件域）。 */
  search(query: string, limit?: number): Promise<KnowledgeSearchResult>;
}

type ArtifactRow = {
  rel?: unknown;
  name?: unknown;
  preview?: unknown;
};

function asEntry(row: ArtifactRow): KnowledgeEntry | null {
  if (typeof row.rel !== "string" || !row.rel) return null;
  const name =
    typeof row.name === "string" && row.name
      ? row.name
      : row.rel.split("/").pop() ?? row.rel;
  return {
    rel: row.rel,
    name,
    title: name,
    tags: [],
    modified: null,
    lastUsed: 0,
  };
}

export function createKnowledgeService(): KnowledgeService {
  return {
    async reindex() {
      await refreshArtifactsIndex();
    },

    async recall(text, limit = 3) {
      await refreshArtifactsIndex();
      const rows = (await recentArtifacts(500).catch(() => [])) as ArtifactRow[];
      const entries: KnowledgeEntry[] = [];
      const previews = new Map<string, string>();
      for (const row of rows) {
        const entry = asEntry(row);
        if (!entry) continue;
        entries.push(entry);
        if (typeof row.preview === "string") previews.set(entry.rel, row.preview);
      }
      const ranked = rankHintEntries(entries, text, new Set(), limit);
      return ranked.map((entry) => ({
        rel: entry.rel,
        name: entry.name,
        title: entry.title,
        preview: previews.get(entry.rel) ?? "",
      }));
    },

    async search(query, limit = 200) {
      return searchSessions(query, limit);
    },
  };
}

/** 进程内单例：kb 工具与协议层共用一个索引刷新互斥/召回门面。 */
export const knowledgeService = createKnowledgeService();
