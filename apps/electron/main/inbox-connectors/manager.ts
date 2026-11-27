/**
 * 收件箱外部来源管理器：配置生命周期、轮询、状态、通知与 sidecar 推送。
 *
 * 关键取舍：
 * - 轮询在主进程：凭证/代理/生命周期都在这里；sidecar 只做收件箱事实源。
 * - 每次成功拉取推「全量快照」：sidecar 按稳定 ID upsert，缺失项在 complete
 *   时结算；分页未拉全时 complete=false，绝不误结算。
 * - 首次成功同步只标记已见，不补弹历史事项；之后只对新增且 requiresAction
 *   的事项弹系统通知。
 */
import { powerMonitor } from "electron";
import type {
  InboxConnectorPrefsInput,
  InboxConnectorSaveInput,
  InboxConnectorSnapshot,
  InboxConnectorStatus,
  InboxConnectorSyncResult,
  InboxConnectorTestInput,
  InboxConnectorTestResult,
} from "pi-protocol";
import { logInfo, logWarn } from "../logging";
import { emitToWindows } from "../ipc";
import { piRequestInternal, setSidecarLifecycleListener } from "../pi-agent";
import {
  buildSnapshot,
  deleteConnector,
  loadStoredConnectors,
  loadStoredStatuses,
  persistStoredStatuses,
  publicConfig,
  setConnectorAccount,
  tokenOf,
  updateConnectorPrefs,
  upsertConnector,
} from "./config-store";
import { asNetworkError, ConnectorError } from "./errors";
import { electronHttp } from "./http";
import { notifyNewExternalItems } from "./notify";
import { adapterFor } from "./providers";
import { selfActivityKeysFor } from "./self-activity";
import type {
  ConnectorFetchResult,
  ConnectorRuntime,
  ExternalNotification,
  StoredConnector,
} from "./types";

const DEFAULT_POLL_SEC = 120;
const MIN_RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60 * 1000;
const FIRST_POLL_DELAY_MS = 1_500;
const PUSH_TIMEOUT_MS = 15_000;

let initialized = false;
let runtimes = new Map<string, ConnectorRuntime>();
let statuses: Record<string, InboxConnectorStatus> = {};
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 删除连接器时 sidecar 不在线：spawn 后补一条空快照把旧条目结算掉 */
const pendingClears = new Map<string, { provider: string; connectorId: string }>();
let resumeHandler: (() => void) | null = null;

function statusOf(id: string): InboxConnectorStatus {
  return statuses[id] ?? { id, state: "idle" };
}

function setStatus(
  id: string,
  patch: Partial<InboxConnectorStatus>,
): void {
  statuses[id] = {
    ...statuses[id],
    ...patch,
    id,
  } as InboxConnectorStatus;
  schedulePersist();
  broadcast();
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistStoredStatuses(statuses);
  }, 500);
  persistTimer.unref?.();
}

function snapshot(): InboxConnectorSnapshot {
  const connectors = loadStoredConnectors();
  const map: Record<string, InboxConnectorStatus> = {};
  for (const config of connectors) {
    const status = statuses[config.id] ?? {
      id: config.id,
      state: config.enabled
        ? config.tokenCipher
          ? "idle"
          : "needs_auth"
        : "disabled",
    };
    map[config.id] = config.enabled
      ? status
      : { ...status, state: "disabled" };
  }
  return buildSnapshot(connectors, map);
}

function broadcast(): void {
  try {
    emitToWindows("inbox:connectors", snapshot());
  } catch (error) {
    logWarn(`[inbox-connectors] broadcast failed: ${String(error)}`);
  }
}

function itemKey(item: ExternalNotification): string {
  return item.idKey || item.key || item.url || item.title;
}

function createRuntime(config: StoredConnector): ConnectorRuntime {
  return {
    config,
    token: tokenOf(config),
    timer: null,
    inflight: false,
    failCount: 0,
    primed: false,
    seenKeys: new Set(),
    lastItems: [],
    lastComplete: true,
  };
}

function stopTimer(runtime: ConnectorRuntime): void {
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
}

function schedule(runtime: ConnectorRuntime, delayMs: number): void {
  stopTimer(runtime);
  if (!initialized || !runtime.config.enabled) return;
  // 旧 runtime 被保存/删除替换后，它的在途轮次不能再排下一轮
  if (runtimes.get(runtime.config.id) !== runtime) return;
  const delay = Math.max(1_000, Math.trunc(delayMs));
  setStatus(runtime.config.id, {
    nextSyncAt: new Date(Date.now() + delay).toISOString(),
  });
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    void poll(runtime, false);
  }, delay);
  runtime.timer.unref?.();
}

function baseDelay(runtime: ConnectorRuntime): number {
  const seconds =
    runtime.config.pollIntervalSec && runtime.config.pollIntervalSec > 0
      ? runtime.config.pollIntervalSec
      : DEFAULT_POLL_SEC;
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.max(MIN_RETRY_MS, Math.round(seconds * 1000 * jitter));
}

function backoffDelay(runtime: ConnectorRuntime): number {
  const base = baseDelay(runtime) * Math.pow(2, runtime.failCount);
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.round(base)));
}

function startRuntime(runtime: ConnectorRuntime): void {
  stopTimer(runtime);
  if (!runtime.config.enabled) {
    setStatus(runtime.config.id, { state: "disabled", lastError: undefined });
    return;
  }
  if (!runtime.token) {
    setStatus(runtime.config.id, {
      state: "needs_auth",
      lastError: runtime.config.tokenCipher
        ? "凭证无法解密，请重新填写 Token"
        : "请填写 Token",
    });
    return;
  }
  setStatus(runtime.config.id, { state: "idle", lastError: undefined });
  schedule(runtime, FIRST_POLL_DELAY_MS);
}

async function pushSnapshot(
  config: StoredConnector,
  items: ExternalNotification[],
  complete: boolean,
): Promise<boolean> {
  // 退出中/未初始化：不要再触发 sidecar spawn 或写入
  if (!initialized) return false;
  const keepReadKeys = selfActivityKeysFor(config.provider);
  try {
    const line = await piRequestInternal({
      payload: {
        type: "inbox_external_sync",
        provider: config.provider,
        connectorId: config.id,
        items,
        complete,
        ...(keepReadKeys.length > 0 ? { keepReadKeys } : {}),
      },
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    const parsed = JSON.parse(line) as {
      type?: string;
      errorText?: string;
    };
    if (parsed.type === "error") {
      throw new Error(parsed.errorText || "收件箱同步失败");
    }
    return true;
  } catch (error) {
    logWarn(
      `[inbox-connectors] push ${config.provider}/${config.id} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

async function commitSnapshot(
  runtime: ConnectorRuntime,
  result: ConnectorFetchResult,
): Promise<{ added: number; pushed: boolean }> {
  // 保存新配置/删除连接器会替换或移除 runtime；旧轮询的结果必须丢弃，
  // 否则旧 Token 的成功/失败会覆盖新状态，并排出一个继续用旧配置的定时器。
  if (runtimes.get(runtime.config.id) !== runtime) {
    return { added: 0, pushed: false };
  }
  const { config } = runtime;
  const keys = result.items.map(itemKey);
  const keySet = new Set(keys);
  const newItems = result.items.filter(
    (item) => !runtime.seenKeys.has(itemKey(item)),
  );
  const added = newItems.length;
  const pushed = await pushSnapshot(config, result.items, result.complete);
  runtime.lastItems = result.items;
  runtime.lastComplete = result.complete;

  if (!pushed) {
    setStatus(config.id, {
      state: "idle",
      lastError: "收件箱还未就绪，稍后自动重试",
      itemCount: result.items.length,
    });
    schedule(runtime, MIN_RETRY_MS);
    return { added, pushed: false };
  }

  const actionableNew = newItems.filter(
    (item) => item.requiresAction === true,
  );
  if (
    runtime.primed &&
    config.desktopNotifications !== false &&
    actionableNew.length > 0
  ) {
    notifyNewExternalItems(config.provider, actionableNew, config);
  }

  runtime.primed = true;
  runtime.seenKeys = keySet;
  runtime.lastSyncAt = new Date().toISOString();
  runtime.failCount = 0;
  if (result.accountName) {
    runtime.accountName = result.accountName;
    // Jira 的 account 是 Basic 认证用的邮箱，不能被展示名覆盖；
    // 其余平台的 account 只是展示用，可以随探测结果更新。
    if (config.provider !== "jira") {
      runtime.config = { ...runtime.config, account: result.accountName };
      setConnectorAccount(config.id, result.accountName);
    }
  }
  setStatus(config.id, {
    state: "ok",
    lastSyncAt: runtime.lastSyncAt,
    lastError: undefined,
    itemCount: result.items.length,
    accountName: result.accountName ?? runtime.accountName ?? config.account,
  });
  logInfo(
    `[inbox-connectors] ${config.provider}/${config.id} synced items=${result.items.length} added=${added} complete=${result.complete}`,
  );
  schedule(runtime, baseDelay(runtime));
  return { added, pushed: true };
}

async function poll(
  runtime: ConnectorRuntime,
  manual: boolean,
): Promise<InboxConnectorSyncResult> {
  const { config } = runtime;
  if (runtime.inflight) {
    return {
      status: statusOf(config.id),
      added: 0,
      items: runtime.lastItems.length,
    };
  }
  if (!runtime.token) {
    setStatus(config.id, {
      state: "needs_auth",
      lastError: config.tokenCipher
        ? "凭证无法解密，请重新填写 Token"
        : "请填写 Token",
    });
    return { status: statusOf(config.id), added: 0, items: 0 };
  }
  if (manual) runtime.failCount = 0;
  runtime.inflight = true;
  setStatus(config.id, { state: "syncing", lastError: undefined });
  try {
    const adapter = adapterFor(config.provider);
    const result = await adapter.fetch({
      config: runtime.config,
      token: runtime.token,
      http: electronHttp,
    });
    const committed = await commitSnapshot(runtime, result);
    return {
      status: statusOf(config.id),
      added: committed.added,
      items: result.items.length,
    };
  } catch (error) {
    // 旧 runtime 的失败同样不能写状态/排重试
    if (runtimes.get(config.id) !== runtime) {
      return {
        status: statusOf(config.id),
        added: 0,
        items: runtime.lastItems.length,
      };
    }
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapterFor(config.provider).label);
    runtime.failCount += 1;
    if (failure.code === "auth") {
      setStatus(config.id, {
        state: "needs_auth",
        lastError: failure.message,
      });
      logWarn(
        `[inbox-connectors] ${config.provider}/${config.id} needs auth: ${failure.message}`,
      );
      // 不自动重试：等用户更新 Token 或手动同步
      stopTimer(runtime);
      return {
        status: statusOf(config.id),
        added: 0,
        items: runtime.lastItems.length,
      };
    }
    const retryIn =
      failure.code === "rate_limit" && failure.retryAfterMs
        ? Math.max(MIN_RETRY_MS, failure.retryAfterMs)
        : backoffDelay(runtime);
    setStatus(config.id, {
      state: "error",
      lastError: failure.message,
      nextSyncAt: new Date(Date.now() + retryIn).toISOString(),
    });
    logWarn(
      `[inbox-connectors] ${config.provider}/${config.id} failed (${failure.code}), retry in ${Math.round(retryIn / 1000)}s: ${failure.message}`,
    );
    if (config.enabled) schedule(runtime, retryIn);
    return {
      status: statusOf(config.id),
      added: 0,
      items: runtime.lastItems.length,
    };
  } finally {
    runtime.inflight = false;
  }
}

function findRuntime(id: string): ConnectorRuntime | null {
  return runtimes.get(id) ?? null;
}

/** sidecar 换代/恢复后补推最近一次快照与待清理项。 */
async function flushSnapshots(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const runtime of runtimes.values()) {
    if (runtime.lastItems.length === 0) continue;
    tasks.push(
      pushSnapshot(runtime.config, runtime.lastItems, runtime.lastComplete),
    );
  }
  for (const [key, clear] of pendingClears) {
    tasks.push(
      pushSnapshot(
        {
          id: clear.connectorId,
          provider: clear.provider as StoredConnector["provider"],
          enabled: false,
        },
        [],
        true,
      ).then((ok) => {
        if (ok) pendingClears.delete(key);
      }),
    );
  }
  if (tasks.length > 0) await Promise.allSettled(tasks);
}

export function initInboxConnectors(): void {
  if (initialized) return;
  initialized = true;
  statuses = loadStoredStatuses();
  runtimes = new Map();
  for (const config of loadStoredConnectors()) {
    const runtime = createRuntime(config);
    runtimes.set(config.id, runtime);
    startRuntime(runtime);
  }
  resumeHandler = () => {
    for (const runtime of runtimes.values()) {
      if (!runtime.config.enabled || !runtime.token) continue;
      stopTimer(runtime);
      void poll(runtime, false);
    }
  };
  try {
    powerMonitor.on("resume", resumeHandler);
  } catch {
    // 非桌面/测试环境没有 powerMonitor
  }
  setSidecarLifecycleListener({
    onSpawn: () => {
      void flushSnapshots();
    },
  });
  broadcast();
  logInfo(`[inbox-connectors] initialized connectors=${runtimes.size}`);
}

export function stopInboxConnectors(): void {
  if (!initialized) return;
  initialized = false;
  for (const runtime of runtimes.values()) stopTimer(runtime);
  runtimes.clear();
  if (resumeHandler) {
    try {
      powerMonitor.removeListener("resume", resumeHandler);
    } catch {
      /* ignore */
    }
    resumeHandler = null;
  }
  setSidecarLifecycleListener(null);
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistStoredStatuses(statuses);
}

export function listInboxConnectors(): InboxConnectorSnapshot {
  return snapshot();
}

export function saveInboxConnector(
  input: InboxConnectorSaveInput,
): InboxConnectorSnapshot {
  const stored = upsertConnector(input);
  const prev = runtimes.get(stored.id);
  if (prev) stopTimer(prev);
  const runtime = createRuntime(stored);
  runtimes.set(stored.id, runtime);
  startRuntime(runtime);

  // 新建/换 Token 时顺手探测账号名；失败不阻断保存
  const shouldProbe = Boolean(input.token?.trim()) || !stored.account;
  if (shouldProbe) {
    void (async () => {
      try {
        const adapter = adapterFor(stored.provider);
        const token = tokenOf(stored);
        if (!token) return;
        const result = await adapter.test({
          config: stored,
          token,
          http: electronHttp,
        });
        if (result.accountName) {
          runtime.accountName = result.accountName;
          // 同 commitSnapshot：Jira 的 account 必须是登录邮箱
          if (stored.provider !== "jira") {
            runtime.config = { ...runtime.config, account: result.accountName };
            setConnectorAccount(stored.id, result.accountName);
          }
          setStatus(stored.id, { accountName: result.accountName });
        }
      } catch {
        // 探测失败交给正式 poll 把错误显示在卡片上
      }
    })();
  }
  broadcast();
  return snapshot();
}

/** 通知偏好更新：同步运行时配置，下一次轮询/通知立即生效。 */
export function updateInboxConnectorPrefs(
  input: InboxConnectorPrefsInput,
): InboxConnectorSnapshot {
  const stored = updateConnectorPrefs(input);
  const runtime = runtimes.get(stored.id);
  if (runtime) {
    runtime.config = {
      ...runtime.config,
      desktopNotifications: stored.desktopNotifications,
      mutedUntil: stored.mutedUntil,
      mutedSources: stored.mutedSources,
      notifyIssues: stored.notifyIssues,
      notifyPullRequests: stored.notifyPullRequests,
    };
  }
  broadcast();
  return snapshot();
}

export function deleteInboxConnector(id: string): InboxConnectorSnapshot {
  const existing = loadStoredConnectors().find((item) => item.id === id);
  const runtime = runtimes.get(id);
  if (runtime) {
    stopTimer(runtime);
    runtimes.delete(id);
  }
  deleteConnector(id);
  delete statuses[id];
  schedulePersist();
  if (existing) {
    void pushSnapshot({ ...existing, enabled: false }, [], true).then((ok) => {
      if (!ok) {
        pendingClears.set(`${existing.provider}:${id}`, {
          provider: existing.provider,
          connectorId: id,
        });
      }
    });
  }
  broadcast();
  return snapshot();
}

export async function testInboxConnector(
  input: InboxConnectorTestInput,
): Promise<InboxConnectorTestResult> {
  const existing = loadStoredConnectors().find(
    (item) => item.id === input.id || item.provider === input.provider,
  );
  const token = input.token?.trim() || (existing ? tokenOf(existing) : null);
  if (!token) {
    return { ok: false, message: "请填写 Token" };
  }
  const config: StoredConnector = {
    id: input.id || existing?.id || input.provider,
    provider: input.provider,
    enabled: true,
    ...(input.baseUrl !== undefined
      ? { baseUrl: input.baseUrl }
      : existing?.baseUrl
        ? { baseUrl: existing.baseUrl }
        : {}),
    ...(input.account !== undefined
      ? { account: input.account }
      : existing?.account
        ? { account: existing.account }
        : {}),
    ...(input.authMode
      ? { authMode: input.authMode }
      : existing?.authMode
        ? { authMode: existing.authMode }
        : {}),
    ...(input.jql !== undefined
      ? { jql: input.jql }
      : existing?.jql
        ? { jql: existing.jql }
        : {}),
    ...(existing?.events ? { events: existing.events } : {}),
    pollIntervalSec: existing?.pollIntervalSec,
    desktopNotifications: existing?.desktopNotifications,
  };
  try {
    const adapter = adapterFor(input.provider);
    const result = await adapter.test({
      config,
      token,
      http: electronHttp,
    });
    return {
      ok: true,
      ...(result.accountName ? { accountName: result.accountName } : {}),
      ...(result.itemCount !== undefined
        ? { itemCount: result.itemCount }
        : {}),
    };
  } catch (error) {
    const failure =
      error instanceof ConnectorError
        ? error
        : asNetworkError(error, adapterFor(input.provider).label);
    return { ok: false, message: failure.message };
  }
}

export async function syncInboxConnector(
  id: string,
): Promise<InboxConnectorSyncResult> {
  let runtime = findRuntime(id);
  if (!runtime) {
    const config = loadStoredConnectors().find((item) => item.id === id);
    if (!config) {
      throw new ConnectorError("config", "连接器不存在");
    }
    runtime = createRuntime(config);
    runtimes.set(id, runtime);
  }
  return poll(runtime, true);
}

/** 设置页展示用：公开快照（token 已剥离）。 */
export function publicInboxConnectorConfig(
  id: string,
): ReturnType<typeof publicConfig> | null {
  const config = loadStoredConnectors().find((item) => item.id === id);
  return config ? publicConfig(config) : null;
}
