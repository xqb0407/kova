/**
 * 会话级沙箱计划：把 cwd / 外部目录 / 本机 write roots / 配置编译成纯数据，
 * 由 host 负责执行。短 TTL 缓存避免每条命令重复读权限清单。
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxPlan,
  type SandboxPlan,
} from "pi-sandbox";
import type { Running } from "../types";
import { loadWriteRoots } from "./write-roots";
import { getSandboxConfig, sandboxConfigVersion } from "./sandbox-config";

const PLAN_TTL_MS = 1_000;

type CacheEntry = { at: number; version: number; plan: SandboxPlan | null };
let cache = new WeakMap<Running, CacheEntry>();
const tempRoots = new Map<string, string>();

/** 每个会话一个稳定的临时目录；host 也会把它写进 plan 的可写根。 */
export function sandboxTempRoot(sessionId: string): string {
  const existing = tempRoots.get(sessionId);
  if (existing) return existing;
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "session";
  const dir = join(tmpdir(), "kova-sandbox", safe);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录创建失败交给后续命令报错；不要因此中断工具 */
  }
  tempRoots.set(sessionId, dir);
  return dir;
}

export async function sandboxPlanForRun(run: Running): Promise<SandboxPlan | null> {
  // 全局开关：off = 退回旧行为；workspace = 开发/灰度强制开启（覆盖 kv 缺省）。
  const env = process.env.KOVA_SANDBOX;
  if (env === "off") return null;
  const config = getSandboxConfig();
  if (env === "workspace" && config.tier === "off") {
    config.tier = "workspace";
  }
  if (config.tier === "off") return null;

  const version = sandboxConfigVersion();
  const now = Date.now();
  const cached = cache.get(run);
  if (cached && cached.version === version && now - cached.at < PLAN_TTL_MS) {
    return cached.plan;
  }

  let writeRoots: string[] = [];
  try {
    writeRoots = (await loadWriteRoots(run.cwd)).effective;
  } catch {
    // 清单坏了不能把沙箱整个关掉：没有额外根时仍按工作区隔离。
    writeRoots = [];
  }

  const plan = buildSandboxPlan({
    cwd: run.cwd,
    externalDirs: run.externalDirs.map((dir) => dir.path),
    writeRoots,
    tempRoot: sandboxTempRoot(run.sessionId),
    config,
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    pathExists: existsSync,
  });

  cache.set(run, { at: now, version, plan });
  return plan;
}

/** 设置页改档位/权限后立即失效；不传 run 则清空全部。 */
export function invalidateSandboxPlans(run?: Running): void {
  if (run) cache.delete(run);
  else cache = new WeakMap<Running, CacheEntry>();
}
