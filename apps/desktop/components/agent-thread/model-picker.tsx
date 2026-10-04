"use client";

import { useEffect, useMemo, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector.aui";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import { refreshPiModels, usePiModels } from "@/lib/pi/pi-models";
import {
  buildModelOptions,
  groupModelOptions,
  modelOptionId,
} from "@/lib/pi/pi-model-groups";
import { hydrateThreadModel, setThreadModel } from "@/lib/pi/pi-session-model";
import { useModelGate } from "@/lib/pi/pi-model-gate";
import { useSendLock } from "@/lib/pi/pi-send-lock";
import { setSelectedModel } from "@/lib/model/model-settings";
import { cn } from "@/lib/utils";

/**
 * 对话页模型选择器：只展示已配置凭据的服务（authed）的模型，按服务分组；
 * 未配置的服务不出现（去设置 → 模型里添加）。选择经定靶 set_model 只落当前
 * 会话（转录行 + sessions 表偏好列），切回会话时恢复该会话上次使用的模型，
 * 其余会话不受影响；无记忆的会话（含新对话）显示设置页的默认模型，默认模型
 * 被删时收口成「请选择模型」占位并由发送闸门引导重选（见 pi-model-gate）。
 *
 * 发送锁（useSendLock）：消息发送完成前（在跑/排队待派发）禁止切换模型，
 * 见 pi-send-lock 头注。
 *
 * 选项与分组由 pi-model-groups 统一构造（与设置页、自动化弹窗同一份逻辑）：
 * 行内 mark 按模型认厂家、分组标题按服务认，见 lib/model/provider-brand。
 */
export const PiModelPicker: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const modelLocked = useSendLock();
  const allModels = usePiModels();
  const gate = useModelGate();

  // 切线程时水合该会话记住的模型（无记忆则回落设置页的默认模型）
  useEffect(() => {
    if (!threadId) return;
    hydrateThreadModel(threadId);
  }, [threadId]);

  // 只查配置过的：无凭据的服务整体隐藏；被模型过滤隐藏的（enabled=false）也不出现
  const models = useMemo(
    () => allModels.filter((m) => m.authed && m.enabled !== false),
    [allModels],
  );

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) map.set(modelOptionId(m), m.name || m.id);
    return map;
  }, [models]);

  const options = useMemo<ModelOption[]>(
    () => buildModelOptions(models),
    [models],
  );

  const groups = useMemo(
    () => groupModelOptions(models, options),
    [models, options],
  );

  // 只展示「还可用」的选择：provider 被删/停用后会话级记忆仍指着那个模型，
  // 直接显示会是一个目录里不存在的裸 provider/modelId（看着像 bug）。
  // 不可用时回落「请选择模型」占位，由发送闸门把用户引到重新选择（见 pi-model-gate）
  const value = gate.selected
    ? `${gate.selected.provider}/${gate.selected.modelId}`
    : undefined;
  const selectedLabel = value ? (nameById.get(value) ?? value) : undefined;

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
        className="h-7 max-w-48 rounded-full [&>span]:min-w-0 @max-2xl:px-2"
        disabled={modelLocked}
        title={modelLocked ? "消息发送完成前禁止切换模型" : selectedLabel}
      >
        {/* 触发器自带 children，ModelSelector.Value 那条默认渲染路径不会走：
            mark 得自己渲染。窄栏只留 mark（名单收进 title、chevron 保留），
            占位「请选择模型」是行动指引而非读数，窄栏照常显示文字 */}
        {gate.selected && (
          <ProviderIcon
            provider={gate.selected.provider}
            modelId={gate.selected.modelId}
            providerName={
              models.find((m) => modelOptionId(m) === value)?.providerName
            }
          />
        )}
        <span className={cn("truncate", selectedLabel && "@max-2xl:hidden")}>
          {selectedLabel ?? (
            <span className="text-muted-foreground">请选择模型</span>
          )}
        </span>
      </ModelSelector.Trigger>
      <ModelSelector.Content searchable className="w-80">
        <ModelSelector.Search placeholder="搜索模型..." />
        <ModelSelector.List>
          <ModelSelector.Empty>
            没有可用模型，请在设置 → 模型里添加服务
          </ModelSelector.Empty>
          {groups.map((group) => (
            <ModelSelector.Group
              key={group.title}
              heading={group.title}
              className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium"
            >
              {group.options.map((o) => (
                <ModelSelector.Item key={o.id} model={o} />
              ))}
            </ModelSelector.Group>
          ))}
        </ModelSelector.List>
      </ModelSelector.Content>
    </ModelSelector.Root>
  );
};
