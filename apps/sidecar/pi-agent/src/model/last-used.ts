/**
 * 最近使用模型缓存（kv pi.model.lastUsed）。
 *
 * 与「默认模型」（kv pi.model）分工：
 * - 默认模型 = 设置页显式选择的兜底值；
 * - lastUsed = 用户最后一次主动切换的模型，**只用于新会话的初始选择**。
 *
 * 新会话优先级：lastUsed（可用）→ 默认模型（可用）→ 无选择。
 * 已建会话仍只认自己的偏好列/转录行，不会被 lastUsed 漂移波及；缓存失效时
 * 直接改写成默认模型（默认也不可用则清空），避免界面长期指向一个不存在的模型。
 *
 * 存在 sidecar 而不是前端：桌面 / 远程网页 / ACP 共用同一份缓存。
 */
import { logErr } from "../log";
import { kvGet, kvSet, modelsAll } from "../storage/hostdb";
import { getModels, isCustomProvider } from "./catalog";
import { normalizeProviderId } from "./provider-id";
import { getCurrentModelKey } from "./state";

export type LastUsedModelKey = { provider: string; modelId: string };

const KV_KEY = "pi.model.lastUsed";

let lastUsedModelKey: LastUsedModelKey | null = null;

export function getLastUsedModelKey(): LastUsedModelKey | null {
  return lastUsedModelKey;
}

/** 启动恢复（catalogReady 闸门内调用）：只写内存键，目录/凭据校验交给 reconcile */
export async function initLastUsedModelKey(): Promise<void> {
  try {
    const raw = await kvGet(KV_KEY);
    if (!raw?.value) return;
    const saved = JSON.parse(raw.value) as {
      provider?: unknown;
      modelId?: unknown;
    } | null;
    if (
      typeof saved?.provider === "string" &&
      saved.provider &&
      typeof saved.modelId === "string" &&
      saved.modelId
    ) {
      lastUsedModelKey = {
        provider: normalizeProviderId(saved.provider),
        modelId: saved.modelId,
      };
    } else {
      // 显式 null 占位（清空过）：内存态也要跟着归零
      lastUsedModelKey = null;
    }
  } catch (err) {
    logErr("last-used model restore failed:", err);
  }
}

/** 写入内存 + kv（显式 null 占位，避免重启把已失效的键读回来） */
export async function setLastUsedModelKey(
  key: LastUsedModelKey | null,
): Promise<void> {
  lastUsedModelKey = key
    ? { provider: normalizeProviderId(key.provider), modelId: key.modelId }
    : null;
  try {
    await kvSet(
      KV_KEY,
      lastUsedModelKey ? JSON.stringify(lastUsedModelKey) : "null",
    );
  } catch (err) {
    logErr("last-used model persist failed:", err);
  }
}

/**
 * 是否可被新会话选中：目录里存在 + 有凭据 + 未被模型过滤隐藏。
 * 可见性口径与 list_models 的候选集一致（内置厂商有行时按行 enable，
 * 自定义服务无行默认可见）。
 *
 * models 表读不到时返回 true（不否决）：缓存只是偏好，数据库异常不能反过来
 * 把用户的选择清掉。
 */
export async function isSelectableModel(
  provider: string,
  modelId: string,
): Promise<boolean> {
  const model = getModels().getModel(provider, modelId);
  if (!model) return false;
  // 「没配凭据」是否决；「查凭据失败」不能否决（宿主暂时不可用时别把缓存清掉）
  let authed: boolean;
  try {
    authed = (await getModels().getAuth(provider)) !== undefined;
  } catch {
    return true;
  }
  if (!authed) return false;
  let rows: Awaited<ReturnType<typeof modelsAll>>;
  try {
    rows = await modelsAll();
  } catch {
    return true;
  }
  const hasRows = rows.some((r) => r.provider === provider);
  const row = rows.find(
    (r) => r.provider === provider && r.modelId === modelId,
  );
  if (!isCustomProvider(provider) && hasRows) return row?.enabled === true;
  return row?.enabled !== false;
}

/**
 * 缓存自愈：lastUsed 不可用 → 改成默认模型；默认也不可用 → 清空。
 * 返回自愈后的有效缓存。
 */
export async function reconcileLastUsedModel(): Promise<LastUsedModelKey | null> {
  const snapshot = lastUsedModelKey;
  if (!snapshot) return null;
  // 自愈期间用户可能刚好切了模型（set_model / get_model 并发）：快照对不上
  // 就放弃本次改写，绝不覆盖更新的选择
  const unchanged = () => lastUsedModelKey === snapshot;
  if (await isSelectableModel(snapshot.provider, snapshot.modelId)) {
    return unchanged() ? snapshot : lastUsedModelKey;
  }
  const fallback = getCurrentModelKey();
  if (
    fallback &&
    (await isSelectableModel(fallback.provider, fallback.modelId))
  ) {
    if (!unchanged()) return lastUsedModelKey;
    await setLastUsedModelKey(fallback);
    return lastUsedModelKey;
  }
  if (!unchanged()) return lastUsedModelKey;
  await setLastUsedModelKey(null);
  return null;
}
