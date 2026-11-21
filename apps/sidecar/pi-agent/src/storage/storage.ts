/**
 * 存储装配：会话 JSONL 目录 + pi-ai CredentialStore 实现。
 * 业务表（sessions/credentials/custom_providers/models）的读写
 * 统一走 hostdb.ts 的数据访问层：
 *   - 生产（Rust 宿主拉起）：initHostMode → host_query RPC，Rust 是唯一写入方
 *   - 测试/冒烟：initStorage → bun:sqlite 本地库
 * credentialStore 接口本身是 async 的，两种模式下同一实现。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import {
  credentialEnvGet,
  credentialGet,
  credentialList,
  credentialSet,
  credentialDelete,
  initHostTransport,
  initLocalStorage,
  WEBSEARCH_CREDENTIAL_PREFIX,
} from "./hostdb";
import { legacyProviderIds, normalizeProviderId } from "../model/provider-id";

let sessionsDirPath = "";

/**
 * 会话根目录（初始化时传入的事实源）。未初始化时返回空串，调用方自行兜底。
 * artifact-store 等旁路落盘点用它取根，避免各自再读环境变量造成目录分叉。
 */
export function sessionsDirRoot(): string {
  return sessionsDirPath;
}

/** 会话 JSONL 文件路径 */
export function sessionPath(id: string): string {
  return path.join(sessionsDirPath, `${id}.jsonl`);
}

/** Agent 调用轨迹（trace.ts）：每会话一份 JSONL，一行一个 run */
export function tracePath(id: string): string {
  if (!sessionsDirPath) throw new Error("storage not initialized");
  return path.join(sessionsDirPath, "traces", `${id}.jsonl`);
}

/**
 * 在飞 run 的增量落盘（trace.ts）：按轮追加，`turn_end` 时写一次。
 * 与主 trace 文件分开是刻意的——主文件「一行 = 一个完整 run」是读取端与
 * OTLP 导出器共同假定的不变量，半截 run 不能写进去。
 */
export function traceLivePath(id: string): string {
  if (!sessionsDirPath) throw new Error("storage not initialized");
  return path.join(sessionsDirPath, "traces", `${id}.live.jsonl`);
}

/** 子代理活动落盘目录（activity-store.ts）：每个委派一份 JSONL */
export function subagentsDirPath(): string {
  if (!sessionsDirPath) throw new Error("storage not initialized");
  return path.join(sessionsDirPath, "subagents");
}

/** 单个委派的活动文件路径 */
export function subagentPath(delegationId: string): string {
  return path.join(subagentsDirPath(), `${delegationId}.jsonl`);
}

/** 生产模式：数据访问走 host_query RPC（index.ts 读到 PI_SESSIONS_DIR 时调用） */
export function initHostMode(sessionsDir: string): void {
  sessionsDirPath = sessionsDir;
  mkdirSync(sessionsDir, { recursive: true });
  initHostTransport();
}

/** 测试/冒烟模式：本地 SQLite（保留旧签名，测试文件无需改动调用方式） */
export function initStorage(dbPath: string, sessionsDir: string): void {
  sessionsDirPath = sessionsDir;
  mkdirSync(sessionsDir, { recursive: true });
  initLocalStorage(dbPath);
}

/** 凭据存储（喂给 pi-ai 的 CredentialStore 实现；底层 = hostdb 数据访问层） */
export const credentialStore: CredentialStore = {
  async read(providerId: string): Promise<Credential | undefined> {
    const id = normalizeProviderId(providerId);
    // 读时别名兜底：即使表迁移没跑到，旧 provider 行仍能认证。
    // 候选包含：归一后的新 id、已知历史 id、调用方原始 id。
    const candidates = [...new Set([id, ...legacyProviderIds(id), providerId])];
    let row: { apiKey: string } | null = null;
    for (const candidate of candidates) {
      row = await credentialGet(candidate);
      if (row) break;
    }
    if (!row) return undefined;
    // 非密钥补充字段（Cloudflare 网关的 Account/Gateway ID 等）挂 kv：缺了它们
    // pi-ai 解析不出该 provider 的凭据，所有模型被标成未认证而从模型选择里消失
    let env: Record<string, string> = {};
    for (const candidate of candidates) {
      env = await credentialEnvGet(candidate);
      if (Object.keys(env).length > 0) break;
    }
    return {
      type: "api_key",
      key: row.apiKey,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  },
  async list(): Promise<readonly CredentialInfo[]> {
    // 非模型凭据（网页搜索 websearch:<id> 等）不参与模型 provider 枚举
    const providers = (await credentialList()).filter(
      (provider) => !provider.startsWith(WEBSEARCH_CREDENTIAL_PREFIX),
    );
    const seen = new Set<string>();
    const out: CredentialInfo[] = [];
    for (const providerId of providers) {
      const id = normalizeProviderId(providerId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ providerId: id, type: "api_key" as const });
    }
    return out;
  },
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const id = normalizeProviderId(providerId);
    const current = await this.read(id);
    const next = await fn(current);
    if (next?.type === "api_key" && next.key) {
      await credentialSet(id, next.key);
    }
    return next;
  },
  async delete(providerId: string): Promise<void> {
    const id = normalizeProviderId(providerId);
    for (const candidate of new Set([id, ...legacyProviderIds(id), providerId])) {
      await credentialDelete(candidate);
    }
  },
};
