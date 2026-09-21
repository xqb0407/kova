/**
 * 模型目录：pi-ai 内置 catalog（39 个 provider） + 本地凭据 + models 统一模型表。
 * - models 表行（provider, model_id 主键）承载启用状态与属性覆盖；
 *   NULL 属性 = 继承内置目录值。内置厂商的过滤（勾选集）与属性修改都写这张表。
 * - 自定义端点的模型同样存 models 表（enabled=1），注册时 NULL 属性先按 modelId 反查
 *   内置目录继承同名模型的真值，未命中才取自定义默认值。
 * - 内置厂商的目录外新增模型（手动添加的 modelId）也存 models 表：行存在但目录没有
 *   时按行构造 Model 挂到该 provider 上（auth/stream 沿用原实现）。
 * 目录在 initStorage 之后通过 getModels() 惰性创建。
 *
 * 物理布局（本文件为门面，签名与原单文件完全一致）：
 * - ./model/state.ts             当前模型键 + 全局思考档位（kv 恢复）
 * - ./model/catalog.ts           目录单例 + 属性校验/种子反查/缺省归因
 * - ./model/custom-providers.ts  自定义端点注册 + models 覆盖应用 + 目录外新增
 * - ./model/thinking.ts          thinkingLevelMap 覆盖 + 兼容端点缓存路由辅助
 */
export {
  type ModelCatalog,
  getModels,
  defaultModel,
  parseModelInput,
  parseModelCost,
  CUSTOM_MODEL_DEFAULTS,
  type CatalogModelSeed,
  lookupCatalogModelSeed,
  DEFAULT_TRACKED_ATTRS,
  type DefaultedAttr,
  getModelDefaultedAttrs,
} from "./catalog";

export {
  getCurrentModelKey,
  setCurrentModelKey,
  initCurrentModelKey,
  THINKING_LEVELS,
  type ThinkingLevel,
  getCurrentThinkingLevel,
  setCurrentThinkingLevel,
} from "./state";

export {
  normalizeApi,
  registerCustomProvider,
  loadCustomProviders,
  applyModelOverrides,
  attachExtraCatalogModel,
  applyRowToCatalogModel,
} from "./custom-providers";

export {
  normalizeThinkingMap,
  setThinkingMapOverrides,
  applyThinkingMapOverrides,
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
} from "./thinking";
