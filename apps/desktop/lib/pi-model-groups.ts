import type { ModelOption } from "@/components/assistant-ui/elements/model-selector";
import type { PiModelSummary } from "@/lib/pi-bridge";
import { fmtContextWindow } from "@/lib/model-format";

/**
 * 模型选择器的纯逻辑：目录 -> ModelOption 列表 + 按服务分组。
 * 复合 id = "provider/modelId"（不同服务可能有同名模型 id）。
 */

/** 目录模型的复合 id */
export function modelOptionId(m: PiModelSummary): string {
  return `${m.provider}/${m.id}`;
}

/** 从复合 id 解析回 provider / modelId */
export function splitModelOptionId(
  id: string,
): { provider: string; modelId: string } {
  const sep = id.indexOf("/");
  return { provider: id.slice(0, sep), modelId: id.slice(sep + 1) };
}

/** 目录 -> 选择器选项（未配置凭据的服务置灰，搜索关键词含服务 id 与名称） */
export function buildModelOptions(models: PiModelSummary[]): ModelOption[] {
  return models.map((m) => ({
    id: modelOptionId(m),
    name: m.name || m.id,
    disabled: !m.authed,
    keywords: [m.provider, m.providerName],
    description: `${m.providerName} · ${fmtContextWindow(m.contextWindow)}`,
  }));
}

/** 按服务名分组（保持目录顺序）；分组标题取 providerName */
export function groupModelOptions(
  models: PiModelSummary[],
  options: ModelOption[],
): [string, ModelOption[]][] {
  const providerNameById = new Map(
    models.map((m) => [modelOptionId(m), m.providerName]),
  );
  const map = new Map<string, ModelOption[]>();
  for (const o of options) {
    const providerName = providerNameById.get(o.id) ?? o.id;
    const list = map.get(providerName);
    if (list) list.push(o);
    else map.set(providerName, [o]);
  }
  return [...map.entries()];
}
