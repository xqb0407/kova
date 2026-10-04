/**
 * 文生图配置（设置 → 模型 → 文生图）：控制 generate_image 工具可用性。
 * 配置整包存 SQLite kv（key = IMAGEGEN_KV_KEY），前端经协议 get/set_imagegen 访问。
 * 工具在 tools.ts buildTools 常驻注册（工具表变更会破坏 Anthropic tools 块缓存，
 * 故不按开关增删），execute 时实时读配置门控（与 browser/memory 同款机制）——
 * 关闭/未配置时婉拒并给模型替代路径，运行中的会话下一次调用即生效。
 * 默认关闭：生图按张计费，开了才可调。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export const IMAGEGEN_KV_KEY = "pi.imagegen";

/** 文生图设置整包（kv 与协议共用同一形状） */
export type ImageGenConfig = {
  /** 总开关：关闭时 generate_image 一律婉拒 */
  enabled: boolean;
  /** 生图模型所属 provider id（"" = 未配置） */
  provider: string;
  /** 生图模型 id（需已注册进该 provider 的模型目录） */
  modelId: string;
  /** 默认尺寸：透传 OpenAI images 协议 size 参数（如 "1024x1024"，"auto" 由服务端定） */
  size: string;
  /** 标记为"可生图"的模型清单（"provider/modelId"）：models 表无该列（改它要动
   *  Rust DB），故与思考映射同款覆盖层落这里；list_models 据此透出 t2i，设置页
   *  文生图默认模型下拉只列 t2i 模型。 */
  imageModels: string[];
};

export const DEFAULT_IMAGEGEN_CONFIG: ImageGenConfig = {
  enabled: false,
  provider: "",
  modelId: "",
  size: "1024x1024",
  imageModels: [],
};

/** 任意来源（kv JSON / 协议消息）的宽松规整：布尔取真值，字符串去空白 */
export function normalizeImageGenConfig(raw: unknown): ImageGenConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  // imageModels 去空白、去重、丢弃空项（非数组回落空清单）
  const imageModels = Array.isArray(r.imageModels)
    ? [...new Set(r.imageModels.map((x) => str(x)).filter((x) => x))]
    : [];
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_IMAGEGEN_CONFIG.enabled,
    provider: str(r.provider),
    modelId: str(r.modelId),
    size: str(r.size) || DEFAULT_IMAGEGEN_CONFIG.size,
    imageModels,
  };
}

let current: ImageGenConfig = { ...DEFAULT_IMAGEGEN_CONFIG };

export function getImageGenConfig(): ImageGenConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initImageGenConfig(): Promise<void> {
  try {
    const row = await kvGet(IMAGEGEN_KV_KEY);
    if (row?.value) current = normalizeImageGenConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("imagegen-config: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv；可传覆盖片段（如直接置为已配置态） */
export function resetImageGenConfigForTest(
  next?: Partial<ImageGenConfig>,
): void {
  current = { ...DEFAULT_IMAGEGEN_CONFIG, ...(next ?? {}) };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyImageGenConfig(raw: unknown): Promise<ImageGenConfig> {
  const next = normalizeImageGenConfig(raw);
  current = next;
  try {
    await kvSet(IMAGEGEN_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("imagegen-config: persist failed:", err);
  }
  return next;
}
