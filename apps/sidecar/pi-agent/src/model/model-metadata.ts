/**
 * 自定义端点 `/models` 响应的元数据抽取（「获取列表」预填用）。
 *
 * 解析已统一收敛到 model/dynamic-discovery.ts 的 parseDiscoveredModels（与动态
 * 发现共用同一套字段别名/信封/单行降级规则）；本文件只保留 fetch_models 应答的
 * 投影形状：models = id 列表，details = 带窗口元数据的子集（contextLength 命名
 * 沿用旧协议字段）。fetch 路径不做非对话过滤——用户仍可手动添加图片模型走 imagegen。
 */
import {
  parseDiscoveredModels,
  type DiscoveredModel,
} from "./dynamic-discovery";

export type FetchedModelDetail = {
  id: string;
  contextLength?: number;
  maxTokens?: number;
};

/** 已解析模型 → fetch_models 的旧回执形状（models = id 列表，details = 带元数据子集） */
export function fetchedFromDiscoveredModels(
  models: readonly DiscoveredModel[],
): {
  models: string[];
  details: FetchedModelDetail[];
} {
  return {
    models: models.map((model) => model.id),
    details: models
      .filter(
        (model) => model.contextWindow !== undefined || model.maxTokens !== undefined,
      )
      .map((model) => ({
        id: model.id,
        ...(model.contextWindow !== undefined
          ? { contextLength: model.contextWindow }
          : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      })),
  };
}

/**
 * 从 `/models` JSON（`{data:[...]}` / `{models:[...]}` / 裸数组）抽取 id 与常见
 * 窗口元数据。顺序保留，id 去重；只有至少带一个元数据字段的条目才进 details。
 */
export function parseFetchedModelList(payload: unknown): {
  models: string[];
  details: FetchedModelDetail[];
} {
  return fetchedFromDiscoveredModels(parseDiscoveredModels(payload));
}
