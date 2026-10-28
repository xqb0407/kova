"use client";

import { useEffect } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { getPiModelsSnapshot, usePiModels } from "@/lib/pi/pi-models";
import { getThreadModelSnapshot, useThreadModel } from "@/lib/pi/pi-session-model";
import { imageSupportFromMetadata } from "@/lib/pi/pi-vision-warning";

/**
 * 「当前模型是纯文本输入」的 composer 图片附件硬闸（多模态降级闭环第③道防线）。
 *
 * 请求侧降级（pi-ai downgradeUnsupportedImages）与 sidecar 拒图修复只保证
 * 「带图会话不报废」；本闸按同一份目录元数据把图片挡在入口——纯文本模型
 * 干脆加不了图片，省掉注定被剥掉的上传与一轮「看不到图」的问答。与
 * pi-model-gate 同口径：目录为空（未加载/远程模式/web 预览）不判定，
 * input 字段缺失的模型不判定，模型不在目录（已删/停用）不判定——
 * 宁可漏放（请求侧会兜底）也不误禁。
 *
 * 元数据标错的模型在此表现为「加不了图片」；自救入口在 设置→模型 的
 * 输入能力勾选。两个消费面：
 * - 响应式（useImageSupportGate）：加号菜单图片项禁用、composer dropzone
 *   disabled；
 * - 同步（imageAttachmentBlockedReason）：validatePromptFile 内部调用——
 *   粘贴/文件选择/data URI 三类入口共用这一道，拒收文案即本提示。
 */

export const IMAGE_GATE_HINT =
  "当前模型不支持图片输入，已禁止添加图片附件（可在 设置→模型 修正该模型的输入能力）";

/** 目录里找当前选择（与 pi-model-gate / pi-vision-warning 同一过滤口径） */
function findCatalogModel(
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

/** 纯判定：元数据明确排除图像输入才 true；其余情形一律放行 */
export function imageGateBlocked(
  models: PiModelSummary[],
  selected: SelectedModel | null,
): boolean {
  if (!selected || models.length === 0) return false;
  return imageSupportFromMetadata(findCatalogModel(models, selected)) === false;
}

/* ---------------- 同步入口的当前线程登记 ----------------
 * validatePromptFile 是纯同步函数（粘贴/文件选择各入口共用），拿不到 React
 * 上下文的 mainThreadId；这里维护一个模块级登记，由 useImageSupportGate 的
 * effect 随线程切换刷新。不做 unmount 清理：composer 恒挂载（多消费者卸载
 * 时序不定），残留值只影响「组件树全卸载后仍调用 validatePromptFile」的
 * 不存在场景；线程切换由下一次 effect 覆盖。 */
let gateThreadId: string | undefined;

export function setImageGateThreadId(threadId: string | undefined): void {
  gateThreadId = threadId;
}

/** 同步判定（validatePromptFile 用）：命中返回拒收文案，否则 null。
 *  空目录/无选择时不判定，恒 null。 */
export function imageAttachmentBlockedReason(): string | null {
  const selected = getThreadModelSnapshot(gateThreadId ?? "");
  if (!selected) return null;
  return imageGateBlocked(getPiModelsSnapshot(), selected) ? IMAGE_GATE_HINT : null;
}

/** 响应式判定：加号菜单/dropzone 的禁用态与 tooltip 共用一份取值。
 *  副作用：随线程切换刷新同步入口的线程登记（见上）。 */
export function useImageSupportGate(): {
  canAttachImages: boolean;
  hint: string | null;
} {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const selected = useThreadModel(threadId);
  const models = usePiModels();
  const blocked = imageGateBlocked(models, selected);
  useEffect(() => {
    setImageGateThreadId(threadId);
  }, [threadId]);
  return { canAttachImages: !blocked, hint: blocked ? IMAGE_GATE_HINT : null };
}
