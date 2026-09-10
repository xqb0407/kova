"use client";

import { useMemo, type FC } from "react";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector.aui";
import { refreshPiModels, usePiModels } from "@/lib/pi-models";
import type { PiModelSummary } from "@/lib/pi-bridge";
import { setSelectedModel, useSelectedModel } from "@/lib/model-settings";
import { fmtContextWindow } from "@/lib/model-format";

/**
 * 对话页模型选择器：只展示已配置凭据的服务（authed）的模型，按服务分组；
 * 未配置的服务不出现（去设置 → 模型里添加）。选中写入 SQLite 并同步 sidecar。
 */
export const PiModelPicker: FC = () => {
  const allModels = usePiModels();
  const selected = useSelectedModel();

  // 只查配置过的：无凭据的服务整体隐藏，而不是置灰展示
  const models = useMemo(() => allModels.filter((m) => m.authed), [allModels]);

  const byCompositeId = useMemo(() => {
    const map = new Map<string, PiModelSummary>();
    for (const m of models) map.set(`${m.provider}/${m.id}`, m);
    return map;
  }, [models]);

  const options = useMemo<ModelOption[]>(
    () =>
      models.map((m) => ({
        id: `${m.provider}/${m.id}`,
        name: m.name || m.id,
        disabled: !m.authed,
        keywords: [m.provider, m.providerName],
        description: `${m.providerName} · ${fmtContextWindow(m.contextWindow)}`,
      })),
    [models],
  );

  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const o of options) {
      const providerName = byCompositeId.get(o.id)?.providerName ?? o.id;
      const list = map.get(providerName);
      if (list) list.push(o);
      else map.set(providerName, [o]);
    }
    return [...map.entries()];
  }, [options, byCompositeId]);

  const value = selected
    ? `${selected.provider}/${selected.modelId}`
    : undefined;
  const selectedLabel = value
    ? (byCompositeId.get(value)?.name ?? value)
    : undefined;

  return (
    <ModelSelector.Root
      models={options}
      value={value}
      onValueChange={(v) => {
        const sep = v.indexOf("/");
        void setSelectedModel({
          provider: v.slice(0, sep),
          modelId: v.slice(sep + 1),
        });
      }}
      onOpenChange={(open) => open && refreshPiModels()}
    >
      <ModelSelector.Trigger
        variant="ghost"
        size="sm"
        className="h-7 max-w-48 rounded-full [&>span]:min-w-0"
        title={selectedLabel}
      >
        <span className="truncate">
          {selectedLabel ?? (
            <span className="text-muted-foreground">选择模型</span>
          )}
        </span>
      </ModelSelector.Trigger>
      <ModelSelector.Content searchable className="w-80">
        <ModelSelector.Search placeholder="搜索模型..." />
        <ModelSelector.List>
          <ModelSelector.Empty>
            没有可用模型，请在设置 → 模型里添加服务
          </ModelSelector.Empty>
          {groups.map(([providerName, opts]) => (
            <ModelSelector.Group
              key={providerName}
              heading={providerName}
              className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
            >
              {opts.map((o) => (
                <ModelSelector.Item key={o.id} model={o} />
              ))}
            </ModelSelector.Group>
          ))}
        </ModelSelector.List>
      </ModelSelector.Content>
    </ModelSelector.Root>
  );
};
