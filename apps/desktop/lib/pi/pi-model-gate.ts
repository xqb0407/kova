"use client";

import { useAuiState } from "@assistant-ui/react";
import { toast } from "@/components/ui/toast";
import { isModelSelectable, usePiModels } from "@/lib/pi/pi-models";
import { useThreadModel } from "@/lib/pi/pi-session-model";
import type { SelectedModel } from "@/lib/model/model-settings";

/**
 * 模型选择的可用性闸门：发送入口据此决定放不放行。
 *
 * 「没选择」与「会话自己的选择失效」都要挡住：
 * 1. 压根没选：新对话的 lastUsed/默认模型都不可用（或已建会话的默认模型都
 *    不可用）时，useThreadModel 已把回退值按目录校验掉，这里显示
 *    「请选择模型」并拦发送。sidecar 的 defaultModel 兜底只留给 ACP/自动化等
 *    非 UI 入口；桌面发送不会静默跑一个界面上没显示的模型。
 * 2. 会话自己显式选过的模型已经不在目录里：删掉/停用 provider 后会话级记忆
 *    （sessions 偏好列 + 转录 model_change）原样留着，hydrate 仍会恢复出来。
 *    此时不自动改模型（避免运行中的会话被悄悄换掉），提示重新选择。
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

export function useModelGate(): ModelGate {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const selected = useThreadModel(threadId);
  const models = usePiModels();
  if (!selected) {
    return { usable: false, hint: "先选择模型，再发送消息", selected: null };
  }
  // 目录没加载出来时不做判定：网页预览恒空，远程/桌面首帧拉取也可能在途，
  // 模型真值在 sidecar 侧——不能拿一个空目录否决真实选择
  if (models.length === 0) {
    return { usable: true, hint: null, selected };
  }
  if (isModelSelectable(models, selected)) {
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
