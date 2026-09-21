"use client";

import { useEffect, useMemo, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector.aui";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import { hydrateThreadModel, setThreadModel, useThreadModel } from "@/lib/pi/pi-session-model";
import { setSelectedModel } from "@/lib/model/model-settings";
import { fmtContextWindow } from "@/lib/model/model-format";

/**
 * 对话页模型选择器：只展示已配置凭据的服务（authed）的模型，按服务分组；
 * 未配置的服务不出现（去设置 → 模型里添加）。选择写入全局（sidecar 广播 + kv）
 * 并记入当前会话的模型记忆（sessions 表偏好列），切回会话时恢复该会话
 * 上次使用的模型。
 */
export const PiModelPicker: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const allModels = usePiModels();
  const selected = useThreadModel(threadId);

  // 切线程时水合该会话记住的模型（无记忆则回落全局当前选择）
  useEffect(() => {
    if (!threadId) return;
    hydrateThreadModel(threadId);
  }, [threadId]);

  // 只查配置过的：无凭据的服务整体隐藏；被模型过滤隐藏的（enabled=false）也不出现
  const models = useMemo(
    () => allModels.filter((m) => m.authed && m.enabled !== false),
    [allModels],
  );

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
        const model = {
          provider: v.slice(0, sep),
          modelId: v.slice(sep + 1),
        };
        if (threadId) {
          void setThreadModel(threadId, model);
        } else {
          // 无主线程上下文（理论不可达）：退化为纯全局选择
          void setSelectedModel(model);
        }
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
