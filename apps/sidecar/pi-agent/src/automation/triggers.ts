/**
 * 事件触发器（L1）：webhook / file / git / im 触发 → automation 任务。
 *
 * 职责边界：
 * - triggers.json 是唯一事实源（sidecar 单写者；Electron main 经
 *   hostAutomationRpc / 协议只读，见 trigger-rpc.ts）；
 * - 触发执行统一走 scheduler.runWithContext（host RPC 或协议入口），
 *   触发不放宽权限：run 走 automation 既有无人值守策略（policy.ts）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logErr } from "../log";

export type TriggerType = "webhook" | "file" | "git" | "im";

export type TriggerConfig =
  | {
      type: "webhook";
      /** HMAC 签名密钥（创建时生成；UI 可重置）。值不进日志/审计。 */
      secret: string;
    }
  | {
      type: "file";
      /** workspace 相对/绝对 glob（创建时校验在 workspace 内） */
      paths: string[];
      /** 监听的事件（缺省 change+add） */
      events?: Array<"change" | "add" | "unlink">;
      /** 防抖窗口毫秒（缺省 2000） */
      debounceMs?: number;
    }
  | {
      type: "git";
      /** 限定分支（缺省当前分支） */
      branch?: string;
      /** 工作目录（workspace 主目录） */
      cwd: string;
    }
  | {
      type: "im";
      /** 平台（wechat/feishu/...） */
      platform: string;
      /** 限定聊天 id（缺省任意私聊） */
      chatId?: string;
      /** 消息正则（源文本匹配） */
      pattern?: string;
    };

export type EventTrigger = {
  id: string;
  type: TriggerType;
  /** 触发哪个 automation 任务 */
  taskId: string;
  enabled: boolean;
  createdAt: string;
  config: TriggerConfig;
};

type TriggerFile = { version: 1; triggers: EventTrigger[] };

const MAX_TRIGGERS = 50;

export function triggersPath(): string {
  if (process.env.PI_TRIGGERS_PATH) return process.env.PI_TRIGGERS_PATH;
  const root = process.env.PI_SESSIONS_DIR;
  return join(root || join(process.env.HOME ?? ".", ".kova"), "automation", "triggers.json");
}

let cache: TriggerFile | null = null;
/** 文件戳（mtime+size）：跨进程可见性的关键——触发器由 pi-agent 写，
 *  automation 调度进程（webhook 验签/文件 watcher 的 list 来源）只读，
 *  不能永久缓存，否则新触发器要等进程重启才生效。 */
let cacheStamp: string | null = null;

function fileStamp(path: string): string | null {
  try {
    if (!existsSync(path)) return "";
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function load(): TriggerFile {
  const path = triggersPath();
  const stamp = fileStamp(path);
  // stat 失败（权限/瞬时）时退回旧缓存；null 不参与相等比较
  if (cache && (stamp === null || stamp === cacheStamp)) return cache;
  try {
    if (stamp) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        version?: unknown;
        triggers?: unknown;
      };
      if (parsed.version === 1 && Array.isArray(parsed.triggers)) {
        const triggers: EventTrigger[] = [];
        for (const raw of parsed.triggers.slice(0, MAX_TRIGGERS)) {
          const t = normalizeTrigger(raw);
          if (t) triggers.push(t);
        }
        cache = { version: 1, triggers };
        cacheStamp = stamp;
        return cache;
      }
    }
  } catch (err) {
    logErr("triggers: load failed:", err instanceof Error ? err.message : String(err));
  }
  cache = { version: 1, triggers: [] };
  cacheStamp = stamp;
  return cache;
}

function persist(): void {
  try {
    const path = triggersPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), "utf8");
    cacheStamp = fileStamp(path);
  } catch (err) {
    logErr("triggers: persist failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * workspace glob 形状校验：拒绝绝对路径与 `..` 段。
 * 这是 watch 根逃逸的第一道防线（真正起 watcher 前 main 还会按 workspace
 * 再验一次，见 trigger-glob.isWithin）。
 */
function isSafeGlobPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").trim();
  if (!norm) return false;
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return false;
  return !norm.split("/").includes("..");
}

/** 坏条目丢弃不炸文件（与 mcp-cache 同哲学） */
function normalizeTrigger(raw: unknown): EventTrigger | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 64) : "";
  const taskId = typeof r.taskId === "string" ? r.taskId.trim().slice(0, 64) : "";
  if (!id || !taskId || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  const type = r.type;
  if (type !== "webhook" && type !== "file" && type !== "git" && type !== "im") return null;
  const configRaw = (r.config ?? {}) as Record<string, unknown>;
  let config: TriggerConfig;
  if (type === "webhook") {
    const secret = typeof configRaw.secret === "string" ? configRaw.secret.trim() : "";
    if (!secret) return null;
    config = { type: "webhook", secret };
  } else if (type === "file") {
    const paths = Array.isArray(configRaw.paths)
      ? configRaw.paths
          .filter((v): v is string => typeof v === "string" && isSafeGlobPath(v))
          .map((v) => v.trim())
          .slice(0, 8)
      : [];
    if (paths.length === 0) return null;
    const events = Array.isArray(configRaw.events)
      ? configRaw.events.filter(
          (v): v is "change" | "add" | "unlink" =>
            v === "change" || v === "add" || v === "unlink",
        )
      : [];
    const debounceMs =
      typeof configRaw.debounceMs === "number" && Number.isFinite(configRaw.debounceMs)
        ? Math.min(Math.max(Math.floor(configRaw.debounceMs), 200), 60_000)
        : undefined;
    config = {
      type: "file",
      paths,
      ...(events.length > 0 ? { events } : {}),
      ...(debounceMs !== undefined ? { debounceMs } : {}),
    };
  } else if (type === "git") {
    const cwd = typeof configRaw.cwd === "string" ? configRaw.cwd.trim() : "";
    if (!cwd) return null;
    const branchRaw =
      typeof configRaw.branch === "string" && configRaw.branch.trim()
        ? configRaw.branch.trim()
        : "";
    // 分支名会拼进 .git/refs/heads/<branch>：只收常见字符，拒绝 .. 逃逸
    if (branchRaw && (!/^[A-Za-z0-9._/-]{1,120}$/.test(branchRaw) || branchRaw.includes(".."))) {
      return null;
    }
    config = { type: "git", cwd, ...(branchRaw ? { branch: branchRaw } : {}) };
  } else {
    const platform = typeof configRaw.platform === "string" ? configRaw.platform.trim() : "";
    if (!platform) return null;
    const chatId =
      typeof configRaw.chatId === "string" && configRaw.chatId.trim() ? configRaw.chatId.trim() : undefined;
    const pattern =
      typeof configRaw.pattern === "string" && configRaw.pattern.trim() ? configRaw.pattern.trim() : undefined;
    config = { type: "im", platform, ...(chatId ? { chatId } : {}), ...(pattern ? { pattern } : {}) };
  }
  return {
    id,
    type,
    taskId,
    enabled: r.enabled !== false,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    config,
  };
}

/** 生成 webhook HMAC 密钥（32 字节 hex；secret 只经本函数产生） */
export function generateWebhookSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

export function listTriggers(): EventTrigger[] {
  return load().triggers.map((t) => ({ ...t }));
}

export function getTrigger(id: string): EventTrigger | undefined {
  const t = load().triggers.find((x) => x.id === id);
  return t ? { ...t } : undefined;
}

/**
 * 保存触发器（新增或全量覆盖）。校验失败抛错不静默；taskId 必须指向已存在的
 * automation 任务（调用方传校验函数，避免本模块反向依赖 scheduler）。
 */
export async function saveTrigger(
  input: unknown,
  validateTask: (taskId: string) => boolean | Promise<boolean>,
): Promise<EventTrigger> {
  // 新建：先补 id（normalizeTrigger 要求 id 合法非空）
  const raw =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null;
  const withId =
    raw && !(typeof raw.id === "string" && raw.id.trim()) ? { ...raw, id: randomUUID() } : input;
  const t = normalizeTrigger(withId);
  if (!t) throw new Error("trigger: invalid trigger shape");
  if (t.config.type === "webhook") {
    // webhook secret 只由 generateWebhookSecret 产生：外部传入短 secret 的
    // 新建请求视为篡改（UI 流程是"创建后展示/重置"，不是"用户填写"）
    const existing = load().triggers.find((x) => x.id === t.id);
    if (!existing && t.config.secret.length < 32) {
      throw new Error("trigger: webhook secret must be generated, not supplied");
    }
  }
  if (!(await validateTask(t.taskId))) {
    throw new Error(`trigger: automation task not found: ${t.taskId}`);
  }
  const file = load();
  const idx = file.triggers.findIndex((x) => x.id === t.id);
  if (idx >= 0) {
    // 更新：webhook secret 保留原值（更新请求不带 secret 字段）
    const prev = file.triggers[idx]!;
    if (t.config.type === "webhook" && prev.config.type === "webhook") {
      t.config = { type: "webhook", secret: prev.config.secret };
    }
    file.triggers[idx] = t;
  } else {
    if (file.triggers.length >= MAX_TRIGGERS) {
      throw new Error(`trigger: trigger limit reached (${MAX_TRIGGERS})`);
    }
    file.triggers.push(t);
  }
  persist();
  return { ...t };
}

/** 重置 webhook 密钥（旧密钥立即失效）；非 webhook 抛错 */
export function regenerateTriggerSecret(id: string): { secret: string } {
  const file = load();
  const idx = file.triggers.findIndex((x) => x.id === id);
  const t = file.triggers[idx];
  if (!t || t.type !== "webhook") {
    throw new Error("trigger: not a webhook trigger");
  }
  const secret = generateWebhookSecret();
  t.config = { type: "webhook", secret };
  persist();
  return { secret };
}

export function deleteTrigger(id: string): boolean {
  const file = load();
  const idx = file.triggers.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  file.triggers.splice(idx, 1);
  persist();
  return true;
}

export function setTriggerEnabled(id: string, enabled: boolean): EventTrigger | undefined {
  const file = load();
  const t = file.triggers.find((x) => x.id === id);
  if (!t) return undefined;
  t.enabled = enabled;
  persist();
  return { ...t };
}

/** 任务删除时清理悬挂触发器（automation_delete 路径调用） */
export function deleteTriggersForTask(taskId: string): number {
  const file = load();
  const before = file.triggers.length;
  file.triggers = file.triggers.filter((t) => t.taskId !== taskId);
  const removed = before - file.triggers.length;
  if (removed > 0) persist();
  return removed;
}

/** 测试钩子：清内存态（文件由测试自管） */
export function resetTriggersForTest(): void {
  cache = null;
  cacheStamp = null;
}
