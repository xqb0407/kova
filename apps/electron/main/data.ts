/**
 * pi-agent 业务数据层（对齐 data.rs 全量 host_query 契约）：
 * sessions / credentials / secrets / custom_providers / models / usage_daily /
 * usage_scan 的建表、迁移与 32 种 kind 的处理。SQL 与返回形状逐条对照源码。
 */
import { shell } from "electron";
import { join } from "node:path";
import { appDataDir } from "./paths";
import type { Db, Row } from "./db";
import { isMirroredKvKey } from "./credential-mirror-keys";
import { decrypt, encrypt, getSecretCipherBackend, isEncrypted } from "./secret";
import { libraryRoot } from "./library";
import { logWarn } from "./logging";
import { measureSync } from "./slow-ops";
import {
  initProjectTables,
  projectDelete,
  projectList,
  projectPurge,
  projectSave,
} from "./projects-db";

/* ------------------------------- 建表与迁移 ------------------------------- */

export function initTables(db: Db): void {
  // 旧表重命名（pi_ 前缀）：须在 CREATE 之前，避免新表挡住重命名
  tryRename(db, "ALTER TABLE pi_sessions RENAME TO sessions");
  tryRename(db, "ALTER TABLE pi_models RENAME TO models");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        first_message TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER,
        kind TEXT NOT NULL DEFAULT '',
        parent_session TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS credentials (
        provider TEXT PRIMARY KEY,
        api_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
        name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (name, scope)
    );
    CREATE TABLE IF NOT EXISTS custom_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        models TEXT NOT NULL DEFAULT '[]',
        api TEXT NOT NULL DEFAULT 'openai-chat',
        auto_discover INTEGER NOT NULL DEFAULT 0,
        headers TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS models (
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        name TEXT,
        reasoning INTEGER,
        context_window INTEGER,
        max_tokens INTEGER,
        input_json TEXT,
        cost_json TEXT,
        prompt_cache_json TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (provider, model_id)
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
        session_id TEXT NOT NULL,
        date TEXT NOT NULL,
        input INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        by_model TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (session_id, date)
    );
    CREATE TABLE IF NOT EXISTS usage_scan (
        session_id TEXT PRIMARY KEY,
        mtime REAL NOT NULL,
        first_ts INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_blocks (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS session_blocks_session
        ON session_blocks (session_id, seq);
    CREATE TABLE IF NOT EXISTS search_scan (
        session_id TEXT PRIMARY KEY,
        mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_blocks (
        session_id TEXT NOT NULL,
        rel TEXT NOT NULL,
        name TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (session_id, rel)
    );
    CREATE INDEX IF NOT EXISTS artifact_blocks_session
        ON artifact_blocks (session_id);
    CREATE TABLE IF NOT EXISTS artifact_scan (
        session_id TEXT PRIMARY KEY,
        mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_history (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_history_created
        ON search_history (created_at DESC);
    CREATE TABLE IF NOT EXISTS library_file_meta (
        root TEXT NOT NULL,
        rel TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (root, rel)
    );
    CREATE TABLE IF NOT EXISTS knowledge_refs (
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (session_id, source, scope_id, path)
    );
    CREATE INDEX IF NOT EXISTS knowledge_refs_path
        ON knowledge_refs (scope_id, path, ts DESC);
    CREATE INDEX IF NOT EXISTS knowledge_refs_session
        ON knowledge_refs (session_id, ts DESC);`);

  // 旧库补列（已存在则忽略）
  for (const sql of [
    "ALTER TABLE custom_providers ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-chat';",
    "ALTER TABLE custom_providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;",
    "ALTER TABLE custom_providers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';",
    "ALTER TABLE custom_providers ADD COLUMN auto_discover INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE models ADD COLUMN prompt_cache_json TEXT;",
    "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;",
    "ALTER TABLE sessions ADD COLUMN message_count INTEGER;",
    "ALTER TABLE sessions ADD COLUMN mode TEXT;",
    "ALTER TABLE sessions ADD COLUMN approval_level TEXT;",
    "ALTER TABLE sessions ADD COLUMN model_provider TEXT;",
    "ALTER TABLE sessions ADD COLUMN model_id TEXT;",
    "ALTER TABLE sessions ADD COLUMN thinking_level TEXT;",
    "ALTER TABLE sessions ADD COLUMN design_theme TEXT;",
    "ALTER TABLE sessions ADD COLUMN app_mode TEXT;",
    "ALTER TABLE sessions ADD COLUMN goal_max_turns TEXT;",
    "ALTER TABLE sessions ADD COLUMN goal_acceptance_mode TEXT;",
    "ALTER TABLE sessions ADD COLUMN goal_max_duration TEXT;",
    // 辅助会话：kind = "side_chat" 的子会话不进主列表；parent_session 是派生来源
    "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE sessions ADD COLUMN parent_session TEXT NOT NULL DEFAULT '';",
    // 归档时刻：检查点卡 GC 按「归档满 N 天」判断（旧行为用最后活动时间，
    // 刚归档但长期未用的会话会被误清）；旧数据为 NULL，GC 时保守回退
    "ALTER TABLE sessions ADD COLUMN archived_at TEXT;",
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* 列已存在 */
    }
  }

  // 早期版本把未选目录的会话 cwd 存成主目录：统一清空
  const home = homeDir();
  if (home) {
    try {
      db.prepare("UPDATE sessions SET cwd = '' WHERE cwd = ?1").run(home);
    } catch {
      /* ignore */
    }
  }

  migrateAzureProviderId(db);
  migrateCustomProviderModels(db);
  migrateProviderModelFilters(db);
  // 旧表 drain 必须在项目迁移之前：从 pi_sessions 升上来的会话也要参与
  // project_id 回填，否则它们永远为 NULL、只能按 cwd 猜归属。
  drainLegacyTable(db, "pi_sessions", "sessions", "id, title, first_message, cwd, created_at, updated_at");
  drainLegacyTable(
    db,
    "pi_models",
    "models",
    "provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled",
  );

  // 项目实体/目录表 + sessions.project_id + 旧 pi.projectDirs 迁移。
  // 放在会话 cwd 归一与旧表 drain 之后，保证所有历史会话都能回填。
  initProjectTables(db);
}

function tryRename(db: Db, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    /* 旧表不存在等，忽略（对齐 Rust let _ =） */
  }
}

function homeDir(): string | undefined {
  const v = process.env.USERPROFILE ?? process.env.HOME;
  return v && v.length > 0 ? v : undefined;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1")
    .get(name) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

const LEGACY_AZURE_PROVIDER = "azure-openai-responses";
const AZURE_PROVIDER = "azure";

/**
 * pi-ai 1.0.3 把 Azure provider id 从 `azure-openai-responses` 改为 `azure`。
 * 迁移所有 provider-keyed 数据，保证升级后 Azure 凭据/模型过滤/会话选择不丢。
 * 分步 try/catch：某一步失败不阻塞其它步骤；读时别名仍可兜底。
 */
function migrateAzureProviderId(db: Db): void {
  const step = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      logWarn(`[data] azure provider migration step "${label}" failed: ${e}`);
    }
  };

  step("credentials", () => {
    const old = db
      .prepare("SELECT api_key, updated_at FROM credentials WHERE provider = ?1")
      .get(LEGACY_AZURE_PROVIDER);
    if (!old) return;
    const existing = db
      .prepare("SELECT provider FROM credentials WHERE provider = ?1")
      .get(AZURE_PROVIDER);
    if (!existing) {
      db.prepare("UPDATE credentials SET provider = ?1 WHERE provider = ?2").run(
        AZURE_PROVIDER,
        LEGACY_AZURE_PROVIDER,
      );
    } else {
      // 新行已存在：保留新行，旧行只补空字段后删除
      db.prepare("DELETE FROM credentials WHERE provider = ?1").run(
        LEGACY_AZURE_PROVIDER,
      );
    }
  });

  step("models", () => {
    const rows = db
      .prepare(
        "SELECT model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled FROM models WHERE provider = ?1",
      )
      .all(LEGACY_AZURE_PROVIDER);
    for (const row of rows) {
      const modelId = String(row.model_id ?? "");
      if (!modelId) continue;
      const existing = db
        .prepare("SELECT provider FROM models WHERE provider = ?1 AND model_id = ?2")
        .get(AZURE_PROVIDER, modelId);
      if (!existing) {
        db.prepare(
          "UPDATE models SET provider = ?1 WHERE provider = ?2 AND model_id = ?3",
        ).run(AZURE_PROVIDER, LEGACY_AZURE_PROVIDER, modelId);
        continue;
      }
      // 冲突安全合并：保留新行非空值，旧行只补空；enabled 取并集
      db.prepare(
        `UPDATE models SET
           name = COALESCE(name, ?1),
           reasoning = COALESCE(reasoning, ?2),
           context_window = COALESCE(context_window, ?3),
           max_tokens = COALESCE(max_tokens, ?4),
           input_json = COALESCE(input_json, ?5),
           cost_json = COALESCE(cost_json, ?6),
           enabled = MAX(enabled, ?7)
         WHERE provider = ?8 AND model_id = ?9`,
      ).run(
        row.name ?? null,
        row.reasoning ?? null,
        row.context_window ?? null,
        row.max_tokens ?? null,
        row.input_json ?? null,
        row.cost_json ?? null,
        row.enabled ?? 1,
        AZURE_PROVIDER,
        modelId,
      );
      db.prepare("DELETE FROM models WHERE provider = ?1 AND model_id = ?2").run(
        LEGACY_AZURE_PROVIDER,
        modelId,
      );
    }
  });

  step("sessions", () => {
    db.prepare("UPDATE sessions SET model_provider = ?1 WHERE model_provider = ?2").run(
      AZURE_PROVIDER,
      LEGACY_AZURE_PROVIDER,
    );
  });

  step("kv", () => {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'pi.model'").get();
    const raw = typeof row?.value === "string" ? row.value : "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { provider?: string; modelId?: string };
        if (parsed?.provider === LEGACY_AZURE_PROVIDER) {
          db.prepare("UPDATE kv SET value = ?1 WHERE key = 'pi.model'").run(
            JSON.stringify({ ...parsed, provider: AZURE_PROVIDER }),
          );
        }
      } catch {
        /* 坏 JSON：保留原值，读时别名兜底 */
      }
    }
    const oldKey = `credential.env.${LEGACY_AZURE_PROVIDER}`;
    const newKey = `credential.env.${AZURE_PROVIDER}`;
    const oldEnv = db.prepare("SELECT value FROM kv WHERE key = ?1").get(oldKey);
    if (!oldEnv) return;
    const newEnv = db.prepare("SELECT value FROM kv WHERE key = ?1").get(newKey);
    if (!newEnv) {
      db.prepare("UPDATE kv SET key = ?1 WHERE key = ?2").run(newKey, oldKey);
    } else {
      db.prepare("DELETE FROM kv WHERE key = ?1").run(oldKey);
    }
  });
}

function migrateCustomProviderModels(db: Db): void {
  let rows: { id: string; models: string }[];
  try {
    rows = db.prepare("SELECT id, models FROM custom_providers WHERE models != '[]'").all() as any;
  } catch (e) {
    logWarn(`[data] read custom_providers for model migration failed: ${e}`);
    return;
  }
  for (const { id, models } of rows) {
    let specs: any[] = [];
    try {
      specs = JSON.parse(models);
    } catch {
      specs = [];
    }
    for (const spec of specs) {
      const modelId = strOrNull(spec?.id);
      if (!modelId || !modelId.trim()) continue;
      db.prepare(
        `INSERT OR REPLACE INTO models
         (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        id,
        modelId,
        strOrNull(spec?.name),
        typeof spec?.reasoning === "boolean" ? spec.reasoning : null,
        numOrNull(spec?.contextWindow),
        numOrNull(spec?.maxTokens),
        Array.isArray(spec?.input) ? JSON.stringify(spec.input) : null,
        spec?.cost && typeof spec.cost === "object" ? JSON.stringify(spec.cost) : null,
      );
    }
    db.prepare("UPDATE custom_providers SET models = '[]' WHERE id = ?1").run(id);
  }
}

function migrateProviderModelFilters(db: Db): void {
  if (!tableExists(db, "provider_models")) return;
  let rows: { provider: string; models: string }[];
  try {
    rows = db
      .prepare(
        `SELECT provider, models FROM provider_models
         WHERE models != '[]' AND provider NOT IN (SELECT DISTINCT provider FROM models)`,
      )
      .all() as any;
  } catch {
    return;
  }
  for (const { provider, models } of rows) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(models);
    } catch {
      ids = [];
    }
    for (const modelId of ids) {
      if (!String(modelId).trim()) continue;
      try {
        db.prepare("INSERT OR IGNORE INTO models (provider, model_id, enabled) VALUES (?, ?, 1)").run(provider, String(modelId));
      } catch {
        /* 单条失败跳过（对齐 filter_map(ok)） */
      }
    }
  }
  try {
    db.exec("DROP TABLE provider_models");
  } catch {
    /* ignore */
  }
}

function drainLegacyTable(db: Db, legacy: string, target: string, columns: string): void {
  if (!tableExists(db, legacy)) return;
  try {
    db.exec(`INSERT OR IGNORE INTO ${target} (${columns}) SELECT ${columns} FROM ${legacy}`);
    db.exec(`DROP TABLE ${legacy}`);
  } catch (e) {
    logWarn(`[data] drain ${legacy} failed: ${e}`);
  }
}

/* ------------------------------- 辅助函数 ------------------------------- */

export const MAX_SECRET_VALUE_BYTES = 8 * 1024;

export function isValidSecretName(name: string): boolean {
  if (name.length > 128) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function isValidSecretScope(scope: string): boolean {
  return scope === "global" || (scope.startsWith("workspace:") && scope.length > "workspace:".length);
}

/** 掩码规则与 provider key 一致：`****` + 后四位（码点计数，对齐 Rust chars()） */
function maskSecret(plain: string): string {
  const chars = Array.from(plain);
  if (chars.length > 4) return "****" + chars.slice(-4).join("");
  return "****";
}

function strParam(p: any, key: string): string {
  const v = p?.[key];
  if (typeof v !== "string") throw new Error(`missing param: ${key}`);
  return v;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** 全量/按 provider 读模型条目（input/cost/prompt_cache 已解析成对象）。
 *  除 host_query 消费外，credential-file-sync 的镜像导出也复用这份解析。 */
export function modelsQuery(db: Db, provider?: string): any[] {
  const sql = provider
    ? "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, prompt_cache_json, enabled FROM models WHERE provider = ?1 ORDER BY model_id"
    : "SELECT provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, prompt_cache_json, enabled FROM models ORDER BY provider, model_id";
  const rows = (provider ? db.prepare(sql).all(provider) : db.prepare(sql).all()) as Row[];
  return rows.map((r) => {
    let input: unknown = null;
    let cost: unknown = null;
    let promptCache: unknown = null;
    try {
      const parsed = JSON.parse(String(r.input_json));
      if (Array.isArray(parsed)) input = parsed;
    } catch {
      /* NULL/非法 = 无 */
    }
    try {
      const parsed = JSON.parse(String(r.cost_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cost = parsed;
    } catch {
      /* 同上 */
    }
    try {
      const parsed = JSON.parse(String(r.prompt_cache_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) promptCache = parsed;
    } catch {
      /* 同上 */
    }
    return {
      provider: r.provider,
      modelId: r.model_id,
      name: r.name ?? null,
      reasoning: r.reasoning === null || r.reasoning === undefined ? null : Number(r.reasoning) === 1,
      contextWindow: r.context_window ?? null,
      maxTokens: r.max_tokens ?? null,
      input,
      cost,
      promptCache,
      enabled: Number(r.enabled) === 1,
    };
  });
}

/* ------------------------------- host_query 分发 ------------------------------- */

/**
 * 对齐 dispatch_host_query：kind="tool" 不进 db 串行（长 bash 不阻塞其他查询——
 * Node 侧由 toolExec 自行异步处理），kind="open_external" 同为异步旁路
 * （宿主 shell.openExternal 开外链），其余 kind 同步走 handleHostQuery。
 * 返回 JSON 字符串（宿主对 sidecar 的 host_result 行）。
 */
export async function dispatchHostQuery(db: Db, msg: any): Promise<string> {
  const id = typeof msg?.id === "string" ? msg.id : "";
  let reply: unknown;
  try {
    const kind = msg?.kind;
    if (typeof kind !== "string") throw new Error("missing kind");
    const params = msg?.params ?? null;
    let data: unknown;
    if (kind === "open_external") {
      // 侧车要宿主代开外链（MCP OAuth 授权页）：Electron shell.openExternal 不经
      // cmd.exe——Windows 上 `cmd /c start "" <url>` 会把 URL 里的 & 当命令分隔符
      // 切掉（授权页因此报「链接不完整」）。成败如实回包，侧车据此决定是否让用户
      // 手动打开链接（不许再"spawn 成功即成功"）。
      const url = typeof (params as { url?: unknown } | null)?.url === "string" ? String(params.url) : "";
      if (!/^https?:\/\//i.test(url)) throw new Error("open_external: 仅允许 http(s) 链接");
      await shell.openExternal(url);
      data = { ok: true };
    } else if (kind === "tool") {
      // 工具执行（阶段②）：不进 db 串行锁——长 bash 不阻塞其他 host_query
      const envelope = { ...(params ?? {}) };
      const { resolveIntoEnvelope } = await import("./secret-env");
      resolveIntoEnvelope(db, envelope);
      const { handleTool, configureToolOutputDir } = await import("./tool-exec");
      // bash 截断全量的落盘根（幂等）：工具输出与转录同级敏感度，放 userData 不放 /tmp
      configureToolOutputDir(join(appDataDir(), "tool-output"));
      data = await handleTool(id, envelope);
    } else if (kind === "bg_tasks_list") {
      // 后台任务表在宿主内存（跨回合存活）：sidecar 重启后水合/对账的事实源。
      // 只读快照，不占 db 串行锁。
      const { listBgTasks } = await import("./tool-exec");
      const owner =
        typeof (params as { owner?: unknown } | null)?.owner === "string"
          ? String((params as { owner: string }).owner)
          : "";
      data = listBgTasks(owner || undefined);
    } else if (kind === "bg_tasks_reown") {
      // 线程改绑（刷新后草稿 id → sessionId）：后台任务归属跟着线程走，
      // 否则 task_output/task_stop 的归属校验会把它们判成别人的任务。
      const { reownBgTasks } = await import("./tool-exec");
      const p = (params ?? {}) as { oldOwner?: unknown; newOwner?: unknown };
      data = {
        moved: reownBgTasks(
          typeof p.oldOwner === "string" ? p.oldOwner : "",
          typeof p.newOwner === "string" ? p.newOwner : "",
        ),
      };
    } else if (kind === "automation_rpc") {
      // 调度器独立进程后，sidecar 的 automation 命令/工具经这里转发。
      const method =
        typeof (params as { method?: unknown } | null)?.method === "string"
          ? String((params as { method: string }).method)
          : "";
      if (!method) throw new Error("automation_rpc: missing method");
      const args =
        (params as { params?: unknown } | null)?.params &&
        typeof (params as { params?: unknown }).params === "object"
          ? ((params as { params: Record<string, unknown> }).params ?? {})
          : {};
      const { automationRpc } = await import("./automation-service");
      data = await automationRpc(method, args);
    } else if (kind === "secret_env_resolve") {
      // MCP stdio 子进程由 sidecar 拉起，宿主只能把已解密的 env 交给它。
      // 请求在 secret-requests 里做了名字/作用域收口；日志只记名字。
      const [{ resolveMcpSecretEnv }, { parseMcpSecretEnvRequests }] = await Promise.all([
        import("./secret-env"),
        import("./secret-requests"),
      ]);
      const server =
        typeof (params as { server?: unknown } | null)?.server === "string"
          ? String((params as { server: string }).server).slice(0, 64)
          : "";
      const requests = parseMcpSecretEnvRequests(
        (params as { requests?: unknown } | null)?.requests,
      );
      data = { env: resolveMcpSecretEnv(db, requests, server) };
    } else {
      // 同步 SQLite（node:sqlite DatabaseSync / better-sqlite3 都一样）——慢查询会
      // 按住主进程事件循环（期间全部 IPC 排队、界面"哪里都点不了"）。计时留痕 +
      // 供 lag 心跳归因（见 slow-ops.ts）；要治本得把大查询下推或限行数
      data = measureSync(`host_query:${kind}`, () => handleHostQuery(db, kind, params));
    }
    reply = { type: "host_result", id, ok: true, data: data ?? null };
  } catch (err) {
    reply = { type: "host_result", id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return JSON.stringify(reply);
}

/** 共享凭据文件镜像重建（fire-and-forget 动态 import，避免 data ↔ sync 环）。
 *  失败静默：镜像缺失/过旧时 sidecar 回退环境变量凭据，桌面功能不受影响。 */
function queueCredentialFileSync(db: Db): void {
  void import("./credential-file-sync")
    .then((m) => m.syncCredentialFile(db))
    .catch(() => {});
}

export function handleHostQuery(db: Db, kind: string, p: any): unknown {
  switch (kind) {
    /* ------------------------------- sessions ------------------------------- */
    case "session_get": {
      const id = strParam(p, "sessionId");
      const row = db
        .prepare(
          "SELECT cwd, title, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode, goal_max_turns, goal_acceptance_mode, goal_max_duration, kind, parent_session, project_id FROM sessions WHERE id = ?1",
        )
        .get(id) as Row | undefined;
      if (!row) return null;
      return {
        cwd: row.cwd,
        title: row.title,
        kind: row.kind ?? "",
        parentSession: row.parent_session ?? "",
        mode: row.mode ?? null,
        approvalLevel: row.approval_level ?? null,
        modelProvider: row.model_provider ?? null,
        modelId: row.model_id ?? null,
        thinkingLevel: row.thinking_level ?? null,
        designTheme: row.design_theme ?? null,
        appMode: row.app_mode ?? null,
        goalMaxTurns: row.goal_max_turns ?? null,
        goalAcceptanceMode: row.goal_acceptance_mode ?? null,
        goalMaxDuration: row.goal_max_duration ?? null,
        projectId: row.project_id == null ? null : String(row.project_id),
      };
    }
    case "session_insert": {
      const id = strParam(p, "sessionId");
      const cwd = typeof p?.cwd === "string" ? p.cwd : "";
      const now = strParam(p, "now");
      const kind = typeof p?.kind === "string" ? p.kind : "";
      const parentSession =
        typeof p?.parentSession === "string" ? p.parentSession : "";
      const projectId =
        typeof p?.projectId === "string" && p.projectId
          ? String(p.projectId)
          : null;
      db.prepare(
        "INSERT INTO sessions (id, title, first_message, cwd, created_at, updated_at, message_count, kind, parent_session, project_id) VALUES (?, '', '', ?, ?, ?, 0, ?, ?, ?)",
      ).run(id, cwd, now, now, kind, parentSession, projectId);
      return {};
    }
    case "session_set_project": {
      const id = strParam(p, "sessionId");
      const projectId =
        typeof p?.projectId === "string" && p.projectId
          ? String(p.projectId)
          : null;
      db.prepare("UPDATE sessions SET project_id=?1 WHERE id=?2").run(
        projectId,
        id,
      );
      return {};
    }
    /* ------------------------------- projects ------------------------------- */
    case "project_list": {
      return {
        projects: projectList(db, p?.includeArchived === true),
      };
    }
    case "project_save": {
      const project = p?.project;
      if (!project || typeof project !== "object") {
        throw new Error("project required");
      }
      return {
        project: projectSave(db, {
          id: typeof project.id === "string" ? project.id : undefined,
          displayName:
            project.displayName === null || typeof project.displayName === "string"
              ? project.displayName
              : undefined,
          nameIsCustom:
            typeof project.nameIsCustom === "boolean"
              ? project.nameIsCustom
              : undefined,
          appearanceJson:
            project.appearanceJson === null ||
            typeof project.appearanceJson === "string"
              ? project.appearanceJson
              : undefined,
          archived:
            typeof project.archived === "boolean" ? project.archived : undefined,
          showWhenEmpty:
            typeof project.showWhenEmpty === "boolean"
              ? project.showWhenEmpty
              : undefined,
          hiddenFromSidebar:
            typeof project.hiddenFromSidebar === "boolean"
              ? project.hiddenFromSidebar
              : undefined,
          folders: Array.isArray(project.folders)
            ? project.folders
                .filter((folder: unknown): folder is { path: string } =>
                  Boolean(folder && typeof (folder as { path?: unknown }).path === "string"),
                )
                .map((folder: { path: string; isPrimary?: boolean }) => ({
                  path: folder.path,
                  isPrimary: folder.isPrimary === true,
                }))
            : [],
          primaryPath:
            typeof project.primaryPath === "string"
              ? project.primaryPath
              : undefined,
        }),
      };
    }
    case "project_delete": {
      projectDelete(db, strParam(p, "projectId"));
      return {};
    }
    case "project_purge": {
      projectPurge(db, strParam(p, "projectId"));
      return {};
    }
    case "session_meta_set": {
      const id = strParam(p, "sessionId");
      const kind = typeof p?.kind === "string" ? p.kind : "";
      const parentSession =
        typeof p?.parentSession === "string" ? p.parentSession : "";
      db.prepare(
        "UPDATE sessions SET kind = ?1, parent_session = ?2 WHERE id = ?3",
      ).run(kind, parentSession, id);
      return {};
    }
    case "session_list": {
      const rows = db
        .prepare(
          "SELECT id, title, first_message, cwd, archived, archived_at, updated_at, message_count, mode, approval_level, model_provider, model_id, thinking_level, design_theme, app_mode, goal_max_turns, goal_acceptance_mode, goal_max_duration, kind, parent_session, project_id FROM sessions ORDER BY updated_at DESC",
        )
        .all() as Row[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        first_message: r.first_message,
        cwd: r.cwd,
        kind: r.kind ?? "",
        parentSession: r.parent_session ?? "",
        archived: Number(r.archived) === 1 ? 1 : 0,
        archivedAt: r.archived_at == null ? null : String(r.archived_at),
        updated_at: r.updated_at,
        message_count: r.message_count == null ? 0 : Number(r.message_count),
        mode: r.mode ?? null,
        approvalLevel: r.approval_level ?? null,
        modelProvider: r.model_provider ?? null,
        modelId: r.model_id ?? null,
        thinkingLevel: r.thinking_level ?? null,
        designTheme: r.design_theme ?? null,
        appMode: r.app_mode ?? null,
        goalMaxTurns: r.goal_max_turns ?? null,
        goalAcceptanceMode: r.goal_acceptance_mode ?? null,
        goalMaxDuration: r.goal_max_duration ?? null,
        projectId: r.project_id == null ? null : String(r.project_id),
      }));
    }
    case "session_delete": {
      const sessionId = strParam(p, "sessionId");
      db.prepare("DELETE FROM sessions WHERE id = ?1").run(sessionId);
      // 使用记录跟着任务走：会话删了，「被 N 个任务引用」不再统计它
      db.prepare("DELETE FROM knowledge_refs WHERE session_id = ?1").run(sessionId);
      return {};
    }
    case "session_rename": {
      db.prepare("UPDATE sessions SET title = ?1 WHERE id = ?2").run(strParam(p, "name"), strParam(p, "sessionId"));
      return {};
    }
    case "session_set_archived": {
      const archived = Boolean(p?.archived);
      // 归档时刻随行落库（取消归档清空）：检查点 GC 用「归档满 N 天」而非
      // 最后活动时间；旧行为下「昨天归档、上次使用是一年前」会被误清
      db.prepare("UPDATE sessions SET archived = ?1, archived_at = ?2 WHERE id = ?3").run(
        archived ? 1 : 0,
        archived ? new Date().toISOString() : null,
        strParam(p, "sessionId"),
      );
      return {};
    }
    case "session_update_cwd": {
      db.prepare("UPDATE sessions SET cwd = ?1 WHERE id = ?2").run(strParam(p, "cwd"), strParam(p, "sessionId"));
      return {};
    }
    case "session_touch": {
      const id = strParam(p, "sessionId");
      const now = strParam(p, "now");
      const title = typeof p?.title === "string" ? p.title : "";
      const firstMessage = typeof p?.firstMessage === "string" ? p.firstMessage : "";
      const added = typeof p?.added === "number" ? Math.trunc(p.added) : 0;
      db.prepare(
        `UPDATE sessions SET updated_at = ?1,
         title = CASE WHEN title = '' THEN ?2 ELSE title END,
         first_message = CASE WHEN first_message = '' THEN ?3 ELSE first_message END,
         message_count = COALESCE(message_count, 0) + ?5
         WHERE id = ?4`,
      ).run(now, title, firstMessage, id, added);
      return {};
    }
    case "session_prefs_set": {
      const id = strParam(p, "sessionId");
      db.prepare(
        `UPDATE sessions SET
         mode = COALESCE(?2, mode),
         approval_level = COALESCE(?3, approval_level),
         model_provider = COALESCE(?4, model_provider),
         model_id = COALESCE(?5, model_id),
         thinking_level = COALESCE(?6, thinking_level),
         design_theme = COALESCE(?7, design_theme),
         app_mode = COALESCE(?8, app_mode),
         goal_max_turns = COALESCE(?9, goal_max_turns),
         goal_acceptance_mode = COALESCE(?10, goal_acceptance_mode),
         goal_max_duration = COALESCE(?11, goal_max_duration)
         WHERE id = ?1`,
      ).run(
        id,
        strOrNull(p?.mode),
        strOrNull(p?.approvalLevel),
        strOrNull(p?.modelProvider),
        strOrNull(p?.modelId),
        strOrNull(p?.thinkingLevel),
        strOrNull(p?.designTheme),
        strOrNull(p?.appMode),
        strOrNull(p?.goalMaxTurns),
        strOrNull(p?.goalAcceptanceMode),
        strOrNull(p?.goalMaxDuration),
      );
      return {};
    }
    /* ------------------------------- credentials ------------------------------- */
    case "credential_get": {
      const provider = strParam(p, "provider");
      const row = db.prepare("SELECT api_key FROM credentials WHERE provider = ?1").get(provider) as { api_key: string } | undefined;
      if (!row) return null;
      const dec = decrypt(row.api_key);
      if (!dec.ok) {
        logWarn(`[data] credential decrypt failed for ${provider}: ${dec.error}`);
        return null;
      }
      return { apiKey: dec.value };
    }
    case "credential_list": {
      const rows = db.prepare("SELECT provider FROM credentials").all() as { provider: string }[];
      return rows.map((r) => r.provider);
    }
    case "credential_set": {
      const provider = strParam(p, "provider");
      const apiKey = encrypt(strParam(p, "apiKey"));
      const now = strParam(p, "now");
      db.prepare(
        `INSERT INTO credentials (provider, api_key, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at`,
      ).run(provider, apiKey, now);
      queueCredentialFileSync(db);
      return {};
    }
    case "credential_delete": {
      db.prepare("DELETE FROM credentials WHERE provider = ?1").run(strParam(p, "provider"));
      queueCredentialFileSync(db);
      return {};
    }
    /* ------------------------------- 密钥库 ------------------------------- */
    case "secret_list": {
      const rows = db.prepare("SELECT name, scope, value, updated_at FROM secrets ORDER BY name, scope").all() as Row[];
      return rows.map((r) => {
        const dec = decrypt(String(r.value));
        if (!dec.ok) return { name: r.name, scope: r.scope, masked: "****", readable: false, updatedAt: r.updated_at };
        return { name: r.name, scope: r.scope, masked: maskSecret(dec.value), readable: true, updatedAt: r.updated_at };
      });
    }
    case "secret_set": {
      const name = strParam(p, "name");
      if (!isValidSecretName(name)) {
        throw new Error("secret name must match [A-Za-z_][A-Za-z0-9_]* (it becomes an env var name)");
      }
      const scope = typeof p?.scope === "string" ? p.scope : "global";
      if (!isValidSecretScope(scope)) throw new Error('secret scope must be "global" or "workspace:<cwd>"');
      const value = strParam(p, "value");
      if (value.length === 0) throw new Error("secret value is required");
      const byteLen = Buffer.byteLength(value, "utf8");
      if (byteLen > MAX_SECRET_VALUE_BYTES) {
        throw new Error(`secret value too large (${byteLen} bytes > ${MAX_SECRET_VALUE_BYTES})`);
      }
      const now = strParam(p, "now");
      db.prepare(
        `INSERT INTO secrets (name, scope, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(name, scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(name, scope, encrypt(value), now);
      return {};
    }
    case "secret_delete": {
      const name = strParam(p, "name");
      const scope = typeof p?.scope === "string" ? p.scope : "global";
      db.prepare("DELETE FROM secrets WHERE name = ?1 AND scope = ?2").run(name, scope);
      return {};
    }
    case "secret_cipher_status":
      return { backend: getSecretCipherBackend() };
    /* ------------------------------- custom providers ------------------------------- */
    case "custom_providers_list": {
      const rows = db
        .prepare("SELECT id, name, base_url, models, api, enabled, auto_discover, headers FROM custom_providers")
        .all() as Row[];
      return rows.map(cpRow);
    }
    case "custom_provider_get": {
      const id = strParam(p, "id");
      const r = db
        .prepare("SELECT id, name, base_url, models, api, enabled, auto_discover, headers FROM custom_providers WHERE id = ?1")
        .get(id) as Row | undefined;
      return r ? cpRow(r) : null;
    }
    case "custom_provider_upsert": {
      const id = strParam(p, "id");
      const name = strParam(p, "name");
      const baseUrl = strParam(p, "baseUrl");
      const models = strParam(p, "models");
      const api = strParam(p, "api");
      const autoDiscover = p?.autoDiscover === true ? 1 : 0;
      const headers = typeof p?.headers === "string" ? p.headers : "{}";
      db.prepare(
        `INSERT INTO custom_providers (id, name, base_url, models, api, auto_discover, headers) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
         models = excluded.models, api = excluded.api, auto_discover = excluded.auto_discover, headers = excluded.headers`,
      ).run(id, name, baseUrl, models, api, autoDiscover, headers);
      queueCredentialFileSync(db);
      return {};
    }
    case "custom_provider_delete": {
      db.prepare("DELETE FROM custom_providers WHERE id = ?1").run(strParam(p, "id"));
      queueCredentialFileSync(db);
      return {};
    }
    case "custom_provider_set_enabled": {
      const enabled = p?.enabled === undefined ? true : Boolean(p.enabled);
      db.prepare("UPDATE custom_providers SET enabled = ?1 WHERE id = ?2").run(enabled ? 1 : 0, strParam(p, "id"));
      queueCredentialFileSync(db);
      return {};
    }
    /* ------------------------------- models ------------------------------- */
    case "models_all":
      return modelsQuery(db);
    case "models_list":
      return modelsQuery(db, strParam(p, "provider"));
    case "models_replace": {
      const provider = strParam(p, "provider");
      let items: any[];
      try {
        items = JSON.parse(strParam(p, "models"));
      } catch (e) {
        throw new Error(`parse models: ${e}`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM models WHERE provider = ?1").run(provider);
        for (const item of items) {
          const modelId = strOrNull(item?.modelId);
          if (!modelId || !modelId.trim()) continue;
          db.prepare(
            `INSERT OR REPLACE INTO models
             (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, prompt_cache_json, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            provider,
            modelId,
            strOrNull(item?.name),
            typeof item?.reasoning === "boolean" ? (item.reasoning ? 1 : 0) : null,
            numOrNull(item?.contextWindow),
            numOrNull(item?.maxTokens),
            Array.isArray(item?.input) ? JSON.stringify(item.input) : null,
            item?.cost && typeof item.cost === "object" && !Array.isArray(item.cost) ? JSON.stringify(item.cost) : null,
            item?.promptCache && typeof item.promptCache === "object" && !Array.isArray(item.promptCache)
              ? JSON.stringify(item.promptCache)
              : null,
            item?.enabled === undefined ? 1 : item.enabled ? 1 : 0,
          );
        }
      });
      queueCredentialFileSync(db);
      return {};
    }
    case "models_set_context_window": {
      db.prepare(
        "UPDATE models SET context_window = ?1 WHERE provider = ?2 AND model_id = ?3",
      ).run(
        numOrNull(p?.contextWindow),
        strParam(p, "provider"),
        strParam(p, "modelId"),
      );
      queueCredentialFileSync(db);
      return {};
    }
    case "models_delete_provider": {
      db.prepare("DELETE FROM models WHERE provider = ?1").run(strParam(p, "provider"));
      queueCredentialFileSync(db);
      return {};
    }
    /* ------------------------------- kv ------------------------------- */
    case "kv_get": {
      const key = strParam(p, "key");
      const row = db.prepare("SELECT value FROM kv WHERE key = ?1").get(key) as { value: string } | undefined;
      return row ? { value: row.value } : null;
    }
    case "kv_set": {
      const key = strParam(p, "key");
      const value = strParam(p, "value");
      db.prepare(
        "INSERT INTO kv(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
      // 默认模型（pi.model）与发现缓存（pi.dynamic-models.*）也进共享镜像：
      // sidecar/ACP 靠它们决定新会话模型和 AUTO 模型是否在目录里。两者走
      // kv 而不是三张表，这里补一次防抖重建；其余 kv 键与镜像无关。
      if (isMirroredKvKey(key)) {
        void import("./credential-file-sync")
          .then((m) => m.scheduleCredentialFileSync(db))
          .catch(() => {});
      }
      return {};
    }
    /* ------------------------------- usage ------------------------------- */
    case "usage_scan_list": {
      const rows = db.prepare("SELECT session_id, mtime, first_ts, last_ts FROM usage_scan").all() as Row[];
      return rows.map((r) => ({
        sessionId: r.session_id,
        mtime: Number(r.mtime),
        firstTs: Number(r.first_ts),
        lastTs: Number(r.last_ts),
      }));
    }
    case "usage_daily_replace": {
      const sessionId = strParam(p, "sessionId");
      const mtime = p?.mtime;
      if (typeof mtime !== "number") throw new Error("missing mtime");
      const firstTs = typeof p?.firstTs === "number" ? Math.trunc(p.firstTs) : 0;
      const lastTs = typeof p?.lastTs === "number" ? Math.trunc(p.lastTs) : 0;
      let items: any[];
      try {
        items = JSON.parse(strParam(p, "rows"));
      } catch (e) {
        throw new Error(`parse rows: ${e}`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM usage_daily WHERE session_id = ?1").run(sessionId);
        for (const item of items) {
          db.prepare(
            `INSERT INTO usage_daily
             (session_id, date, input, output, cache_read, cache_write, tokens, messages, by_model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          ).run(
            sessionId,
            strOrNull(item?.date) ?? "",
            intOr(item?.input, 0),
            intOr(item?.output, 0),
            intOr(item?.cacheRead, 0),
            intOr(item?.cacheWrite, 0),
            intOr(item?.tokens, 0),
            intOr(item?.messages, 0),
            strOrNull(item?.byModel) ?? "{}",
          );
        }
        db.prepare(
          `INSERT INTO usage_scan (session_id, mtime, first_ts, last_ts) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime,
           first_ts = excluded.first_ts, last_ts = excluded.last_ts`,
        ).run(sessionId, mtime, firstTs, lastTs);
      });
      return {};
    }
    case "usage_daily_query": {
      const rows = db
        .prepare(
          "SELECT session_id, date, input, output, cache_read, cache_write, tokens, messages, by_model FROM usage_daily ORDER BY date",
        )
        .all() as Row[];
      return rows.map((r) => ({
        sessionId: r.session_id,
        date: r.date,
        input: Number(r.input),
        output: Number(r.output),
        cacheRead: Number(r.cache_read),
        cacheWrite: Number(r.cache_write),
        tokens: Number(r.tokens),
        messages: Number(r.messages),
        byModel: r.by_model,
      }));
    }
    case "usage_daily_cleanup": {
      const del = db.prepare("DELETE FROM usage_daily WHERE session_id NOT IN (SELECT id FROM sessions)").run();
      db.prepare("DELETE FROM usage_scan WHERE session_id NOT IN (SELECT id FROM sessions)").run();
      return { removed: del.changes };
    }
    /* ------------------------------- search ------------------------------- */
    // 会话内容搜索索引（sidecar 派生写入）：search_text 由索引器拼好并小写化，
    // 正则/转义都在调用方——这里只做有界的 instr 匹配。正文真值在 JSONL 转录，
    // 本表是可弃重建的投影（弃表后下一次全量回填即恢复）。
    case "search_blocks_upsert": {
      const sessionId = strParam(p, "sessionId");
      let items: any[];
      try {
        items = JSON.parse(strParam(p, "rows"));
      } catch (e) {
        throw new Error(`parse rows: ${e}`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM session_blocks WHERE session_id = ?1").run(sessionId);
        for (const item of items) {
          const seq = item?.seq;
          if (!Number.isInteger(seq) || seq < 0) continue;
          db.prepare(
            "INSERT OR REPLACE INTO session_blocks (session_id, seq, role, preview, search_text) VALUES (?1, ?2, ?3, ?4, ?5)",
          ).run(sessionId, seq, strOrNull(item?.role) ?? "", strOrNull(item?.preview) ?? "", strOrNull(item?.searchText) ?? "");
        }
      });
      return {};
    }
    case "search_blocks_delete": {
      const sessionId = strParam(p, "sessionId");
      db.transaction(() => {
        db.prepare("DELETE FROM session_blocks WHERE session_id = ?1").run(sessionId);
        db.prepare("DELETE FROM search_scan WHERE session_id = ?1").run(sessionId);
      });
      return {};
    }
    case "search_blocks_scan_list": {
      const rows = db.prepare("SELECT session_id, mtime FROM search_scan").all() as Row[];
      return rows.map((r) => ({ sessionId: r.session_id, mtime: Number(r.mtime) }));
    }
    case "search_blocks_scan_set": {
      const sessionId = strParam(p, "sessionId");
      const mtime = p?.mtime;
      if (typeof mtime !== "number") throw new Error("missing mtime");
      db.prepare(
        "INSERT INTO search_scan (session_id, mtime) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime",
      ).run(sessionId, mtime);
      return {};
    }
    case "session_search": {
      // needle 由调用方转义（LIKE 不用，instr 不需要）；LOWER 用 SQL 内建保持与
      // 索引器 toLowerCase 同一折叠语义。LIMIT 界定全扫量级，超界 truncated=true。
      const needle = strParam(p, "needle").toLowerCase();
      if (!needle) return { sessions: [], messages: [], artifacts: [], truncated: false };
      // LIKE 模式里的 %/_ 是通配符、\ 是转义符：调用方已把 needle 转义成
      // likeNeedle（见 hostdb.sessionSearch），SQL 必须声明 ESCAPE 才生效。
      // instr 路径要**原始** needle——转义后的 100\% 在正文里搜不到。
      const likeNeedle = strParam(p, "likeNeedle").toLowerCase() || needle;
      const limit = Math.min(Math.max(intOr(p?.limit, 200), 1), 500);
      const sessions = db
        .prepare(
          `SELECT id, title, first_message, cwd, archived, updated_at FROM sessions
           WHERE (LOWER(title) LIKE '%' || ?2 || '%' ESCAPE '\\'
              OR LOWER(first_message) LIKE '%' || ?2 || '%' ESCAPE '\\')
           AND kind != 'side_chat'
           ORDER BY updated_at DESC LIMIT ?3`,
        )
        .all(needle, likeNeedle, limit + 1) as Row[];
      const messages = db
        .prepare(
          `SELECT sb.session_id AS sessionId, sb.seq, sb.role, sb.preview,
                  s.title, s.cwd, s.archived, s.updated_at
           FROM session_blocks sb JOIN sessions s ON s.id = sb.session_id
           WHERE s.kind != 'side_chat' AND instr(sb.search_text, ?1) > 0
           ORDER BY s.updated_at DESC, sb.session_id, sb.seq LIMIT ?3`,
        )
        .all(needle, likeNeedle, limit + 1) as Row[];
      // 产物/资料库文件命中：归属键 JOIN sessions 拿会话上下文（产物行），
      // 资料库行（__library__）没有会话对应，LEFT JOIN 后靠 rel 直接展示。
      // 文件级一行 = 一个文件（search_text 是该文件全文的抽取投影）。
      const artifacts = db
        .prepare(
          `SELECT ab.session_id AS ownerKey, ab.rel, ab.name, ab.preview,
                  s.title, s.cwd, s.archived
           FROM artifact_blocks ab
           LEFT JOIN sessions s ON s.id = ab.session_id AND s.kind != 'side_chat'
           WHERE instr(ab.search_text, ?1) > 0
              OR LOWER(ab.name) LIKE '%' || ?2 || '%' ESCAPE '\\'
           ORDER BY s.updated_at DESC, ab.session_id, ab.rel LIMIT ?3`,
        )
        .all(needle, likeNeedle, limit + 1) as Row[];
      const truncated =
        sessions.length > limit || messages.length > limit || artifacts.length > limit;
      return {
        sessions: sessions.slice(0, limit).map((r) => ({
          sessionId: r.id,
          title: r.title,
          firstMessage: r.first_message,
          cwd: r.cwd,
          archived: Number(r.archived) === 1,
          updatedAt: r.updated_at,
        })),
        messages: messages.slice(0, limit).map((r) => ({
          sessionId: r.sessionId,
          seq: Number(r.seq),
          role: r.role,
          preview: r.preview,
          title: r.title,
          cwd: r.cwd,
          archived: Number(r.archived) === 1,
          updatedAt: r.updated_at,
        })),
        artifacts: artifacts.slice(0, limit).map((r) => ({
          // ownerKey = sessionId（产物）或 __library__（资料库）；null 会话 =
          // 资料库行（LEFT JOIN 未命中）
          sessionId: r.sessionId ?? r.ownerKey,
          rel: r.rel,
          name: r.name,
          preview: r.preview,
          title: r.title ?? null,
          cwd: r.cwd ?? "",
          archived: Number(r.archived ?? 0) === 1,
        })),
        truncated,
      };
    }
    /* ----------------------- 产物/资料库文件索引 ----------------------- */
    /* ---------------------------- 知识使用记录 ---------------------------- */
    // 哪个任务真正读过哪条知识（kb_read/显式引用调用）。按 (session, source,
    // scope, path) 去重，ts 取最近一次；用于「被 N 个任务引用」与热度排序。
    case "knowledge_refs_record": {
      const sessionId = strParam(p, "sessionId").slice(0, 200);
      const source = strParam(p, "source").slice(0, 32);
      const path = strParam(p, "path").slice(0, 2048);
      const scopeId =
        typeof p?.scopeId === "string" ? p.scopeId.slice(0, 2048) : "";
      if (!sessionId || !source || !path) return {};
      const ts =
        typeof p?.ts === "number" && Number.isFinite(p.ts)
          ? Math.trunc(p.ts)
          : Date.now();
      db.prepare(
        `INSERT INTO knowledge_refs (session_id, source, scope_id, path, ts)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id, source, scope_id, path)
         DO UPDATE SET ts = excluded.ts`,
      ).run(sessionId, source, scopeId, path, ts);
      return {};
    }
    case "knowledge_refs_stats": {
      const source = strParam(p, "source");
      const path = strParam(p, "path");
      const scopeId =
        typeof p?.scopeId === "string" ? p.scopeId : "";
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM knowledge_refs
           WHERE source = ?1 AND scope_id = ?2 AND path = ?3`,
        )
        .get(source, scopeId, path) as Row | undefined;
      return {
        count: Number(row?.n ?? 0),
        lastTs:
          row?.lastTs === null || row?.lastTs === undefined
            ? null
            : Number(row.lastTs),
      };
    }
    case "knowledge_refs_for_path": {
      const source = strParam(p, "source");
      const path = strParam(p, "path");
      const scopeId =
        typeof p?.scopeId === "string" ? p.scopeId : "";
      const limit = Math.min(Math.max(intOr(p?.limit, 20), 1), 100);
      const rows = db
        .prepare(
          `SELECT kr.session_id AS sessionId, kr.ts,
                  s.title, s.cwd
           FROM knowledge_refs kr
           LEFT JOIN sessions s ON s.id = kr.session_id
           WHERE kr.source = ?1 AND kr.scope_id = ?2 AND kr.path = ?3
           ORDER BY kr.ts DESC LIMIT ?4`,
        )
        .all(source, scopeId, path, limit) as Row[];
      return rows.map((row) => ({
        sessionId: row.sessionId,
        ts: Number(row.ts),
        title: row.title ?? null,
        cwd: row.cwd ?? "",
      }));
    }
    // 资料库根（sidecar 侧 kb 工具与搜索索引共用）：换根后无需重启 sidecar，
    // 每次取当前值，环境变量 PI_LIBRARY_ROOT 只作启动期兜底。
    case "library_root_get": {
      return { root: libraryRoot() };
    }
    // 单归属键的文件检索（kb_search 的 library scope 专用）：复用 artifact_blocks
    // 全文投影，不必每次刷新/扫描会话索引。
    case "artifact_search": {
      const ownerKey = strParam(p, "ownerKey");
      const needle = strParam(p, "needle").toLowerCase();
      const likeNeedle = strParam(p, "likeNeedle").toLowerCase() || needle;
      const limit = Math.min(Math.max(intOr(p?.limit, 30), 1), 200);
      if (!needle) return { hits: [], truncated: false };
      const rows = db
        .prepare(
          `SELECT rel, name, preview FROM artifact_blocks
           WHERE session_id = ?1 AND (instr(search_text, ?2) > 0
              OR LOWER(name) LIKE '%' || ?3 || '%' ESCAPE '\\')
           ORDER BY rel LIMIT ?4`,
        )
        .all(ownerKey, needle, likeNeedle, limit + 1) as Row[];
      return {
        hits: rows.slice(0, limit).map((r) => ({
          rel: r.rel,
          name: r.name,
          preview: r.preview,
        })),
        truncated: rows.length > limit,
      };
    }
    // 与 session_blocks 同一套水位模式；ownerKey = sessionId 或 __library__。
    // 文件删除由索引器对账（scan_list 与现存清单差集）处理，这里不做级联。
    case "search_artifacts_upsert": {
      const ownerKey = strParam(p, "ownerKey");
      let items: any[];
      try {
        items = JSON.parse(strParam(p, "rows"));
      } catch (e) {
        throw new Error(`parse rows: ${e}`);
      }
      db.transaction(() => {
        db.prepare("DELETE FROM artifact_blocks WHERE session_id = ?1").run(ownerKey);
        for (const item of items) {
          const rel = strOrNull(item?.rel);
          if (!rel) continue;
          db.prepare(
            "INSERT OR REPLACE INTO artifact_blocks (session_id, rel, name, preview, search_text) VALUES (?1, ?2, ?3, ?4, ?5)",
          ).run(ownerKey, rel, strOrNull(item?.name) ?? rel, strOrNull(item?.preview) ?? "", strOrNull(item?.searchText) ?? "");
        }
      });
      return {};
    }
    case "search_artifacts_delete": {
      const ownerKey = strParam(p, "ownerKey");
      db.transaction(() => {
        db.prepare("DELETE FROM artifact_blocks WHERE session_id = ?1").run(ownerKey);
        db.prepare("DELETE FROM artifact_scan WHERE session_id = ?1").run(ownerKey);
      });
      return {};
    }
    case "search_artifacts_scan_list": {
      const rows = db.prepare("SELECT session_id, mtime FROM artifact_scan").all() as Row[];
      return rows.map((r) => ({ ownerKey: r.session_id, mtime: Number(r.mtime) }));
    }
    case "search_artifacts_scan_set": {
      const ownerKey = strParam(p, "ownerKey");
      const mtime = p?.mtime;
      if (typeof mtime !== "number") throw new Error("missing mtime");
      db.prepare(
        "INSERT INTO artifact_scan (session_id, mtime) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime",
      ).run(ownerKey, mtime);
      return {};
    }
    case "search_artifacts_recent": {
      // 默认页最近文件：插入序（upsert 按目录遍历序写入，rowid 序 ≈ 目录序）
      const limitN = Math.min(Math.max(intOr(p?.limit, 10), 1), 50);
      const rows = db
        .prepare(
          `SELECT ab.session_id AS ownerKey, ab.rel, ab.name, ab.preview,
                  s.title, s.cwd, s.archived
           FROM artifact_blocks ab
           LEFT JOIN sessions s ON s.id = ab.session_id
           ORDER BY ab.rowid LIMIT ?1`,
        )
        .all(limitN) as Row[];
      return rows.map((r) => ({
        sessionId: r.sessionId ?? r.ownerKey,
        rel: r.rel,
        name: r.name,
        preview: r.preview,
        title: r.title ?? null,
        cwd: r.cwd ?? "",
        archived: Number(r.archived ?? 0) === 1,
      }));
    }
    /* ------------------------------ 搜索历史 ------------------------------ */
    case "search_history_list": {
      const limitN = Math.min(Math.max(intOr(p?.limit, 12), 1), 50);
      const rows = db
        .prepare(
          `SELECT query, MAX(created_at) AS last_at FROM search_history
           GROUP BY query ORDER BY last_at DESC LIMIT ?1`,
        )
        .all(limitN) as Row[];
      return rows.map((r) => ({ query: r.query, createdAt: r.last_at }));
    }
    case "search_history_add": {
      const query = strParam(p, "query").trim().slice(0, 200);
      if (!query) return {};
      // id/now 是可选参数：strParam 对缺失 key 会抛（不是返回空串），这里必须
      // 用宽松读——客户端只传 query，id 与时间戳由宿主生成
      const id = typeof p?.id === "string" && p.id
        ? p.id
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = typeof p?.now === "string" && p.now ? p.now : new Date().toISOString();
      // 同查询去重（保留最新时间），整体保 100 条：超界按最旧清除
      db.transaction(() => {
        db.prepare("DELETE FROM search_history WHERE query = ?1").run(query);
        db.prepare("INSERT INTO search_history (id, query, created_at) VALUES (?1, ?2, ?3)").run(
          id,
          query,
          now,
        );
        db.prepare(
          `DELETE FROM search_history WHERE id NOT IN (
             SELECT id FROM search_history ORDER BY created_at DESC LIMIT 100)`,
        ).run();
      });
      return {};
    }
    case "search_history_clear": {
      db.prepare("DELETE FROM search_history").run();
      return {};
    }
    default:
      throw new Error(`unknown host_query kind: ${kind}`);
  }
}

function cpRow(r: Row): any {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    models: r.models,
    api: r.api,
    enabled: Number(r.enabled) === 1,
    autoDiscover: Number(r.auto_discover) === 1,
    headers: r.headers,
  };
}

function intOr(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
}

export { isEncrypted };
