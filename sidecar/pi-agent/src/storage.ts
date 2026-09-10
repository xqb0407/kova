/**
 * 存储装配：会话 JSONL 目录 + pi-ai CredentialStore 实现。
 * 业务表（pi_sessions/credentials/custom_providers/provider_models）的读写
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
  credentialGet,
  credentialList,
  credentialSet,
  credentialDelete,
  initHostTransport,
  initLocalStorage,
} from "./hostdb";

let sessionsDirPath = "";

/** 会话 JSONL 文件路径 */
export function sessionPath(id: string): string {
  return path.join(sessionsDirPath, `${id}.jsonl`);
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
    const row = await credentialGet(providerId);
    return row ? { type: "api_key", key: row.apiKey } : undefined;
  },
  async list(): Promise<readonly CredentialInfo[]> {
    const providers = await credentialList();
    return providers.map((providerId) => ({
      providerId,
      type: "api_key" as const,
    }));
  },
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next?.type === "api_key" && next.key) {
      await credentialSet(providerId, next.key);
    }
    return next;
  },
  async delete(providerId: string): Promise<void> {
    await credentialDelete(providerId);
  },
};
