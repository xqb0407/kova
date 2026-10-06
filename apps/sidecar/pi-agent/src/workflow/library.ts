/**
 * 剧本库(hostdb,SQLite kv):已保存的剧本是「可参数化重放」的资产——
 * 从一次成功运行存下来,跨线程、跨项目按名重跑(设计文档 §5.2:库是事实源,
 * YAML 导入/导出与工作区挂载留给后续增量)。
 *
 * 存储形态:单 kv 键下的 JSON 数组(与 subagent-definitions 的运行时状态同款
 * 链路)。体量小(剧本 ≤ 百步 × 文本),整表读写换实现简单。
 *
 * 参数:保存时从步骤 prompt 里扫 `{{args.NAME}}` 占位符自动生成声明(模型把
 * 「每次会变的值」写进占位符,存下来就是一张参数表,对齐 ZCode 的参数表形态);
 * 运行时按声明校验类型、必填与默认值,再交给 resolveStepPrompt 插值。
 */
import { randomUUID } from "node:crypto";
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";
import { validatePlan, type WorkflowStep } from "./plan-state";
import type { Playbook, PlaybookArg } from "pi-protocol";

const PLAYBOOK_KV_KEY = "pi.workflow.playbooks";
const MAX_PLAYBOOKS = 100;
const ARG_NAME_PATTERN = /[A-Za-z][A-Za-z0-9_]{0,40}/;

/** 内存缓存:hostdb 读写是异步 RPC,列表/详情路径要能同步取(加载一次后写穿) */
let cache: Playbook[] | null = null;

async function loadAll(): Promise<Playbook[]> {
  if (cache) return cache;
  try {
    const row = await kvGet(PLAYBOOK_KV_KEY);
    const parsed: unknown = row?.value ? JSON.parse(row.value) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isPlaybookShaped) : [];
  } catch (err) {
    logErr("workflow library: failed to load playbooks:", err);
    cache = [];
  }
  return cache;
}

async function persistAll(playbooks: Playbook[]): Promise<void> {
  cache = playbooks;
  await kvSet(PLAYBOOK_KV_KEY, JSON.stringify(playbooks));
}

/** 盘上形状守卫(畸形条目整条判废,不让一条撕裂行把整库带崩) */
function isPlaybookShaped(value: unknown): value is Playbook {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.description === "string" &&
    Array.isArray(p.steps) &&
    Array.isArray(p.args)
  );
}

export async function listPlaybooks(): Promise<Playbook[]> {
  const all = await loadAll();
  return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getPlaybook(idOrName: string): Promise<Playbook | undefined> {
  const key = idOrName.trim().toLowerCase();
  const all = await loadAll();
  return all.find((p) => p.id === idOrName || p.name.toLowerCase() === key);
}

/**
 * 从步骤 prompt 里提取 `{{args.NAME}}` 占位符生成参数声明。
 * 声明只到「名字」这一层:类型默认 string、非必填——模型写占位符时表达的是
 * 「这里要变」,不是类型系统;用户在意时可在设置页改(后续增量)。
 */
export function deriveArgsFromSteps(steps: WorkflowStep[]): PlaybookArg[] {
  const seen = new Map<string, PlaybookArg>();
  for (const step of steps) {
    const matches = step.prompt.matchAll(/\{\{\s*args\.([A-Za-z0-9_]+)\s*\}\}/g);
    for (const m of matches) {
      const name = m[1]!;
      if (!ARG_NAME_PATTERN.test(name) || seen.has(name)) continue;
      seen.set(name, { name, type: "string", required: false });
    }
  }
  return [...seen.values()];
}

/** 剧本参数值:按声明校验类型、填默认值。返回错误列表(空 = 通过) */
export function validatePlaybookArgs(
  decls: PlaybookArg[],
  raw: Record<string, unknown> | undefined,
): { ok: true; values: Record<string, unknown> } | { ok: false; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const decl of decls) {
    const provided = raw?.[decl.name];
    if (provided === undefined || provided === null || provided === "") {
      if (decl.default !== undefined) {
        values[decl.name] = decl.default;
      } else if (decl.required) {
        errors.push(`缺少必填参数 "${decl.name}"`);
      }
      continue;
    }
    if (decl.type === "number") {
      const n = typeof provided === "number" ? provided : Number(provided);
      if (!Number.isFinite(n)) {
        errors.push(`参数 "${decl.name}" 需要数字,收到 ${JSON.stringify(provided)}`);
        continue;
      }
      values[decl.name] = n;
      continue;
    }
    if (decl.type === "boolean") {
      if (typeof provided === "boolean") {
        values[decl.name] = provided;
        continue;
      }
      // 宽容解析:JSON 路径正常给真布尔,表单路径可能是 "1"/"true" 串
      const s = String(provided).trim().toLowerCase();
      if (s === "true" || s === "1") {
        values[decl.name] = true;
        continue;
      }
      if (s === "false" || s === "0") {
        values[decl.name] = false;
        continue;
      }
      errors.push(`参数 "${decl.name}" 需要布尔值`);
      continue;
    }
    values[decl.name] = String(provided);
  }
  // 声明之外的键忽略(宽容:调用方多带不报错)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

export type SavePlaybookInput = {
  /** 来源运行(取其 plan.steps;与 steps 二选一) */
  steps: WorkflowStep[];
  name: string;
  description?: string;
  whenToUse?: string;
  args?: PlaybookArg[];
  source?: string;
};

/** 保存(按 name 去重:同名覆盖,保住 id 让历史链接不断) */
export async function savePlaybook(input: SavePlaybookInput): Promise<Playbook> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("playbook name is required");
  // 重新过一遍提案校验:库里的步骤必须仍是可执行的合法剧本
  const checked = validatePlan(input.steps);
  if (!checked.ok) throw new Error(`playbook steps are invalid: ${checked.reason}`);
  const all = await loadAll();
  const existing = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const now = Date.now();
  const playbook: Playbook = {
    id: existing?.id ?? `pb-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
    name,
    description: (input.description ?? existing?.description ?? "").trim().slice(0, 500),
    ...(input.whenToUse ?? existing?.whenToUse
      ? { whenToUse: (input.whenToUse ?? existing?.whenToUse ?? "").slice(0, 500) }
      : {}),
    steps: checked.steps.map((s) => toView(s)),
    args: input.args ?? existing?.args ?? deriveArgsFromSteps(checked.steps),
    source: input.source ?? existing?.source ?? "manual",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing ? all.map((p) => (p.id === existing.id ? playbook : p)) : [...all, playbook];
  if (next.length > MAX_PLAYBOOKS) {
    next.sort((a, b) => b.updatedAt - a.updatedAt);
    next.length = MAX_PLAYBOOKS;
  }
  await persistAll(next);
  return playbook;
}

export async function deletePlaybook(idOrName: string): Promise<boolean> {
  const all = await loadAll();
  const target = all.find(
    (p) => p.id === idOrName || p.name.toLowerCase() === idOrName.trim().toLowerCase(),
  );
  if (!target) return false;
  await persistAll(all.filter((p) => p.id !== target.id));
  return true;
}

/** WorkflowStep → 协议投影(与 workflowStatePayload 的步骤投影同形单源) */
function toView(s: WorkflowStep): Playbook["steps"][number] {
  return {
    key: s.key,
    kind: s.kind,
    phase: s.phase,
    title: s.title,
    ...(s.agent ? { agent: s.agent } : {}),
    ...(s.model ? { model: s.model } : {}),
    dependsOn: s.dependsOn,
    ...(s.gate ? { gate: { command: s.gate.command, ...(s.gate.args ? { args: s.gate.args } : {}) } } : {}),
    ...(s.foreach ? { foreach: { from: s.foreach.from } } : {}),
    ...(s.verify ? { verify: { reviewers: s.verify.reviewers ?? 2, threshold: s.verify.threshold ?? 0.5 } } : {}),
    ...(s.retries ? { retries: s.retries } : {}),
    ...(s.onFail ? { onFail: s.onFail } : {}),
  };
}

/** 投影 → 可执行步骤(toView 的逆;经 validatePlan 复核后才可执行) */
export function playbookSteps(playbook: Playbook): WorkflowStep[] {
  const checked = validatePlan(playbook.steps);
  if (!checked.ok) throw new Error(`playbook "${playbook.name}" is invalid: ${checked.reason}`);
  return checked.steps;
}

/** 测试缝:清缓存 */
export function _resetLibraryCacheForTests(): void {
  cache = null;
}
