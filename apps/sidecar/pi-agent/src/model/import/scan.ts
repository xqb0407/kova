/**
 * 导入扫描：唯一碰文件系统的层。职责只有三件——按平台拼出各工具的默认配置
 * 路径、读文本喂给纯解析器、如实汇总每个来源的"找到 / 不存在 / 失败 + 原因"。
 *
 * 解析逻辑全在 opencode.ts / codex.ts / zcode.ts（纯函数，可单测），这里不碰
 * 任何字段口径。
 *
 * 路径不硬编码 `/Users/...`：opencode 走 XDG（`$XDG_CONFIG_HOME` 或
 * `~/.config`，Windows 走 `%APPDATA%`），Codex / ZCode 都在 homedir 下
 * （Windows 上 homedir() 同样是用户目录）。任一来源的文件不存在都不是错误，
 * 只是不出现在候选里——大多数用户只装了其中一个工具。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { logErr } from "../../log";
import { parseCcswitchProviders, type CcswitchProviderRow } from "./ccswitch";
import { parseCodexConfig } from "./codex";
import { parseOpencodeConfig } from "./opencode";
import { parseZcodeConfig } from "./zcode";
import type { ImportSource, ImportSourceStatus, ProviderImportScan } from "./types";

/** 各来源的候选配置路径（按优先级，第一个存在的胜出）。
 *  做成函数而非模块常量：homedir 在测试里被注入，常量会在 import 时就固化 */
function sourcePaths(source: ImportSource, home: string, env: Record<string, string | undefined>): string[] {
  switch (source) {
    case "opencode": {
      const xdg = env.XDG_CONFIG_HOME?.trim();
      const base = xdg && env.XDG_CONFIG_HOME
        ? xdg
        : env.APPDATA?.trim()
          ? join(env.APPDATA, "opencode")
          : join(home, ".config", "opencode");
      return [join(base, "opencode.json"), join(base, "opencode.jsonc")];
    }
    case "codex":
      return [join(home, ".codex", "config.toml")];
    case "zcode":
      return [join(home, ".zcode", "v2", "provider_config.json"), join(home, ".zcode", "cli", "config.json")];
    case "ccswitch":
      return [join(home, ".cc-switch", "cc-switch.db")];
  }
}

/** 读取文本；文件不存在返回 undefined，其余失败抛给调用方记成 error */
function readOrUndefined(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** 读第一个存在的文件（ZCode 两个版本二选一） */
function readFirstExisting(paths: string[]): { path: string; text: string } | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    return { path, text: readFileSync(path, "utf8") };
  }
  return null;
}

/**
 * 读 cc-switch 的 providers 表。
 *
 * **只读打开**是硬要求：cc-switch 是个正在运行的桌面应用，它的库在 WAL 模式下被
 * 持有；读写方式打开会撞锁，甚至在它写库时把它的数据搞坏。导入只需要看，
 * readonly 打开在 WAL 下与持有方互不阻塞。
 *
 * settings_config / meta 这些大 TEXT 列只取用得到的 providers 四列，7MB 的库里
 * 其余是请求日志与会话同步台账，跟模型服务无关。
 */
function readCcswitchRows(dbPath: string): CcswitchProviderRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        "SELECT id, app_type, name, settings_config FROM providers ORDER BY app_type, sort_index",
      )
      .all() as CcswitchProviderRow[];
  } finally {
    // 显式关连接：cc-switch 进程还在跑，句柄漏了会一直占着它的库
    db.close();
  }
}

/** 一次扫描一个来源；任何异常都收敛成 error 字段，不让单个坏文件掀掉整次扫描 */
function scanSource(
  source: ImportSource,
  deps: { home: string; env: Record<string, string | undefined> },
): { status: ImportSourceStatus; candidates: ProviderImportScan["candidates"] } {
  const paths = sourcePaths(source, deps.home, deps.env);
  const base = { source, paths, foundPath: null, count: 0, error: null } as const;
  try {
    if (source === "opencode") {
      const [jsonPath, jsoncPath] = paths;
      // json / jsonc 都缺才算这个来源不存在；jsonc 是补丁文件，单独存在也扫
      if (!existsSync(jsonPath) && !existsSync(jsoncPath)) return { status: base, candidates: [] };
      const candidates = parseOpencodeConfig(
        readOrUndefined(jsonPath),
        readOrUndefined(jsoncPath),
        jsonPath ? "opencode.json" : "opencode.jsonc",
      );
      return {
        status: { ...base, foundPath: jsonPath, count: candidates.length },
        candidates,
      };
    }
    if (source === "codex") {
      const configPath = paths[0];
      if (!existsSync(configPath)) return { status: base, candidates: [] };
      const dir = join(deps.home, ".codex");
      const candidates = parseCodexConfig(
        readOrUndefined(configPath),
        readOrUndefined(join(dir, "auth.json")),
        deps.env,
      );
      return { status: { ...base, foundPath: configPath, count: candidates.length }, candidates };
    }
    if (source === "zcode") {
      // v2 优先，回退 cli；命中即止
      const hit = readFirstExisting(paths);
      if (!hit) return { status: base, candidates: [] };
      const candidates = parseZcodeConfig(hit.text);
      return {
        status: { ...base, foundPath: hit.path, count: candidates.length },
        candidates,
      };
    }
    // ccswitch：SQLite 库，只读打开
    const dbPath = paths[0];
    if (!existsSync(dbPath)) return { status: base, candidates: [] };
    const candidates = parseCcswitchProviders(readCcswitchRows(dbPath));
    return {
      status: { ...base, foundPath: dbPath, count: candidates.length },
      candidates,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logErr("scan provider imports failed for", source, err);
    return {
      status: { ...base, error: `${reason}`, foundPath: paths.find((p) => existsSync(p)) ?? null },
      candidates: [],
    };
  }
}

/**
 * 扫所有来源。home/env 显式传入（默认取真实值）便于单测注入临时目录。
 * 返回顺序固定为 opencode → codex → zcode，前端按此分组展示。
 */
export function scanProviderImports(deps?: {
  home?: string;
  env?: Record<string, string | undefined>;
}): ProviderImportScan {
  const resolved = {
    home: deps?.home ?? homedir(),
    env: deps?.env ?? process.env,
  };
  const sources: ImportSource[] = ["opencode", "codex", "zcode", "ccswitch"];
  const statuses: ImportSourceStatus[] = [];
  const candidates: ProviderImportScan["candidates"] = [];
  for (const source of sources) {
    const result = scanSource(source, resolved);
    statuses.push(result.status);
    candidates.push(...result.candidates);
  }
  return { candidates, sources: statuses };
}