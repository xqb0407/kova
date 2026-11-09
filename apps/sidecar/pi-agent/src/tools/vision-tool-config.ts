/**
 * 视觉辅助（see_image 工具）配置（设置 → 模型 → 视觉辅助）。
 * 配置整包存 SQLite kv（key = VISION_TOOL_KV_KEY），前端经协议 get/set_vision_tool 访问。
 *
 * 开关关闭（默认）时的硬约束——提示词零污染：
 * - buildTools 不注册 see_image（工具表与未引入该能力前逐字节一致）；
 * - streamFn 不做图片占位替换（请求上下文与未引入该能力前逐字节一致）；
 * - 系统提示词不含任何工具清单，天然不受影响。
 * 开关翻转由 preferences 的 set_vision_tool 调 reloadVisionTools 重建活动会话
 * 工具表（与记忆开关同机制），关闭后工具立即从工具表消失，无需重启。
 *
 * 视觉模型的选择落在本配置：provider/modelId 显式指定（设置页下拉），
 * 任一为空 = 自动挑选（see-image-tool.ts 内同 provider 优先、其次低价）；
 * `PI_VISION_MODEL=provider/modelId` 仍可覆盖自动档（优先级：显式指定 >
 * env > 自动）。指定项在目录里查不到时回落并记日志。
 */
import { kvGet, kvSet } from "../storage/hostdb";
import { logErr } from "../log";

export const VISION_TOOL_KV_KEY = "pi.visionTool";

/** 视觉辅助设置整包（kv 与协议共用同一形状） */
export type VisionToolConfig = {
  /** 总开关：关闭时不注册 see_image、不做图片占位替换（默认关，防提示词污染） */
  enabled: boolean;
  /** 显式指定的视觉辅助模型 provider（"" = 自动挑选，缺省） */
  provider: string;
  /** 显式指定的视觉辅助模型 id（与 provider 成对；在目录里查不到/不支持图像
   *  输入时按自动挑选回落并记日志） */
  modelId: string;
};

export const DEFAULT_VISION_TOOL_CONFIG: VisionToolConfig = {
  enabled: false,
  provider: "",
  modelId: "",
};

/** 任意来源（kv JSON / 协议消息）的宽松规整：布尔取真值，字符串去空白。
 *  模型选择独立于开关存储（关掉再开不丢选择）；成对才有效，任一为空都按
 *  「自动挑选」存空串，避免半配置态。 */
export function normalizeVisionToolConfig(raw: unknown): VisionToolConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const provider = str(r.provider);
  const modelId = str(r.modelId);
  return {
    enabled: r.enabled === true,
    provider: provider && modelId ? provider : "",
    modelId: provider && modelId ? modelId : "",
  };
}

let current: VisionToolConfig = { ...DEFAULT_VISION_TOOL_CONFIG };

export function getVisionToolConfig(): VisionToolConfig {
  return current;
}

/** 启动恢复：kv 里的整包 JSON 载入内存；失败保持默认（不阻断启动） */
export async function initVisionToolConfig(): Promise<void> {
  try {
    const row = await kvGet(VISION_TOOL_KV_KEY);
    if (row?.value) current = normalizeVisionToolConfig(JSON.parse(row.value));
  } catch (err) {
    logErr("vision-tool-config: load failed:", err);
  }
}

/** 测试辅助：仅清内存不落 kv；可传覆盖片段（如直接置为已开启态） */
export function resetVisionToolConfigForTest(
  next?: Partial<VisionToolConfig>,
): void {
  current = { ...DEFAULT_VISION_TOOL_CONFIG, ...(next ?? {}) };
}

/** 应用新设置：内存即时生效并落 kv；持久化失败仅记日志（下次启动回落） */
export async function applyVisionToolConfig(
  raw: unknown,
): Promise<VisionToolConfig> {
  const next = normalizeVisionToolConfig(raw);
  current = next;
  try {
    await kvSet(VISION_TOOL_KV_KEY, JSON.stringify(next));
  } catch (err) {
    logErr("vision-tool-config: persist failed:", err);
  }
  return next;
}
