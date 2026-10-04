"use client";

import { useAuiState } from "@assistant-ui/react";
import { toast } from "@/components/ui/toast";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import { usePiModels } from "@/lib/pi/pi-models";
import { useThreadModel } from "@/lib/pi/pi-session-model";
import type { SelectedModel } from "@/lib/model/model-settings";

/**
 * 模型选择的可用性闸门：发送入口据此决定放不放行。
 *
 * 两种「不可用」，都要挡住：
 * 1. 压根没选（无会话记忆且默认模型缺失）。sidecar 的 resolveCurrentModel 在
 *    无选择时静默取目录里第一个有凭据的模型（defaultModel），界面却显示
 *    「请选择模型」占位——用户看到的与
 *    实际应答的模型不是一回事。
 * 2. 选了，但那个模型已经不在目录里了：用户删掉/停用 provider 后，sidecar 只清
 *    全局选中键（handlers/providers.ts），会话级记忆（sessions 偏好列 + 转录里的
 *    model_change）原样留着；hydrateThreadModel 照样把它恢复出来。此时发送会
 *    在 sidecar 侧「记日志并回落默认」——用一个界面上没显示的模型应答，或在
 *    没有任何凭据时直接报错。
 *
 * 取值口径与 model-picker 展示的候选集完全一致（同一个 useThreadModel + 同一套
 * 「配了凭据且未被模型过滤隐藏」过滤），避免「界面说有模型、闸门说没有」。
 */

export type ModelGateHint =
  | "先选择模型，再发送消息"
  | "原模型已不可用，请重新选择";

export type ModelGate = {
  /** 当前选择能否发消息 */
  usable: boolean;
  /** 不可用时的说明（tooltip / 占位文案 / toast 共用一句） */
  hint: ModelGateHint | null;
  /** 界面上还有没有可展示的选择（不可用时让选择器回落到「请选择模型」占位，
   *  而不是显示一个目录里已经不存在的裸 provider/modelId） */
  selected: SelectedModel | null;
};

/** 目录里还能不能找到这个选择；null = 目录里没有 */
function findUsable(
  models: PiModelSummary[],
  selected: SelectedModel,
): PiModelSummary | null {
  return (
    models.find(
      (m) =>
        m.provider === selected.provider &&
        m.id === selected.modelId &&
        m.authed &&
        m.enabled !== false,
    ) ?? null
  );
}

export function useModelGate(): ModelGate {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const selected = useThreadModel(threadId);
  const models = usePiModels();
  if (!selected) {
    return { usable: false, hint: "先选择模型，再发送消息", selected: null };
  }
  // 目录没加载出来时不做判定：网页预览恒空，远程模式的模型真值在 sidecar 侧
  // （目录要经 Tauri invoke 拉，远程拿不到）——不能拿一个空目录否决真实选择
  if (models.length === 0) {
    return { usable: true, hint: null, selected };
  }
  if (findUsable(models, selected)) {
    return { usable: true, hint: null, selected };
  }
  return {
    usable: false,
    hint: "原模型已不可用，请重新选择",
    selected: null,
  };
}

let lastHintAt = 0;

/** 发送被闸门拦下时的一次性提示：3s 内不重复弹（连按 Enter 不刷屏） */
export function notifyNoModelSelected(hint: string): void {
  const now = Date.now();
  if (now - lastHintAt < 3000) return;
  lastHintAt = now;
  toast.error(hint);
}
