"use client";

import { useEffect, useMemo, useState, type FC } from "react";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { ProviderIcon } from "@/components/custom-ui/provider-icon";
import { Input } from "@/components/ui/input";
import {
  ModelSelector,
  type ModelOption,
} from "@/components/assistant-ui/elements/model-selector.aui";
import { usePiModels } from "@/lib/pi/pi-models";
import {
  buildModelOptions,
  groupModelOptions,
  modelOptionId,
  splitModelOptionId,
} from "@/lib/pi/pi-model-groups";
import { toast } from "@/components/ui/toast";
import { ShieldCheckIcon } from "lucide-react";
import {
  AUTO_REVIEW_DEFAULT_TIMEOUT_MS,
  AUTO_REVIEW_MAX_TIMEOUT_MS,
  AUTO_REVIEW_MIN_TIMEOUT_MS,
  saveAutoReviewSettings,
  useAutoReviewSettings,
} from "@/lib/pi/auto-review";

/**
 * AI 审查区块（设置 → 智能体 → 智能体配置）。
 *
 * 这里只配「审查用哪个模型、等多长时间」；审查什么时候发生由权限档决定
 * （底栏选「AI 审查」），判定口径与失败回退见 sidecar 的 permissions/auto-review.ts。
 * 事实源在 sidecar（SQLite kv 键 pi.autoReview），本区块只是镜像：
 * 保存乐观更新、失败回滚并 toast（与钩子/追踪同款链路）。
 * 只出区块：页面骨架在 agent-config-settings，与本区块同页的还有电脑控制。
 */

const FOLLOW_ID = "follow";
const FOLLOW_OPTION: ModelOption = {
  id: FOLLOW_ID,
  name: "跟随会话模型",
  description: "用当前会话正在用的模型审查（缺省）",
};

export const AutoReviewSettings: FC = () => {
  const settings = useAutoReviewSettings();
  const models = usePiModels();
  // 与 composer/任务编辑器的模型选择器同规则：只列已配置凭据且未被禁用的模型
  const list = useMemo(() => models.filter((m) => m.authed && m.enabled !== false), [models]);
  const options = useMemo<ModelOption[]>(
    () => [FOLLOW_OPTION, ...buildModelOptions(list)],
    [list],
  );
  const groups = useMemo(
    () => groupModelOptions(list, options.filter((o) => o.id !== FOLLOW_ID)),
    [list, options],
  );

  const value = settings.model
    ? `${settings.model.provider}/${settings.model.modelId}`
    : FOLLOW_ID;
  const selectedLabel = settings.model
    ? (list.find((m) => modelOptionId(m) === value)?.name ??
      `${settings.model.provider}/${settings.model.modelId}`)
    : FOLLOW_OPTION.name;

  const save = (next: Parameters<typeof saveAutoReviewSettings>[0]) => {
    saveAutoReviewSettings(next).catch(() => toast.error("保存失败，请重试"));
  };

  const pickModel = (id: string) => {
    // 选「跟随会话模型」= 删掉覆盖项，不写一个假的 provider/modelId
    if (id === FOLLOW_ID) save({ ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}) });
    else save({ model: splitModelOptionId(id), ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}) });
  };

  // 超时用秒显示；本地缓冲 + 失焦/回车提交（边输边存会把 "3" 这种半截值写进去）
  const effectiveTimeoutMs = settings.timeoutMs ?? AUTO_REVIEW_DEFAULT_TIMEOUT_MS;
  const [timeoutText, setTimeoutText] = useState(String(Math.round(effectiveTimeoutMs / 1000)));
  useEffect(() => {
    setTimeoutText(String(Math.round(effectiveTimeoutMs / 1000)));
  }, [effectiveTimeoutMs]);

  const commitTimeout = () => {
    const seconds = Number(timeoutText.trim());
    if (!Number.isFinite(seconds)) {
      setTimeoutText(String(Math.round(effectiveTimeoutMs / 1000)));
      return;
    }
    const ms = Math.min(
      Math.max(Math.round(seconds * 1000), AUTO_REVIEW_MIN_TIMEOUT_MS),
      AUTO_REVIEW_MAX_TIMEOUT_MS,
    );
    save({ ...(settings.model ? { model: settings.model } : {}), timeoutMs: ms });
    setTimeoutText(String(Math.round(ms / 1000)));
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        AI 审查
      </h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        权限档选「AI 审查」时，每个要动手的工具调用先由模型判一次风险：低风险直接执行，
        高风险拦截。审查失败会退回审批卡由你确认，不会静默放行。
      </p>

      <div className="bg-muted/50 divide-none mt-1 flex flex-col rounded-2xl p-2">
        <SettingRow
          label="审查模型"
          desc="缺省跟随当前会话模型。每次都多一次模型请求——选个便宜的模型更省。"
        >
          <ModelSelector.Root models={options} value={value} onValueChange={pickModel}>
            <ModelSelector.Trigger
              variant="outline"
              size="sm"
              className="max-w-56 [&>span]:min-w-0 bg-background border-none"
              title={selectedLabel}
            >
              {settings.model && (
                <ProviderIcon
                  provider={settings.model.provider}
                  modelId={settings.model.modelId}
                  providerName={list.find((m) => modelOptionId(m) === value)?.providerName}
                />
              )}
              <span className="truncate">{selectedLabel}</span>
            </ModelSelector.Trigger>
            <ModelSelector.Content searchable className="w-80">
              <ModelSelector.Search placeholder="搜索模型…" />
              <ModelSelector.List>
                <ModelSelector.Item model={FOLLOW_OPTION} />
                <ModelSelector.Empty>没有可用模型，请在设置 → 模型里添加服务</ModelSelector.Empty>
                {groups.map((group) => (
                  <ModelSelector.Group key={group.title} heading={group.title}>
                    {group.options.map((o) => (
                      <ModelSelector.Item key={o.id} model={o} />
                    ))}
                  </ModelSelector.Group>
                ))}
              </ModelSelector.List>
            </ModelSelector.Content>
          </ModelSelector.Root>
        </SettingRow>

        <SettingRow label="单次审查超时" desc="超时按审查失败处理（退回审批卡）。单位秒，5–120。">
          <div className="bg-background flex h-8 items-center gap-1 rounded-md  px-2">
            <Input
              value={timeoutText}
              inputMode="numeric"
              onChange={(e) => setTimeoutText(e.target.value)}
              onBlur={commitTimeout}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="h-auto w-12 border-none bg-transparent p-0 text-right text-sm rounded-none shadow-none focus-visible:ring-0"
            />
            <span className="text-muted-foreground text-[13px] leading-5">秒</span>
          </div>
        </SettingRow>
      </div>

      <p className="text-muted-foreground border-border/50 mt-1 border-t px-1 pt-2 text-[13px] leading-relaxed">
        审查范围：内置工具（bash / 写入 / 配置类）与 MCP 工具调用；你记过的可写根与命令前缀
        仍然直接放行，不再送审。无人值守的定时任务不走这一档。
      </p>
    </section>
  );
};
