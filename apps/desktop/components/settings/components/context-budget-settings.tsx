"use client";

import { useEffect, type FC } from "react";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  LOOP_GUARD_ID,
  TOOL_BUDGET_ID,
  initCapabilitiesConfig,
  setLoopGuardEnabled,
  setToolBudgetEnabled,
  useCapabilitiesSnapshot,
  type CapabilitiesSaveResult,
} from "@/lib/settings/capabilities-config";

/**
 * 上下文预算区块（设置 → 智能体 → 智能体配置）——控制"对话里放什么、放多少"。
 *
 * 与「电脑控制」的边界：那组开关决定 AI 能碰本机的什么（授权），这组只调整
 * 上下文的管理方式，不扩大能力边界：
 * - 大输出外置（tool-budget）：超限工具输出存为会话文件，对话里只留可回查路径。
 *   默认开启；写盘失败会降级为头尾预览，不阻断工具调用。
 * - 重复失败提醒（loop-guard，实验性）：同一调用连续失败时注入一次纠偏提醒。
 *   默认关闭；开启即 steer（shadow 只写日志，作为用户开关不可感知）。
 *
 * 事实源在 sidecar（SQLite kv pi.capabilities），即改即生效；这里只做镜像。
 * set_capabilities 是全量覆盖，镜像层负责合并（见 lib/settings/capabilities-config）。
 */
export const ContextBudgetSettings: FC = () => {
  const capabilities = useCapabilitiesSnapshot();
  const toolBudget = capabilities.enabled[TOOL_BUDGET_ID] === true;
  const loopGuard = capabilities.enabled[LOOP_GUARD_ID] === true;

  // 模块加载那次水合可能早于 sidecar 就绪（失败不 latch）：挂载时补一次。
  // 拔开关时镜像仍会先 GET 真值，所以这里失败只是显示层晚一拍。
  useEffect(() => {
    void initCapabilitiesConfig();
  }, []);

  const save = async (action: () => Promise<CapabilitiesSaveResult>) => {
    try {
      const { reloadFailures } = await action();
      if (reloadFailures.length > 0) {
        toast.warning({
          title: "部分会话将在下一轮生效",
          description: "有会话正在运行，本次开关对它们在下一次请求时生效。",
        });
      }
    } catch {
      toast.error("保存失败，请重试");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold">上下文预算</h2>
      <p className="text-muted-foreground text-sm">
        控制对话上下文里放什么、放多少。两道闸都即时生效，会话进行中也可以切换。
      </p>
      <div className="bg-muted/50 mt-1 flex flex-col rounded-2xl p-2">
        <SettingRow
          label="大输出外置"
          desc="超过阈值（默认 32KB，可在协议层配置）的工具输出会存为会话文件，对话中只保留可回查的文件路径；AI 按需检索，长会话更省上下文。关闭后不再外置（仍受各工具自身的输出上限约束）。"
        >
          <Switch
            checked={toolBudget}
            onCheckedChange={(v) => {
              void save(() => setToolBudgetEnabled(v));
            }}
          />
        </SettingRow>
        <SettingRow
          label="重复失败提醒（实验性）"
          desc="AI 连续重复同一个失败的调用时，向它注入一次纠偏提醒。实验性功能：提醒文案与触发阈值可能随使用反馈调整。"
        >
          <Switch
            checked={loopGuard}
            onCheckedChange={(v) => {
              void save(() => setLoopGuardEnabled(v));
            }}
          />
        </SettingRow>
      </div>
    </section>
  );
};
