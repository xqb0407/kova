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
import {
  ARG_NAME_CHARS,
  DEFAULT_PHASE,
  isArgName,
  validatePlan,
  type WorkflowStep,
} from "./plan-state";
import type { Playbook, PlaybookArg } from "pi-protocol";

const PLAYBOOK_KV_KEY = "pi.workflow.playbooks";
const MAX_PLAYBOOKS = 100;

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

/** 同步读缓存(sidecar 启动时 warmLibrary 预热;工具目录/提示词这类同步面用) */
export function cachedPlaybooksSync(): Playbook[] | undefined {
  return cache ?? undefined;
}

/** 预热缓存(sidecar 启动调用;失败静默——首次真实访问会再试一次) */
export async function warmLibrary(): Promise<void> {
  await loadAll();
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
  // 字符集与「运行时插值」同源(plan-state 的 ARG_NAME_CHARS):中文参数名也是合法
  // 参数名,两边各写一份 ASCII 会让声明与插值分别静默失效
  const placeholder = new RegExp(`\\{\\{\\s*args\\.(${ARG_NAME_CHARS})\\s*\\}\\}`, "gu");
  for (const step of steps) {
    const matches = step.prompt.matchAll(placeholder);
    for (const m of matches) {
      const name = m[1]!;
      if (!isArgName(name) || seen.has(name)) continue;
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
  /** 存下它的那次运行 id(source=from-run 时),卡片溯源徽标用 */
  sourceRunId?: string;
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
    // 溯源:同名覆盖时保留原来的来源运行 id(除非这次显式给了新的)
    ...(input.sourceRunId ?? existing?.sourceRunId
      ? { sourceRunId: input.sourceRunId ?? existing?.sourceRunId }
      : {}),
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

/* --------------------------- 组合展开(macro) --------------------------- */

/** 展开深度上限:顶层(0)引剧本(1),被引剧本的步骤还可以再引一层(2),再深就该拆开 */
const MAX_COMPOSE_DEPTH = 2;

/**
 * 组合展开:把 kind:"playbook" 的步骤平铺成被引剧本的步骤(设计文档 §5.1)。
 * - 子步骤键加 `父key.` 前缀,phase 继承引用处(引用处没显式写就用子步自己的);
 * - use.args 里给了值的 `{{args.NAME}}` 就地替换(具体值固化);没给的留到运行时
 *   按本 run 的 args 解析——被引剧本的未绑参数因此仍是顶层可参数化的;
 * - 被引剧本的内部依赖原样保留并加前缀,子步骤整体依赖引用处的 dependsOn;
 * - 环引用(名字栈)与深度上限直接拒绝——与运行时嵌套不同,这里零运行时成本。
 * 返回的新 steps 需要再经 validatePlan(展开后的结构检查)。
 */
export async function expandComposition(
  steps: WorkflowStep[],
  options: {
    /** 剧本解析器(测试注入;生产默认走库) */
    resolve?: (name: string) => Promise<Playbook | undefined>;
  } = {},
  depth = 0,
  stack: string[] = [],
): Promise<{ ok: true; steps: WorkflowStep[] } | { ok: false; reason: string }> {
  const resolve = options.resolve ?? getPlaybook;
  const out: WorkflowStep[] = [];
  /**
   * 父键 → 组汇点键(被引剧本顶层 synthesize 的前缀化键)。外层步骤对父键的
   * 引用(依赖与 {{父键}} 插值)在展开后必须重写到汇点,否则指向了不存在的键。
   */
  const renames = new Map<string, string>();
  for (const step of steps) {
    if (step.kind !== "playbook" || !step.use) {
      out.push({ ...step, dependsOn: [...step.dependsOn] });
      continue;
    }
    const refName = step.use.playbook;
    if (depth >= MAX_COMPOSE_DEPTH) {
      return {
        ok: false,
        reason: `playbook "${refName}" is nested deeper than ${MAX_COMPOSE_DEPTH} levels — flatten the composition instead.`,
      };
    }
    if (stack.some((n) => n.toLowerCase() === refName.toLowerCase())) {
      return {
        ok: false,
        reason: `playbook composition cycle: ${[...stack, refName].join(" -> ")}.`,
      };
    }
    const playbook = await resolve(refName);
    if (!playbook) {
      return {
        ok: false,
        reason: `unknown playbook "${refName}" — check the name in the playbook library under 自动化 / 工作流.`,
      };
    }
    let inner: WorkflowStep[];
    try {
      inner = playbookSteps(playbook);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const boundArgs = step.use.args ?? {};
    const prefix = `${step.key}.`;
    const mapped = inner.map((child) => {
      const key = `${prefix}${child.key}`;
      return {
        ...child,
        key,
        phase: step.phase !== DEFAULT_PHASE ? step.phase : child.phase,
        dependsOn: child.dependsOn.map((d) => `${prefix}${d}`),
        prompt: bindPlaybookArgs(child.prompt, boundArgs),
      };
    });
    // 被引剧本的内部引用继续展开(深度 +1,名字栈进一层)
    const nested = await expandComposition(mapped, options, depth + 1, [...stack, refName]);
    if (!nested.ok) return nested;
    // 子步骤整体接上引用处的依赖(引用处等待谁,它们就等谁)
    for (const child of nested.steps) {
      child.dependsOn = [...new Set([...child.dependsOn, ...step.dependsOn])];
    }
    // 组汇点 = 被引剧本的顶层 synthesize(前缀化后);校验过的剧本必有恰好一个
    const sink = inner.find((s) => s.kind === "synthesize" && !s.key.includes("."));
    if (!sink) {
      return { ok: false, reason: `playbook "${refName}" has no top-level synthesize step (its sub-report is the composition's result).` };
    }
    renames.set(step.key, `${prefix}${sink.key}`);
    out.push(...nested.steps);
  }
  // 后处理:把对父键的引用(依赖 + {{占位符}})重写到组汇点。放最后做,前向引用也覆盖
  if (renames.size > 0) {
    for (const step of out) {
      step.dependsOn = step.dependsOn.map((d) => renames.get(d) ?? d);
      for (const [parentKey, sinkKey] of renames) {
        step.prompt = step.prompt.replace(
          new RegExp(`\\{\\{\\s*${parentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g"),
          `{{${sinkKey}}}`,
        );
      }
    }
  }
  return { ok: true, steps: out };
}

/** 把 use.args 里给了值的 {{args.NAME}} 就地替换;没给的保持占位符(运行时解析) */
function bindPlaybookArgs(prompt: string, bound: Record<string, unknown>): string {
  return prompt.replace(new RegExp(`\\{\\{\\s*args\\.(${ARG_NAME_CHARS})\\s*\\}\\}`, "gu"), (m, name: string) => {
    const value = bound[name];
    return value === undefined ? m : String(value);
  });
}

/** 测试缝:清缓存 */
export function _resetLibraryCacheForTests(): void {
  cache = null;
}
