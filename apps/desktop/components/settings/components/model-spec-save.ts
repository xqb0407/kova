import type {
  PiCustomModelSpec,
  PiModelCost,
  PiStoredModelAttrs,
} from "@/lib/pi/pi-bridge";

/**
 * 编辑自定义服务时，逐个模型算"这次要提交什么属性"。
 *
 * 编辑弹窗预填的是**生效值**（行值 ?? 目录种子 ?? 缺省猜测），若保存时把整份
 * 生效值原样发回去，sidecar 会当成用户显式填写写进模型行——目录真值从此被冻
 * 死在行里：之后目录更新盖不过，modelId 加了命名空间前缀被归一化命中（见
 * sidecar catalog.lookupCatalogModelSeed）也盖不过，缺省猜测值更是永远洗不掉。
 *
 * 所以只回写用户**真正改过**的字段：
 * - 改过：发当前值（清空 = 不发 = 行置 null，回到继承态）；
 * - 没改：回填行里原有的显式值（行里没有就不发 → 同样是继承态）。
 *
 * 已知边界：模型是本次弹窗新加的（`loaded` 缺席）时，属性弹窗里由目录种子异步
 * 预填的值无法与用户手填区分，会被当成"改过"提交。既有服务走行值基线，不受影响。
 */
export function mergeModelSpecForSave({
  id,
  current,
  loaded,
  stored,
}: {
  id: string;
  /** 弹窗当前值（用户在属性弹窗里改过就是新值）；缺席 = 本次没进过属性编辑 */
  current?: PiCustomModelSpec;
  /** 打开弹窗时回填的生效值（对比基线） */
  loaded?: PiCustomModelSpec;
  /** 行里显式存过的值（null = 继承态） */
  stored?: PiStoredModelAttrs | null;
}): PiCustomModelSpec {
  // 没进过属性编辑（无草稿）= 整份都算"没改"
  const untouched = (same: boolean) => current === undefined || same;

  const out: PiCustomModelSpec = { id };

  const name = untouched(current?.name === loaded?.name)
    ? (stored?.name ?? undefined)
    : current?.name;
  if (name) out.name = name;

  const reasoning = untouched(current?.reasoning === loaded?.reasoning)
    ? (stored?.reasoning ?? undefined)
    : current?.reasoning;
  if (reasoning !== undefined) out.reasoning = reasoning;

  const contextWindow = untouched(
    current?.contextWindow === loaded?.contextWindow,
  )
    ? (stored?.contextWindow ?? undefined)
    : current?.contextWindow;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;

  const maxTokens = untouched(current?.maxTokens === loaded?.maxTokens)
    ? (stored?.maxTokens ?? undefined)
    : current?.maxTokens;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;

  const input = untouched(sameInput(current?.input, loaded?.input))
    ? (stored?.input ?? undefined)
    : current?.input;
  if (input?.length) out.input = input;

  const cost = untouched(sameCost(current?.cost, loaded?.cost))
    ? (stored?.cost ?? undefined)
    : current?.cost;
  if (cost) out.cost = cost;

  return out;
}

/** 模态集合比较：顺序无关（目录可能给 ["image","text"]，弹窗按勾选重建） */
function sameInput(a?: string[], b?: string[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return [...a].sort().join(",") === [...b].sort().join(",");
}

/** 单价四项数值比较：不依赖键序（目录对象与弹窗重建对象的键序未必一致） */
function sameCost(a?: Partial<PiModelCost>, b?: Partial<PiModelCost>): boolean {
  if (a === undefined || b === undefined) return a === b;
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  return fields.every((f) => (a[f] ?? 0) === (b[f] ?? 0));
}
