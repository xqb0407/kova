/**
 * 事件触发的 watcher 运行时（L1b）：文件变更 watch + git commit 轮询。
 *
 * 触发源在 Electron main（窗口/进程生命周期在此），执行仍走 automation：
 * 每条事件经 trigger-rpc（生产 host RPC / dev 协议）交给调度器
 * runWithContext，复用并发闸/runHistory/无人值守策略。
 * 触发器的定义事实源在 sidecar（triggers.json）。
 *
 * 关键纪律（docs/event-triggers-headless.md §4.2/§4.3）：
 * - 文件 watch 根限定当前 workspace，glob 只支持 * / ** / ?；
 * - 防抖聚合：窗口内多事件合并成一次触发，摘要列变更文件（≤5 + …N more）；
 * - agent 自身产物忽略（.kova/**）；同任务运行期间跳过，避免自触循环；
 * - git 不装真实 watcher（.git 变化不可靠），30s 轮询 HEAD。
 */
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { logInfo, logWarn } from "./logging";
import { isAutomationTaskRunning } from "./automation-service";
import { fireHostTrigger, listHostTriggers } from "./trigger-rpc";
import {
  globToRegExp,
  isIgnored,
  isWithin,
  matchesAny,
  summarizeChangedFiles,
  toPosixRelative,
  watchRootFor,
} from "./trigger-glob";

const GIT_POLL_MS = 30_000;
const FILE_DEBOUNCE_DEFAULT_MS = 2_000;
/** 运行期间挂起窗口：触发后这段时间内的同源事件不重复触发 */
const RUN_COOLDOWN_MS = 5_000;

type FileTriggerConfig = {
  paths: string[];
  events?: Array<"change" | "add" | "unlink">;
  debounceMs?: number;
};
type GitTriggerConfig = { cwd: string; branch?: string };
type Trigger = {
  id: string;
  type: "webhook" | "file" | "git" | "im";
  taskId: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

type FileWatchEntry = {
  trigger: Trigger;
  /** 每根一个 watcher（Node 的 watch 句柄不可合并） */
  watchers: FSWatcher[];
  /** 防抖 timer */
  timer?: ReturnType<typeof setTimeout>;
  /** 窗口内累积的变更文件 */
  pending: Set<string>;
};

type GitWatchEntry = {
  trigger: Trigger;
  timer: ReturnType<typeof setInterval>;
  /** 上次已知 HEAD（null = 尚未读到） */
  lastHead: string | null;
};

const fileEntries = new Map<string, FileWatchEntry>();
const gitEntries = new Map<string, GitWatchEntry>();
/** triggerId → 冷却截止（触发后短暂挂起，防自触） */
const cooldownUntil = new Map<string, number>();
/**
 * 配置级 setup 警告去重：watch 根不存在/不是 git 仓库这类问题每 30s 都会
 * 重试（目录后来建好就能自动生效），但日志不能每轮刷一遍。
 * key = triggerId + workspace + 序列化配置；配置改了会重新提示。
 */
const warnedSetupKeys = new Set<string>();
function warnSetupKey(trigger: Trigger, workspace: string | null, message: string): void {
  const key = `${trigger.id}\u0000${workspace ?? ""}\u0000${JSON.stringify(trigger.config)}`;
  if (warnedSetupKeys.has(key)) return;
  if (warnedSetupKeys.size > 500) warnedSetupKeys.clear();
  warnedSetupKeys.add(key);
  logWarn(message);
}

/* ------------------------------ 触发执行 ------------------------------ */

async function fireTrigger(trigger: Trigger, summary: string): Promise<void> {
  // 同任务正在跑：agent 自己写工作区文件不算事件（防自触循环）。
  // 静默跳过：运行期间每 2s 一次的事件不该刷屏日志。
  if (isAutomationTaskRunning(trigger.taskId)) return;
  const now = Date.now();
  const until = cooldownUntil.get(trigger.id) ?? 0;
  if (now < until) return;
  cooldownUntil.set(trigger.id, now + RUN_COOLDOWN_MS);
  try {
    const task = await fireHostTrigger(trigger.taskId, {
      type: trigger.type,
      id: trigger.id,
      summary,
    });
    if (!task) {
      logWarn(`[triggers] task not found for trigger ${trigger.id}`);
      return;
    }
    logInfo(`[triggers] fired ${trigger.type} trigger ${trigger.id}: ${summary.slice(0, 120)}`);
  } catch (err) {
    logWarn(`[triggers] fire failed (${trigger.id}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------ 文件 watch ------------------------------ */

function setupFileTrigger(workspace: string, trigger: Trigger): void {
  const cfg = trigger.config as unknown as FileTriggerConfig;
  const paths = Array.isArray(cfg.paths) ? cfg.paths.filter((p) => typeof p === "string") : [];
  if (paths.length === 0) return;
  const regexps = paths.map(globToRegExp);
  // 安全：watch 根必须落在 workspace 内（绝对路径/`..` 逃逸直接丢弃）
  const roots = [...new Set(paths.map((p) => watchRootFor(workspace, p)))].filter((r) => {
    if (isWithin(workspace, r)) return true;
    warnSetupKey(trigger, workspace, `[triggers] file trigger ${trigger.id}: ignore path outside workspace: ${r}`);
    return false;
  }).filter((r) => existsSync(r));
  if (roots.length === 0) {
    warnSetupKey(trigger, workspace, `[triggers] file trigger ${trigger.id}: no existing watch root`);
    return;
  }
  const debounceMs =
    typeof cfg.debounceMs === "number" && cfg.debounceMs > 0
      ? Math.min(cfg.debounceMs, 60_000)
      : FILE_DEBOUNCE_DEFAULT_MS;

  // 多根共享一个防抖窗口；Node 的 watch 句柄不可合并，逐根起
  const entry: FileWatchEntry = {
    trigger,
    watchers: [],
    pending: new Set(),
  };

  const watchers: FSWatcher[] = [];
  const onEvent = (event: "change" | "add" | "unlink", abs: string): void => {
    const relPosix = toPosixRelative(workspace, abs);
    if (!relPosix || isIgnored(relPosix)) return;
    if (!matchesAny(regexps, relPosix)) return;
    const wanted = cfg.events ?? ["change", "add"];
    if (!wanted.includes(event)) return;
    entry.pending.add(abs);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const changed = new Set(entry.pending);
      entry.pending.clear();
      entry.timer = undefined;
      if (changed.size > 0) void fireTrigger(trigger, summarizeChangedFiles(workspace, changed));
    }, debounceMs);
    entry.timer.unref?.();
  };

  for (const root of roots) {
    try {
      const w = watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const abs = join(root, String(filename));
        const kind =
          eventType === "rename"
            ? existsSync(abs)
              ? "add"
              : "unlink"
            : "change";
        onEvent(kind, abs);
      });
      w.on("error", (err) => logWarn(`[triggers] watch error (${trigger.id}): ${String(err)}`));
      watchers.push(w);
    } catch (err) {
      warnSetupKey(
        trigger,
        workspace,
        `[triggers] watch failed for ${root}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (watchers.length === 0) return;
  entry.watchers = watchers;
  fileEntries.set(trigger.id, entry);
}

function teardownFileTrigger(id: string): void {
  const entry = fileEntries.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  for (const w of entry.watchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  fileEntries.delete(id);
}

/* ------------------------------ git 轮询 ------------------------------ */

function readHead(cwd: string, branch?: string): string | null {
  try {
    const gitDir = join(cwd, ".git");
    if (!existsSync(gitDir)) return null;
    // 只读 refs：分支缺省用 HEAD 符号引用目标
    if (branch) {
      const ref = join(gitDir, "refs", "heads", branch);
      if (!existsSync(ref)) return null;
      return readFileSync(ref, "utf8").trim();
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: ")) {
      const ref = join(gitDir, ...head.slice(5).trim().split("/"));
      return existsSync(ref) ? readFileSync(ref, "utf8").trim() : null;
    }
    return head || null;
  } catch {
    return null;
  }
}

function setupGitTrigger(workspace: string | null, trigger: Trigger): void {
  const cfg = trigger.config as unknown as GitTriggerConfig;
  const rawCwd = typeof cfg.cwd === "string" ? cfg.cwd.trim() : "";
  // 相对路径按当前工作区解析（UI 的"留空 = 当前工作区"也落到这里）
  const cwd = rawCwd
    ? isAbsolute(rawCwd)
      ? rawCwd
      : workspace
        ? resolve(workspace, rawCwd)
        : ""
    : "";
  if (!cwd || !existsSync(join(cwd, ".git"))) {
    warnSetupKey(trigger, workspace, `[triggers] git trigger ${trigger.id}: not a git repo: ${rawCwd}`);
    return;
  }
  // worktree/submodule 的 .git 是文件（指向实际 gitdir）：本版只读 <repo>/.git/HEAD，
  // 不解析 gitdir 指针——明确告知而不是静默永不触发
  try {
    if (statSync(join(cwd, ".git")).isFile()) {
      warnSetupKey(
        trigger,
        workspace,
        `[triggers] git trigger ${trigger.id}: worktree/submodule not supported: ${cwd}`,
      );
      return;
    }
  } catch {
    return;
  }
  const initial = readHead(cwd, cfg.branch);
  if (cfg.branch && !initial) {
    // 分支可能还没建：保留轮询，出现后自动接上基线（首次读到只记基线不触发）
    logWarn(`[triggers] git trigger ${trigger.id}: branch not found yet: ${cfg.branch}`);
  }
  const entry: GitWatchEntry = {
    trigger,
    timer: setInterval(() => {
      const head = readHead(cwd, cfg.branch);
      if (!head) return;
      if (entry.lastHead && head !== entry.lastHead) {
        void fireTrigger(trigger, `git commit ${head.slice(0, 8)}`);
      }
      entry.lastHead = head;
    }, GIT_POLL_MS),
    lastHead: initial,
  };
  entry.timer.unref?.();
  gitEntries.set(trigger.id, entry);
}

function teardownGitTrigger(id: string): void {
  const entry = gitEntries.get(id);
  if (!entry) return;
  clearInterval(entry.timer);
  gitEntries.delete(id);
}

/* ------------------------------ 同步入口 ------------------------------ */

let syncChain: Promise<void> = Promise.resolve();
let resyncTimer: ReturnType<typeof setInterval> | undefined;
let currentWorkspace: string | null = null;
/** 退出后，仍在 await 的旧 sync 不能再把 watcher 建回来 */
let runtimeActive = false;

/**
 * 启动 watcher 运行时（index ready 后调用）：立即同步 + 30s 周期重同步。
 * 周期重同步是刻意选择：触发器写路径在 sidecar（UI 直接发给 sidecar），
 * main 看不到变更；每 30s 拉一次清单的成本远低于引入一条新的广播帧协议。
 */
export function startTriggerWatchers(workspace: string | null): void {
  runtimeActive = true;
  currentWorkspace = workspace;
  void syncTriggerWatchers();
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = setInterval(() => {
    void syncTriggerWatchers();
  }, GIT_POLL_MS);
  resyncTimer.unref?.();
}

/** 工作区切换：换 watch 根（旧 watcher 全拆；配置签名不含 workspace，
 *  不拆的话同配置的 file/git watcher 会继续盯旧目录） */
export function setTriggerWorkspace(workspace: string | null): void {
  if (workspace === currentWorkspace) return;
  currentWorkspace = workspace;
  for (const id of [...fileEntries.keys()]) teardownFileTrigger(id);
  for (const id of [...gitEntries.keys()]) teardownGitTrigger(id);
  void syncTriggerWatchers();
}

/**
 * UI 改触发器后的就近重同步（30s 周期之外）：新建/删除/开关后让 watcher
 * 立刻跟上，避免"刚加的 file 触发器要等半分钟才生效"。
 */
export function resyncTriggerWatchers(): Promise<void> {
  return syncTriggerWatchers();
}

/**
 * 按 sidecar 的触发器清单重建 watcher（幂等）。触发器增删/开关/任务变更后
 * 调用；主进程可能多次并发触发（启动 + UI 变更），串行化避免抖动。
 *
 * 不传 workspace：执行时读 currentWorkspace。否则排队中的旧调用会拿着
 * 切换前的目录建 watcher，配置签名又相同 → 旧根被长期保留。
 */
export function syncTriggerWatchers(): Promise<void> {
  syncChain = syncChain.then(syncNow).catch((err) => {
    logWarn(`[triggers] sync failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return syncChain;
}

async function syncNow(): Promise<void> {
  // 执行时取最新 workspace（排队中的旧同步不能把旧根建回来）
  const workspace = currentWorkspace;
  let triggers: Trigger[] = [];
  try {
    triggers = await listHostTriggers();
  } catch (err) {
    logWarn(`[triggers] list failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!Array.isArray(triggers)) triggers = [];

  // 拉取期间进入退出流程：不能再建 watcher（stop 已拆过一轮）
  if (!runtimeActive) return;
  // 拉取期间工作区又切了：本次结果已过期，交给排队中的下一次同步重建
  // （setTriggerWorkspace 已全拆；这里再建旧根就没人拆得掉了）
  if (workspace !== currentWorkspace) return;

  const wantedFile = new Map<string, Trigger>();
  const wantedGit = new Map<string, Trigger>();
  for (const t of triggers) {
    if (!t.enabled) continue;
    if (t.type === "file") wantedFile.set(t.id, t);
    else if (t.type === "git") wantedGit.set(t.id, t);
  }

  // 拆除不再需要的
  for (const id of [...fileEntries.keys()]) if (!wantedFile.has(id)) teardownFileTrigger(id);
  for (const id of [...gitEntries.keys()]) if (!wantedGit.has(id)) teardownGitTrigger(id);

  // 新增/更新（配置变化 = 先拆再建）
  for (const [id, t] of wantedFile) {
    const existing = fileEntries.get(id);
    if (existing && !workspace) {
      teardownFileTrigger(id);
      continue;
    }
    const cfgSig = JSON.stringify(t.config);
    const existingSig = existing ? JSON.stringify(existing.trigger.config) : null;
    if (existing && existingSig !== cfgSig) teardownFileTrigger(id);
    if (!fileEntries.has(id) && workspace) setupFileTrigger(workspace, t);
  }
  for (const [id, t] of wantedGit) {
    const existing = gitEntries.get(id);
    const cfgSig = JSON.stringify(t.config);
    const existingSig = existing ? JSON.stringify(existing.trigger.config) : null;
    if (existing && existingSig !== cfgSig) teardownGitTrigger(id);
    if (!gitEntries.has(id)) setupGitTrigger(workspace, t);
  }
}

/** before-quit：全停（含待触发的防抖窗口与重同步 timer） */
export function stopTriggerWatchers(): void {
  runtimeActive = false;
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = undefined;
  for (const id of [...fileEntries.keys()]) teardownFileTrigger(id);
  for (const id of [...gitEntries.keys()]) teardownGitTrigger(id);
  cooldownUntil.clear();
}

/** 测试钩子：当前活跃 watcher 数 */
export function watcherCount(): { file: number; git: number } {
  return { file: fileEntries.size, git: gitEntries.size };
}
