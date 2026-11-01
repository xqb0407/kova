/**
 * 内置浏览器站点权限同意记录（对齐 X embeddedBrowserSitePermissions +
 * store 的最小版）：
 * - permission check handler 是同步的，记录必须常驻内存；写路径异步落盘；
 * - 设置页「清除浏览器数据」与决策链路读写同一份记录，口径一致；
 * - 独立 JSON（<appData>/browser-site-permissions.json）原子写（tmp + rename），
 *   不进全局 settings，避免与主题等跨窗口广播耦合；结构损坏按空记录重启
 *   （fail-open 到「每次询问」，不会错误放行）。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BrowserSitePermissionState = "allow" | "deny";
export type BrowserSitePermissionRecord = {
  [origin: string]: { [permission: string]: BrowserSitePermissionState };
};

export interface BrowserSitePermissionStore {
  load(): Promise<BrowserSitePermissionRecord>;
  persist(record: BrowserSitePermissionRecord): Promise<void>;
}

export function createBrowserSitePermissionStore(filePath: string): BrowserSitePermissionStore {
  // 同一进程可能连续写（弹窗连续授权）：串行化，避免两次 rename 交错。
  let writeChain: Promise<void> = Promise.resolve();
  const tempPath = join(dirname(filePath), `.browser-site-permissions.${process.pid}.tmp`);

  const parseRecord = (raw: string): BrowserSitePermissionRecord => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record: BrowserSitePermissionRecord = {};
    for (const [origin, permissions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) continue;
      const normalized: Record<string, BrowserSitePermissionState> = {};
      for (const [permission, state] of Object.entries(permissions as Record<string, unknown>)) {
        if (state === "allow" || state === "deny") normalized[permission] = state;
      }
      if (Object.keys(normalized).length > 0) record[origin] = normalized;
    }
    return record;
  };

  return {
    async load() {
      try {
        return parseRecord(await readFile(filePath, "utf8"));
      } catch {
        return {};
      }
    },
    persist(record) {
      const run = writeChain.then(async () => {
        try {
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
          await rename(tempPath, filePath);
        } catch (err) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          throw err;
        }
      });
      // 调用方不 await（决策已生效），但链本身必须吞掉错误，避免产生
      // unhandled rejection；写失败由 persist 的 catch 记录在模块层。
      writeChain = run.catch(() => undefined);
      return run;
    },
  };
}

let record: BrowserSitePermissionRecord = {};
let store: BrowserSitePermissionStore | null = null;
let logger: { warn(msg: string, ...args: unknown[]): void } | null = null;

export async function initBrowserSitePermissions(input: {
  store?: BrowserSitePermissionStore;
  logger?: { warn(msg: string, ...args: unknown[]): void };
}): Promise<void> {
  store = input.store ?? null;
  logger = input.logger ?? null;
  record = {};
  if (!store) return;
  try {
    record = await store.load();
  } catch (err) {
    logger?.warn("[browser-permission] site permission store load failed:", err);
  }
}

export function getBrowserSitePermission(
  origin: string,
  permission: string,
): BrowserSitePermissionState | undefined {
  return record[origin]?.[permission];
}

export function getBrowserSitePermissionSnapshot(): BrowserSitePermissionRecord {
  return structuredClone(record);
}

export async function writeBrowserSitePermission(
  origin: string,
  permission: string,
  state: BrowserSitePermissionState,
): Promise<void> {
  record[origin] = { ...record[origin], [permission]: state };
  await persist();
}

export async function removeBrowserSitePermission(
  origin: string,
  permission: string,
): Promise<void> {
  const permissions = record[origin];
  if (!permissions) return;
  const next = { ...permissions };
  delete next[permission];
  if (Object.keys(next).length === 0) delete record[origin];
  else record[origin] = next;
  await persist();
}

export async function removeBrowserSitePermissionOrigin(origin: string): Promise<void> {
  delete record[origin];
  await persist();
}

export async function clearBrowserSitePermissions(): Promise<void> {
  record = {};
  await persist();
}

async function persist(): Promise<void> {
  if (!store) return;
  try {
    await store.persist(record);
  } catch (err) {
    // 内存记录已生效；落盘失败只降级为重启后回到「每次询问」，不阻塞决策。
    logger?.warn("[browser-permission] site permission store persist failed:", err);
  }
}

/** 仅测试用：隔离模块级状态。 */
export function resetBrowserSitePermissionsForTest(): void {
  record = {};
  store = null;
  logger = null;
}
