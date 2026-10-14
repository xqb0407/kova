"use client";

import type { ModelOption } from "@/components/assistant-ui/elements/model-selector";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import { fmtContextWindow } from "@/lib/model/model-format";

/**
 * 模型选择器的纯逻辑：目录 -> ModelOption 列表 + 按服务分组。
 * 复合 id = "provider/modelId"（不同服务可能有同名模型 id）。
 * 行内 mark 按模型认厂家（聚合/网关服务下每行是不同厂家的模型），
 * 分组 mark 按服务认（口径见 lib/model/provider-brand）。
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
    icon: (
      <ProviderIcon
        provider={m.provider}
        modelId={m.id}
        providerName={m.providerName}
      />
    ),
  }));
}

/** 一组模型 = 一个服务（同名服务合并成一组） */
export type ModelOptionGroup = {
  /** 分组标题（服务名，如 "Anthropic"）——纯文字标签，不挂服务 mark：
   *  模型列表里行内已经是模型图标，标题再来一个同品牌的会重复一次 */
  title: string;
  options: ModelOption[];
};

/** 按服务名分组（保持目录顺序）；标题取 providerName */
export function groupModelOptions(
  models: PiModelSummary[],
  options: ModelOption[],
): ModelOptionGroup[] {
  const byProviderName = new Map(
    models.map((m) => [modelOptionId(m), m.providerName]),
  );
  const byTitle = new Map<string, ModelOptionGroup>();
  for (const o of options) {
    // 目录里查不到的选项（服务已删除等）回落复合 id 作标题，别把同一组拆散
    const title = byProviderName.get(o.id) ?? o.id;
    const group = byTitle.get(title);
    if (group) group.options.push(o);
    else byTitle.set(title, { title, options: [o] });
  }
  return [...byTitle.values()];
}
